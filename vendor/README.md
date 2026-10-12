# Third-party code

| File | Origin | Version | License |
|---|---|---|---|
| `opencv.js` | [OpenCV](https://github.com/opencv/opencv/tree/4.14.0), custom build with SIFT and WebAssembly SIMD | 4.14.0 | Apache-2.0, see [`LICENSE-opencv.txt`](LICENSE-opencv.txt) |

The prebuilt versions (docs.opencv.org, npm `@techstark/opencv-js`) do not
export SIFT: the export list dates from when SIFT was patented. This build
adds one line to the export list, enables SIMD and leaves out the modules
the app does not use (dnn, objdetect, photo, video): 6.6 MB instead of 11.

Build (about 11 min on 4 cores, needs `podman` or `docker`):

```sh
git clone --depth 1 --branch 4.14.0 https://github.com/opencv/opencv.git
cd opencv
python3 - <<'PY'
p = 'modules/features2d/misc/js/gen_dict.json'
s = open(p).read()
a = '        "DescriptorMatcher":'
l = ('        "SIFT": ["create", "setNFeatures", "getNFeatures", "setNOctaveLayers", '
     '"getNOctaveLayers", "setContrastThreshold", "getContrastThreshold", '
     '"setEdgeThreshold", "getEdgeThreshold", "setSigma", "getSigma", "getDefaultName"],\n')
assert s.count(a) == 1
open(p, 'w').write(s.replace(a, l + a))
PY
cd ..
podman run --rm --userns=keep-id -v "$PWD":/work:Z -w /work/opencv \
  docker.io/emscripten/emsdk:6.0.12 \
  emcmake python3 ./platforms/js/build_js.py /work/build_simd --build_wasm --simd \
    --cmake_option=-DCMAKE_CXX_STANDARD=17 \
    --cmake_option=-DBUILD_opencv_dnn=OFF --cmake_option=-DBUILD_opencv_objdetect=OFF \
    --cmake_option=-DBUILD_opencv_photo=OFF --cmake_option=-DBUILD_opencv_video=OFF
cp build_simd/bin/opencv.js <project>/vendor/opencv.js
```

`require()` and `importScripts` give a Promise of the module (`cv.then`);
`worker.js` and `tools/eval.mjs` wait for it.

A build with threads (`--threads`) was measured on a Pixel 4a: no gain,
because the expensive matching runs in `core/knn.js`.

sha256 of the current build:
`010276dba9afde763890026a0fa19f9802454f48db617bba7585086bef3bf71f`

## core/knn.js

Brute-force nearest neighbours with WebAssembly SIMD, source `wasm/knn.c`,
embedded as base64:

```sh
podman run --rm --userns=keep-id -v "$PWD/wasm":/work:Z -w /work docker.io/emscripten/emsdk:6.0.12 \
  emcc -O3 -msimd128 knn.c -o knn.wasm --no-entry -s STANDALONE_WASM=1 -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=4MB -s STACK_SIZE=64KB -s EXPORTED_FUNCTIONS=_knn_hamming,_knn_l2u8,_heap_base
base64 -w0 wasm/knn.wasm   # into WASM in core/knn.js
```

Afterwards bump `VERSION` in `sw.js` and run `npm test`.
