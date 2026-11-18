'use strict';

/**
 * fdsFlix · torrent streamer (nó "Koyeb free")
 *
 * Roda `torrent-stream` (fala TCP/UDP com os peers) e serve o vídeo por HTTP com Range.
 * O navegador toca num <video> normal — funciona em QUALQUER navegador (sem WebRTC).
 *
 * Rotas:
 *   GET /ping                    -> "ok" (acordar o nó)
 *   GET /health                  -> { engines, uptime }
 *   GET /stream/<infoHash>?magnet=...  -> vídeo (Range/206)
 *
 * O fdsFlix manda o navegador para cá; o vídeo NÃO passa pelo Render.
 * Cache em /tmp (apagado ao reiniciar o container). Limite de motores simultâneos.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const torrentStream = require('torrent-stream');

const PORT = Number(process.env.PORT) || 8080;
const CACHE = process.env.CACHE_DIR || '/tmp/fdsflix-torrent';
const MAX_ENGINES = Number(process.env.MAX_ENGINES) || 4;
const IDLE_MS = Number(process.env.IDLE_MS) || 20 * 60 * 1000;

const engines = new Map(); // hash -> { engine, file, last }

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function pickVideo(engine) {
  const files = (engine.files || []).filter((f) => /\.(mp4|m4v|webm|mkv|avi|mov)$/i.test(f.name));
  return files.sort((a, b) => (b.length || 0) - (a.length || 0))[0] || null;
}

function engineFor(hash, magnet) {
  const key = hash.toLowerCase();
  const hit = engines.get(key);
  if (hit) { hit.last = Date.now(); return hit; }

  if (engines.size >= MAX_ENGINES) {
    let oldest = null;
    for (const [k, v] of engines) if (!oldest || v.last < oldest.last) oldest = { k, ...v };
    if (oldest) { try { oldest.engine.destroy(); } catch (e) {} engines.delete(oldest.k); }
  }

  const dir = path.join(CACHE, key);
  fs.mkdirSync(dir, { recursive: true });
  const engine = torrentStream(magnet || `magnet:?xt=urn:btih:${hash}`, { path: dir, connections: 80 });
  const entry = { engine, file: null, last: Date.now() };
  engines.set(key, entry);
  engine.on('ready', () => { entry.file = pickVideo(engine); });
  engine.on('error', () => {});
  return entry;
}

function stream(req, res, entry) {
  const start = () => {
    const file = entry.file || pickVideo(entry.engine);
    if (!file) { json(res, 404, { error: 'sem vídeo no torrent' }); return; }
    const total = file.length;
    const range = req.headers.range;
    let from = 0;
    let to = total - 1;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        if (m[1]) from = Number(m[1]);
        if (m[2]) to = Number(m[2]);
      }
    }
    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    };
    if (range) {
      res.writeHead(206, Object.assign(headers, {
        'Content-Range': `bytes ${from}-${to}/${total}`,
        'Content-Length': to - from + 1
      }));
    } else {
      res.writeHead(200, Object.assign(headers, { 'Content-Length': total }));
    }
    const stream = fs.createReadStream(file.path, { start: from, end: to });
    stream.on('error', () => { try { res.destroy(); } catch (e) {} });
    stream.pipe(res);
  };
  if (entry.file) return start();
  entry.engine.on('ready', start);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://nó');
  if (u.pathname === '/ping') { res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('ok'); return; }
  if (u.pathname === '/health') { json(res, 200, { engines: engines.size, uptime: process.uptime() }); return; }
  const m = u.pathname.match(/^\/stream\/([a-fA-F0-9]{40})$/);
  if (!m) { json(res, 404, { error: 'rota' }); return; }
  const magnet = u.searchParams.get('magnet') || '';
  stream(req, res, engineFor(m[1], magnet));
});

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of engines) {
    if (now - v.last > IDLE_MS) { try { v.engine.destroy(); } catch (e) {} engines.delete(k); }
  }
}, 60 * 1000).unref();

server.listen(PORT, () => console.log(`torrent streamer em :${PORT} (cache ${CACHE})`));
