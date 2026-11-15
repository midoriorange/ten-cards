import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Regenerate from the authoritative template and modules before publication.
await import('./standalone.mjs');

const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['index.html', '.nojekyll']) {
  await cp(new URL(name, root), new URL(name, output));
}
console.log(`Static website ready: ${fileURLToPath(output)}`);
