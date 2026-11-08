// Stamps a release version into the files CI publishes: VERSION in sw.js (the
// service worker's cache name, so installed apps refresh) and APP_VERSION in
// app.js (shown in the header). Versions are git tags; CI tags every tested
// commit on main with the next patch version and passes it here before the
// Pages deploy. Edits the working copy only; nothing is committed.
// node tools/stamp-version.mjs vX.Y.Z [ROOT]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [version, root = '.'] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`not a version tag: ${version}`);

const edit = (f, pattern, replacement) => {
  const path = join(root, f);
  const text = readFileSync(path, 'utf8');
  if (!pattern.test(text)) throw new Error(`${f}: version constant not found`);
  writeFileSync(path, text.replace(pattern, replacement));
};
edit('sw.js', /const VERSION = 'v[\d.]+';/, `const VERSION = '${version}';`);
edit('app.js', /const APP_VERSION = 'v[\d.]+';/, `const APP_VERSION = '${version}';`);
console.log(version);
