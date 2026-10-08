/**
 * The web build as the web container serves it, for the end-to-end tests: the
 * static app from client/dist, and /api — the live WebSocket included —
 * passed to a kraftverk server, so the app talks to it same-origin exactly as
 * it does in production. Node only; no dependencies.
 *
 *   E2E_WEB_PORT=4398 E2E_API_PORT=3398 node e2e/serve.mjs
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../client/dist');
const PORT = Number(process.env.E2E_WEB_PORT ?? 4398);
const API = Number(process.env.E2E_API_PORT ?? 3398);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.webp': 'image/webp', '.wasm': 'application/wasm', '.map': 'application/json' };

if (!existsSync(join(ROOT, 'index.html'))) {
  console.error(`No web build in ${ROOT}: run the app's build first (npm run test:e2e does).`);
  process.exit(1);
}

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api')) {
    const upstream = request({ host: '127.0.0.1', port: API, path: req.url, method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => (res.headersSent ? res.end() : res.writeHead(502).end('The kraftverk server is not answering')));
    req.pipe(upstream);
    return;
  }
  // A file of the build, or the app's shell for any route it draws itself.
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\])+/, '');
  let file = join(ROOT, path);
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) file = join(ROOT, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

// The live stream: the upgrade, passed through byte for byte.
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/api')) return socket.destroy();
  const upstream = connect(API, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`, ...Object.entries(req.headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${name}: ${v}`))];
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, '127.0.0.1', () => console.log(`e2e: the app on http://127.0.0.1:${PORT}, its API on :${API}`));
