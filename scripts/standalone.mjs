import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { APP_VERSION } from '../src/version.js';

const root = new URL('../', import.meta.url);
const packageInfo = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
assert.equal(APP_VERSION, packageInfo.version, 'The app and package release versions must match.');
const css = await readFile(new URL('styles.css', root), 'utf8');
const icon = await readFile(new URL('favicon.svg', root));
const modules = ['version', 'game', 'view', 'session', 'invite', 'config', 'app'];
const sources = [];
for (const name of modules) {
  let code = await readFile(new URL(`src/${name}.js`, root), 'utf8');
  const exports = [...code.matchAll(/^export (?:function|const) (\w+)/gm)].map(match => match[1]);
  // Keep each module's private names in its own scope, as ES modules do.
  code = code.replace(/^import \{([^\r\n]*)\} from ['"]\.\/?([\w-]+)\.js['"];\r?\n/gm,
    (_, names, dependency) => `const {${names}} = __packsModules[${JSON.stringify(dependency)}];\n`);
  code = code.replace(/^export (?=(?:const|function)\b)/gm, '');
  sources.push(`// src/${name}.js\n__packsModules[${JSON.stringify(name)}] = (() => {\n${code}\nreturn {${exports.join(',')}};\n})();`);
}
const bundle = `(() => {\n'use strict';\nconst __packsModules = Object.create(null);\n${sources.join('\n\n')}\n})();`;
// Validate before replacing either user-facing edition.
new vm.Script(bundle, { filename: 'Ten Cards inline application' });
let html = await readFile(new URL('src/page.html', root), 'utf8');
function replaceOnce(needle, replacement) {
  assert.equal(html.split(needle).length - 1, 1, `Expected one template marker: ${needle}`);
  html = html.replace(needle, () => replacement);
}
replaceOnce('<link rel="stylesheet" href="./styles.css">', `<style>\n${css}\n</style>`);
replaceOnce('href="./favicon.svg"', `href="data:image/svg+xml;base64,${icon.toString('base64')}"`);
replaceOnce('  <script type="module" src="./src/app.js"></script>\n', '');
replaceOnce('</head>', `  <meta name="application-version" content="${APP_VERSION}">\n</head>`);
replaceOnce('</body>', `<script>\n${bundle.replace(/<\/script/gi, '<\\/script')}\n</script>\n</body>`);
await writeFile(new URL('index.html', root), html);
await writeFile(new URL('START_HERE.html', root), html);
console.log(`Created index.html and START_HERE.html — self-contained Packs v${APP_VERSION}.`);
