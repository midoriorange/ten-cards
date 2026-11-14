import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const css = await readFile(new URL('styles.css', root), 'utf8');
const icon = await readFile(new URL('favicon.svg', root));
const modules = ['game', 'session', 'invite', 'config', 'app'];
const sources = [];
for (const name of modules) {
  let code = await readFile(new URL(`src/${name}.js`, root), 'utf8');
  // These source modules use only named exports and relative named imports.
  code = code.replace(/^import .*? from ['"].*?['"];\r?\n/gm, '');
  code = code.replace(/^export (?=(?:const|function)\b)/gm, '');
  sources.push(code);
}
const bundle = `(() => {\n'use strict';\n${sources.join('\n\n')}\n})();`;
// Check the assembled script before writing the double-click edition.
new vm.Script(bundle, { filename: 'START_HERE.html inline script' });
let html = await readFile(new URL('index.html', root), 'utf8');
html = html.replace('<link rel="stylesheet" href="./styles.css">', () => `<style>\n${css}\n</style>`);
html = html.replace('href="./favicon.svg"', `href="data:image/svg+xml;base64,${icon.toString('base64')}"`);
html = html.replace('  <script type="module" src="./src/app.js"></script>\n', '');
html = html.replace('</body>', () => `<script>\n${bundle.replace(/<\/script/gi, '<\\/script')}\n</script>\n</body>`);
await writeFile(new URL('START_HERE.html', root), html);
console.log('Created START_HERE.html — double-click to try local practice without a server.');
