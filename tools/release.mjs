// Next patch release: raises the patch version in sw.js, app.js and
// package.json, and names the changelog's "Unreleased" section after it.
// Run by CI on every successful merge on main; prints the new version.
// node tools/release.mjs [ROOT] [DATE]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? '.';
const date = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const path = (f) => join(root, f);
const edit = (f, fn) => writeFileSync(path(f), fn(readFileSync(path(f), 'utf8')));

const m = readFileSync(path('sw.js'), 'utf8').match(/const VERSION = 'v(\d+)\.(\d+)\.(\d+)';/);
if (!m) throw new Error('sw.js: no semantic VERSION');
const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;

edit('sw.js', (s) => s.replace(/const VERSION = 'v[\d.]+';/, `const VERSION = 'v${next}';`));
edit('app.js', (s) => s.replace(/const APP_VERSION = 'v[\d.]+';/, `const APP_VERSION = 'v${next}';`));
for (const f of ['package.json', 'package-lock.json']) {
  edit(f, (s) => {
    const j = JSON.parse(s);
    j.version = next;
    if (j.packages?.['']) j.packages[''].version = next;
    return `${JSON.stringify(j, null, 2)}\n`;
  });
}
// An empty "Unreleased" section (e.g. a dependency update) stays for the next one.
edit('CHANGELOG.md', (s) =>
  /^## Unreleased\n\s*\n- /m.test(s) ? s.replace(/^## Unreleased$/m, `## ${next} – ${date}`) : s,
);
console.log(next);
