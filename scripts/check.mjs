import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { APP_VERSION } from '../src/version.js';

const root = new URL('../', import.meta.url);
await import('./standalone.mjs');
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
// Keep source wiring checks tied to the template, rather than the generated page.
const template = await readFile(new URL('src/page.html', root), 'utf8');
const ids = [...template.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
const app = await readFile(new URL('src/app.js', root), 'utf8');
for (const match of app.matchAll(/\$\(['"]([^'"]+)['"]\)/g)) {
  assert(ids.includes(match[1]), `Missing page element: ${match[1]}`);
}
for (const match of template.matchAll(/\b(?:src|href)="(\.\/[^"#]+)"/g)) {
  // Template asset URLs are written relative to the published project root.
  await stat(new URL(match[1], root));
}
const html = await readFile(new URL('index.html', root), 'utf8');
const standalone = await readFile(new URL('START_HERE.html', root), 'utf8');
assert.equal(html, standalone, 'The published and double-click pages must match.');
assert(/<style>\s*\S[\s\S]*?<\/style>/i.test(html), 'Production HTML must include its styles.');
assert(!/<script\b[^>]*\b(?:src|type)\s*=/i.test(html), 'Production application must be an inline classic script.');
assert(!/<link\b[^>]*\brel\s*=\s*['"]stylesheet['"]/i.test(html), 'Production HTML must not depend on a separate stylesheet.');
for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
  assert(match[1] === './' || match[1].startsWith('data:'),
    `Production HTML has an external or local asset reference: ${match[1]}`);
}
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
assert.equal(scripts.length, 1, 'Production HTML must contain one bundled application.');
new vm.Script(scripts[0][1], { filename: 'index.html inline application' });
assert(/function getPlayerView\(state, role\)/.test(scripts[0][1]),
  'The production bundle must include the private player view projection.');
assert(/getPlayerView\(state, role\)/.test(scripts[0][1]),
  'The application must render through the private player view projection.');
const packageInfo = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
assert.equal(APP_VERSION, packageInfo.version, 'The app and package versions must match.');
assert(html.includes(`<meta name="application-version" content="${APP_VERSION}">`),
  'The generated page must identify the current release.');
assert(html.includes(`const APP_VERSION = '${APP_VERSION}';`),
  'The generated application must carry the current release.');
console.log('Source syntax, module paths, template wiring, self-contained pages, card visibility, and release versions checked.');
