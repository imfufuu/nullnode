#!/usr/bin/env node
/**
 * Single-origin preview: serves index.html and proxies /relay/* to a locally
 * running `wrangler dev`, including the WebSocket upgrade. That makes relay mode
 * testable in a browser without deploying anything or fighting CORS.
 *
 *   ./scripts/dev.sh                 # spawns this + wrangler
 *   node scripts/preview-server.mjs  # or on its own, with a relay already running
 *
 * Env: PORT (8080) · RELAY (http://127.0.0.1:8787)
 * The served HTML is rewritten in flight so the relay url matches whatever host
 * the browser used — nothing on disk is modified.
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const RELAY = new URL(process.env.RELAY || 'http://127.0.0.1:8787');
const relayHost = RELAY.hostname;
const relayPort = Number(RELAY.port || 80);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function proxy(req, res, body) {
  const upstream = http.request(
    { hostname: relayHost, port: relayPort, path: req.url.replace(/^\/relay/, ''), method: req.method, headers: { ...req.headers, host: RELAY.host } },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'relay offline', detail: err.message }));
  });
  if (body && body.length) upstream.write(body);
  upstream.end();
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/relay')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => proxy(req, res, Buffer.concat(chunks)));
    return;
  }

  let file = req.url.split('?')[0];
  if (file === '/' || file === '') file = '/index.html';
  const abs = path.join(ROOT, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  let data = fs.readFileSync(abs);
  const ext = path.extname(abs);
  if (ext === '.html') {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const relayUrl = `${proto}://${req.headers.host}/relay`;
    data = Buffer.from(
      data.toString('utf8').replace(
        '<meta name="nullnode-relay" content="">',
        `<meta name="nullnode-relay" content="${relayUrl}">`
      )
    );
  }
  res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(data);
});

/* websocket upgrade → raw TCP tunnel to wrangler */
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/relay')) return socket.destroy();
  const up = net.connect(relayPort, relayHost, () => {
    const path = req.url.replace(/^\/relay/, '');
    const headers = Object.entries(req.headers)
      .filter(([k]) => k.toLowerCase() !== 'host')
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    up.write(`${req.method} ${path} HTTP/1.1\r\nhost: ${RELAY.host}\r\n${headers}\r\n\r\n`);
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`nullnode preview  →  http://localhost:${PORT}/`);
  console.log(`relay proxy       →  ${RELAY.origin}  (/relay/*)`);
});
