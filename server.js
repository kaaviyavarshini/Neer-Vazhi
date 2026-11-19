/**
 * server.js
 * Zero-dependency local development server for Neer Vazhi (ESM).
 * Serves static assets from the /web directory with proper MIME types and CORS headers.
 * Supports fallback ports if 8765 is already occupied.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEB_ROOT = path.join(__dirname, 'web');
const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 8765;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.tif':  'image/tiff',
  '.tiff': 'image/tiff',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
};

function startServer(port) {
  const server = http.createServer((req, res) => {
    // Enable CORS for local modules and workers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url);
    let pathname = decodeURIComponent(parsedUrl.pathname);

    // Root redirects to google3d.html
    if (pathname === '/' || pathname === '') {
      pathname = '/google3d.html';
    }

    // Redirect any accidental Cesium asset/worker requests to CDN
    if (pathname.startsWith('/Assets/') || pathname.startsWith('/Widgets/') || pathname.startsWith('/Workers/')) {
      res.writeHead(302, { 'Location': `https://cdn.jsdelivr.net/npm/cesium@1.117.0/Build/Cesium${pathname}` });
      res.end();
      return;
    }

    const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(WEB_ROOT, safePath);

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        console.warn(`[404] ${req.method} ${pathname}`);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`404 Not Found: ${pathname}`);
        return;
      }

      console.log(`[200] ${req.method} ${pathname}`);

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stats.size,
        'Cache-Control': 'no-cache',
      });

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      stream.on('error', (streamErr) => {
        console.error('Stream error:', streamErr);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} in use, trying port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });

  server.listen(port, () => {
    console.log(`\n============================================================`);
    console.log(`🌊 Neer Vazhi (நீர் வழி) — OMR Floods Visualiser`);
    console.log(`============================================================`);
    console.log(`  > Google 3D Scene: http://localhost:${port}/google3d.html`);
    console.log(`  > Three.js Scene:  http://localhost:${port}/story.html`);
    console.log(`  > Root Entry:      http://localhost:${port}/`);
    console.log(`============================================================\n`);
  });
}

startServer(DEFAULT_PORT);
