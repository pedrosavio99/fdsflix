'use strict';

/**
 * fdsFlix · torrent streamer (nó SnapDeploy / qualquer Docker)
 *
 * Roda `torrent-stream` (fala TCP/UDP com os peers) e serve o vídeo por HTTP com Range.
 * O navegador toca num <video> normal — funciona em QUALQUER navegador (sem WebRTC).
 *
 * Rotas:
 *   GET /ping                          -> "ok" (acordar o nó)
 *   GET /health                        -> { engines, uptime }
 *   GET /diag                          -> o que a rede deste nó consegue (DNS, TCP, UDP)
 *   GET /prepare/<infoHash>?magnet=... -> espera os metadados e devolve JSON (sempre HTTP 200):
 *                                         { ready, name, size, wires, remux, reason }
 *   GET /stream/<infoHash>?magnet=...  -> vídeo (Range/206)
 *
 * O fdsFlix manda o navegador para cá; o vídeo NÃO passa pelo Render.
 * Cache em /tmp (apagado ao reiniciar o container). Limite de motores simultâneos.
 *
 * Por que /prepare existe: a plataforma troca qualquer 5xx por uma página HTML e o <video> só
 * diz "Format error". Com /prepare o front lê o motivo real (sem peers, sem vídeo…) antes de tocar.
 */

const http = require('http');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const torrentStream = require('torrent-stream');

const PORT = Number(process.env.PORT) || 8080;
const CACHE = process.env.CACHE_DIR || '/tmp/fdsflix-torrent';
const MAX_ENGINES = Number(process.env.MAX_ENGINES) || 4;
const IDLE_MS = Number(process.env.IDLE_MS) || 20 * 60 * 1000;
const META_WAIT_MS = Number(process.env.META_WAIT_MS) || 45 * 1000; // /prepare
const STREAM_WAIT_MS = Number(process.env.STREAM_WAIT_MS) || 25 * 1000; // /stream sem /prepare
const USE_DHT = process.env.DHT !== '0';

// Trackers HTTP(S) (TCP) somados ao magnet: se a plataforma bloquear UDP, os UDP e o DHT não
// acham ninguém, mas estes ainda respondem. Os UDP continuam valendo quando UDP funciona.
const EXTRA_TRACKERS = [
  'http://tracker.opentrackr.org:1337/announce',
  'https://tracker.tamersunion.org:443/announce',
  'https://tracker.gbitt.info:443/announce',
  'http://tracker.bt4g.com:2095/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce'
];

const engines = new Map(); // hash -> { engine, file, ready, last, err }

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function pickVideo(engine) {
  const files = (engine.files || []).filter((f) => /\.(mp4|m4v|webm|mkv|avi|mov)$/i.test(f.name));
  return files.sort((a, b) => (b.length || 0) - (a.length || 0))[0] || null;
}

const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
function extOf(name) { return String(name || '').split('.').pop().toLowerCase(); }
// O Chrome só abre mp4/m4v/webm (e mov quando é H.264). mkv/avi passam por ffmpeg e saem MP4.
function needsRemux(name) { return /^(mkv|avi)$/.test(extOf(name)); }

function buildMagnet(hash, magnet) {
  let m = String(magnet || '');
  if (!/^magnet:\?/i.test(m)) m = `magnet:?xt=urn:btih:${hash}`;
  for (const t of EXTRA_TRACKERS) {
    if (!m.includes(encodeURIComponent(t)) && !m.includes(t)) m += '&tr=' + encodeURIComponent(t);
  }
  return m;
}

function wiresOf(engine) {
  return engine && engine.swarm && engine.swarm.wires ? engine.swarm.wires.length : 0;
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
  const engine = torrentStream(buildMagnet(hash, magnet), {
    path: dir,
    tmp: path.join(CACHE, '_meta'),
    connections: 80,
    dht: USE_DHT
  });
  const entry = { engine, file: null, ready: false, last: Date.now(), err: '', t0: Date.now() };
  engines.set(key, entry);
  engine.on('ready', () => {
    entry.ready = true;
    entry.file = pickVideo(engine);
    log('ready', key.slice(0, 8), `${((Date.now() - entry.t0) / 1000).toFixed(1)}s`, entry.file ? entry.file.name : 'SEM VÍDEO');
  });
  engine.on('error', (e) => { entry.err = String((e && e.message) || e); log('erro', key.slice(0, 8), entry.err); });
  log('novo', key.slice(0, 8), USE_DHT ? 'dht on' : 'dht off');
  return entry;
}

// Resolve true quando os metadados chegaram, false se estourar o tempo.
function whenReady(entry, ms) {
  if (entry.ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); entry.engine.removeListener('ready', onReady); resolve(v); };
    const onReady = () => done(true);
    const t = setTimeout(() => done(false), ms);
    entry.engine.on('ready', onReady);
  });
}

function whyNot(entry) {
  if (entry.err) return `erro do torrent: ${entry.err}`;
  if (!entry.ready) {
    return wiresOf(entry.engine) === 0
      ? 'sem peers: o nó não conseguiu falar com ninguém (rede bloqueando UDP/DHT?). Abra /diag no nó.'
      : 'achou peers mas os metadados ainda não chegaram; tente de novo em instantes.';
  }
  if (!entry.file) return 'o torrent não tem arquivo de vídeo (mp4/mkv/webm/avi/mov).';
  return '';
}

async function prepare(res, entry) {
  const ok = await whenReady(entry, META_WAIT_MS);
  const file = ok ? entry.file : null;
  json(res, 200, {
    ready: !!file,
    name: file ? file.name : null,
    size: file ? file.length : 0,
    remux: file ? needsRemux(file.name) : false,
    wires: wiresOf(entry.engine),
    waitedMs: Date.now() - entry.t0,
    reason: file ? '' : whyNot(entry)
  });
}

function stream(req, res, entry) {
  whenReady(entry, STREAM_WAIT_MS).then((ok) => {
    const file = ok ? entry.file : null;
    if (!file) { json(res, ok ? 404 : 504, { error: whyNot(entry) }); return; }
    try { file.select(); } catch (e) { /* ignore */ }
    // Enquanto a resposta estiver aberta o motor conta como "em uso" (um mkv é UMA requisição de horas).
    const keep = setInterval(() => { entry.last = Date.now(); }, 30 * 1000);
    res.on('close', () => clearInterval(keep));
    const total = file.length;
    const remux = needsRemux(file.name);

    if (remux) {
      // mkv/avi -> MP4 fragmentado. O tamanho da saída é desconhecido: sem Content-Length e sem Range
      // (o navegador toca do começo, como um stream). Vídeo é copiado; o áudio vira AAC porque o
      // Chrome não toca AC3/DTS (comuns em mkv).
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      const src = file.createReadStream();
      const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-map', '0:v:0', '-map', '0:a:0?', '-sn',
        '-c:v', 'copy',
        '-c:a', 'aac', '-ac', '2', '-b:a', '160k',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4', 'pipe:1'
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      ff.stderr.on('data', (d) => log('ffmpeg:', String(d).trim().slice(0, 200)));
      ff.stdin.on('error', () => {});
      src.on('error', () => { try { ff.kill('SIGKILL'); } catch (e) { /* ignore */ } });
      src.pipe(ff.stdin);
      ff.stdout.pipe(res);
      const stop = () => {
        try { ff.kill('SIGKILL'); } catch (e) { /* ignore */ }
        try { src.destroy(); } catch (e) { /* ignore */ }
      };
      res.on('close', stop);
      ff.on('close', () => { try { res.end(); } catch (e) { /* ignore */ } });
      return;
    }

    const range = req.headers.range;
    let from = 0;
    let to = total - 1;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        if (m[1] !== '') { from = Number(m[1]); if (m[2] !== '') to = Number(m[2]); }
        else if (m[2] !== '') { from = Math.max(0, total - Number(m[2])); } // "bytes=-N" = últimos N
      }
      to = Math.min(to, total - 1);
      if (!(from <= to) || from >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }
    }
    const headers = {
      'Content-Type': MIME[extOf(file.name)] || 'video/mp4',
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
    // file.createReadStream ESPERA as peças serem baixadas e prioriza esse trecho. Ler file.path direto
    // (fs.createReadStream) lê zeros/EOF de peças que ainda não chegaram e corta o vídeo no meio.
    const src = file.createReadStream({ start: from, end: to });
    src.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
    res.on('close', () => { try { src.destroy(); } catch (e) { /* ignore */ } });
    src.pipe(res);
  });
}

/* ------------------------------- /diag ------------------------------- */

function dnsTest(host) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    dns.lookup(host, (err, addr) => resolve(err ? { ok: false, error: err.code } : { ok: true, addr, ms: Date.now() - t0 }));
  });
}

function tcpTest(host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port, timeout: 6000 });
    s.on('connect', () => { s.destroy(); resolve({ ok: true, ms: Date.now() - t0 }); });
    s.on('timeout', () => { s.destroy(); resolve({ ok: false, error: 'timeout' }); });
    s.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
  });
}

// Pacote "connect" do protocolo de tracker UDP (BEP 15): se vier resposta, UDP de saída funciona.
function udpTest(host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = dgram.createSocket('udp4');
    const done = (r) => { try { sock.close(); } catch (e) { /* ignore */ } resolve(r); };
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(0x417, 0); buf.writeUInt32BE(0x27101980, 4); // protocol id
    buf.writeUInt32BE(0, 8); // action = connect
    buf.writeUInt32BE(0x1234abcd, 12); // transaction id
    sock.on('message', (m) => done(m.length >= 16 ? { ok: true, ms: Date.now() - t0 } : { ok: false, error: 'resposta curta' }));
    sock.on('error', (e) => done({ ok: false, error: e.code || e.message }));
    setTimeout(() => done({ ok: false, error: 'sem resposta em 6 s (UDP de saída bloqueado?)' }), 6000);
    sock.send(buf, port, host, (e) => { if (e) done({ ok: false, error: e.code || e.message }); });
  });
}

async function diag() {
  const [dnsR, tcpHttp, tcpPeer, udp1, udp2] = await Promise.all([
    dnsTest('tracker.opentrackr.org'),
    tcpTest('tracker.opentrackr.org', 1337),
    tcpTest('router.bittorrent.com', 6881),
    udpTest('tracker.opentrackr.org', 1337),
    udpTest('open.stealth.si', 80)
  ]);
  const list = [];
  for (const [hash, e] of engines) list.push({ hash, ready: e.ready, wires: wiresOf(e.engine), err: e.err || undefined });
  return {
    node: process.version,
    dht: USE_DHT,
    dns: dnsR,
    tcp_tracker_1337: tcpHttp,
    tcp_dht_router_6881: tcpPeer,
    udp_tracker_opentrackr: udp1,
    udp_tracker_stealth: udp2,
    veredito: udp1.ok || udp2.ok
      ? 'UDP funciona: trackers UDP e DHT devem achar peers.'
      : (tcpHttp.ok ? 'UDP bloqueado, TCP livre: só os trackers HTTP (TCP) valem. O streamer já os usa.' : 'sem saída de rede útil para torrent.'),
    engines: list
  };
}

/* ------------------------------- servidor ------------------------------- */

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://nó');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'range', 'Access-Control-Max-Age': '600' });
    res.end();
    return;
  }
  if (u.pathname === '/ping') { res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('ok'); return; }
  if (u.pathname === '/diag') { diag().then((d) => json(res, 200, d)).catch((e) => json(res, 500, { error: String(e) })); return; }
  if (u.pathname === '/health') {
    const list = [];
    for (const [hash, e] of engines) {
      list.push({
        hash,
        ready: e.ready,
        name: e.file && e.file.name,
        files: (e.engine.files || []).length,
        wires: wiresOf(e.engine),
        downloaded: e.engine.swarm ? e.engine.swarm.downloaded : 0,
        err: e.err || undefined
      });
    }
    json(res, 200, { engines: list, uptime: process.uptime() });
    return;
  }
  const m = u.pathname.match(/^\/(stream|prepare)\/([a-fA-F0-9]{40})$/);
  if (!m) { json(res, 404, { error: 'rota' }); return; }
  const entry = engineFor(m[2], u.searchParams.get('magnet') || '');
  if (m[1] === 'prepare') prepare(res, entry);
  else stream(req, res, entry);
});

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of engines) {
    if (now - v.last > IDLE_MS) { try { v.engine.destroy(); } catch (e) {} engines.delete(k); }
  }
}, 60 * 1000).unref();

server.listen(PORT, () => log(`torrent streamer em :${PORT} (cache ${CACHE}, dht ${USE_DHT ? 'on' : 'off'})`));
