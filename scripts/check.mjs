import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
for (const dir of ['src', 'tests', 'scripts']) {
  for (const name of await readdir(new URL(dir + '/', root))) {
    if (!/\.(js|mjs)$/.test(name)) continue;
    const url = new URL(`${dir}/${name}`, root);
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(url)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || `Invalid JavaScript in ${dir}/${name}`);
    if (dir === 'src') {
      const code = await readFile(url, 'utf8');
      for (const match of code.matchAll(/\bfrom\s+['"](\.\.?\/[^'"]+)['"]/g)) {
        await stat(new URL(match[1], url));
      }
    }
  }
}
const html = await readFile(new URL('index.html', root), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
const app = await readFile(new URL('src/app.js', root), 'utf8');
for (const match of app.matchAll(/\$\(['"]([^'"]+)['"]\)/g)) {
  assert(ids.includes(match[1]), `Missing page element: ${match[1]}`);
}
for (const match of html.matchAll(/\b(?:src|href)="(\.\/[^"#]+)"/g)) await stat(new URL(match[1], root));
assert(!html.includes('http://'), 'Production HTML must not load insecure assets');
console.log('JavaScript syntax, module paths, page assets, and UI element wiring checked.');
