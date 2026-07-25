'use strict';

/** Zero-dependency static server for web/. `npm run sim`. */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT) || 4173;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const rel = url === '/' ? 'index.html' : decodeURIComponent(url).replace(/^\/+/, '');
    const file = path.join(ROOT, rel);

    // Keep the server inside web/.
    if (!file.startsWith(ROOT)) {
        res.writeHead(403).end('Forbidden');
        return;
    }

    fs.readFile(file, (err, buf) => {
        if (err) {
            res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found\n');
            return;
        }
        res.writeHead(200, {
            'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
            'cache-control': 'no-store',
        });
        res.end(buf);
    });
}).listen(PORT, () => {
    console.log(`\n  Simulator running at http://localhost:${PORT}\n`);
});
