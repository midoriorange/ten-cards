import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

const server = http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const segments = pathname.split(/[\\/]/);
    if (segments.some(part => part.startsWith('.'))) throw new Error('Invalid path');
    let target = resolve(root, '.' + pathname);
    if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) throw new Error('Invalid path');
    if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
    const bytes = await readFile(target);
    response.writeHead(200, {
      'Content-Type': types[extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Ten Cards: http://localhost:${port}`);
  console.log('Open this address in your browser. Press Ctrl+C to stop.');
});
