# Third-party code

| File | Origin | Version | License |
|---|---|---|---|
| `opencv.js` | [OpenCV](https://github.com/opencv/opencv/tree/4.12.0), custom build with SIFT | 4.12.0 | Apache-2.0, see [`LICENSE-opencv.txt`](LICENSE-opencv.txt) |

The prebuilt versions (docs.opencv.org, npm `@techstark/opencv-js`) do not
export SIFT: the export list dates from when SIFT was patented. This build
is the standard build with one more line in the export list.

Build (about 25 min on 4 cores, needs `podman` or `docker`):

```sh
git clone --depth 1 --branch 4.12.0 https://github.com/opencv/opencv.git
cd opencv
python3 - <<'EOF'
p = 'modules/features2d/misc/js/gen_dict.json'
s = open(p).read()
a = '        "DescriptorMatcher":'
l = ('        "SIFT": ["create", "setNFeatures", "getNFeatures", "setNOctaveLayers", '
     '"getNOctaveLayers", "setContrastThreshold", "getContrastThreshold", '
     '"setEdgeThreshold", "getEdgeThreshold", "setSigma", "getSigma", "getDefaultName"],\n')
assert s.count(a) == 1
open(p, 'w').write(s.replace(a, l + a))
EOF
cd ..
podman run --rm --userns=keep-id -v "$PWD":/work:Z -w /work/opencv \
  docker.io/emscripten/emsdk:1.39.15 \
  emcmake python3 ./platforms/js/build_js.py /work/build_wasm --build_wasm
cp build_wasm/bin/opencv.js <project>/vendor/opencv.js
```

emsdk 1.39.15 is deliberate: from 1.39.16 on, `require()` returns a Promise
instead of the `cv` object, and the loaders in `worker.js` and
`tools/eval.mjs` would wait forever.

sha256 of the current build:
`f23e501dc20702c1c19d8a15792e5f3099dd5602f2be8a4409b059398c68a042`

Afterwards bump `VERSION` in `sw.js` and run `npm test`.
