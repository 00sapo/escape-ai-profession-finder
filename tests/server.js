/* Static file server for the UI tests. Serves web/ on port 4173. */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(path.dirname(HERE), 'web');
const PORT = Number(process.env.PORT || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gz': 'application/gzip',
  '.svg': 'image/svg+xml'
};

http
  .createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = path.join(ROOT, relative);
    if (!target.startsWith(ROOT)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(target, (error, data) => {
      if (error) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, {
        'content-type': TYPES[path.extname(target)] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      response.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);
  });
