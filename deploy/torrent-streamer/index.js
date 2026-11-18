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
const Tracker = require('bittorrent-tracker');

const PORT = Number(process.env.PORT) || 8080;
const CACHE = process.env.CACHE_DIR || '/tmp/fdsflix-torrent';
const MAX_ENGINES = Number(process.env.MAX_ENGINES) || 4;
const IDLE_MS = Number(process.env.IDLE_MS) || 20 * 60 * 1000;
const META_WAIT_MS = Number(process.env.META_WAIT_MS) || 45 * 1000; // /prepare
const STREAM_WAIT_MS = Number(process.env.STREAM_WAIT_MS) || 25 * 1000; // /stream sem /prepare
// TCP_ONLY=1 simula plataforma sem UDP (só para teste local): sem DHT e sem trackers UDP.
const TCP_ONLY = process.env.TCP_ONLY === '1';
// ---- Medidor de consumo deste nó (reportado ao fdsFlix; ver lib/torrentNodes.js no servidor) ----
// Mesma imagem (.tar) em todas as contas: a config vem de node.config.json (no zip do painel) ou de variáveis.
//   FDSFLIX_URL  endereço do fdsFlix (Render)      NODE_KEY   chave dos nós
//   NODE_URL     URL pública DESTE nó (opcional: sai do Host da 1ª requisição)   NODE_NAME  apelido (opcional)
//   UPLOAD_SLOTS quantos peers recebem upload (padrão 3; o upload também gasta banda de saída)
//   REPORT_MS    intervalo do relatório (padrão 120000)
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'node.config.json'), 'utf8')) || {}; } catch (e) { /* sem arquivo: só variáveis */ }
const FDSFLIX_URL = String(process.env.FDSFLIX_URL || fileCfg.fdsflixUrl || '').trim().replace(/\/+$/, '');
const NODE_KEY = String(process.env.NODE_KEY || fileCfg.nodeKey || '').trim();
const NODE_NAME = String(process.env.NODE_NAME || fileCfg.name || '').trim();
const REPORT_MS = Math.max(15000, Number(process.env.REPORT_MS) || 120000);
const UPLOAD_SLOTS = process.env.UPLOAD_SLOTS === undefined ? 3 : Math.max(0, Number(process.env.UPLOAD_SLOTS) || 0);
let nodeUrl = String(process.env.NODE_URL || fileCfg.nodeUrl || '').trim().replace(/\/+$/, '');

const meter = {
  since: Date.now(),
  http: 0,      // bytes de vídeo enviados ao navegador
  up: 0,        // bytes enviados aos peers (upload do torrent)
  down: 0,      // bytes baixados dos peers
  streams: 0,   // vídeos abertos
  lastTick: Date.now(),
  total: { egress: 0, ingress: 0, awake: 0, streams: 0 }, // desde que o processo subiu
  pend: { egress: 0, ingress: 0, awake: 0, streams: 0 },  // ainda não aceito pelo fdsFlix
  reports: { ok: 0, fail: 0, lastOkAt: null, lastError: '', lastTryAt: null }
};

const USE_DHT = process.env.DHT !== '0' && !TCP_ONLY;
const HEAD_BYTES = Number(process.env.HEAD_BYTES) || 6 * 1024 * 1024; // começo do vídeo, baixado antes de liberar
const MAX_TAIL = 24 * 1024 * 1024; // teto do trecho final (moov) que aquecemos

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

// Só trackers por TCP (HTTP/HTTPS): são os que funcionam quando a plataforma bloqueia UDP.
const HTTP_TRACKERS = EXTRA_TRACKERS.filter((t) => /^https?:/i.test(t));

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
  if (TCP_ONLY) m = m.replace(/&tr=udp[^&]*/gi, '');
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
    if (oldest) { sample(oldest); try { oldest.engine.destroy(); } catch (e) {} engines.delete(oldest.k); }
  }

  const dir = path.join(CACHE, key);
  fs.mkdirSync(dir, { recursive: true });
  const engine = torrentStream(buildMagnet(hash, magnet), {
    path: dir,
    tmp: path.join(CACHE, '_meta'),
    connections: 80,
    uploads: UPLOAD_SLOTS,
    dht: USE_DHT
  });
  const entry = { engine, hash: key, file: null, ready: false, last: Date.now(), err: '', t0: Date.now(), warm: null, seenUp: 0, seenDown: 0, lastStreamAt: 0 };
  engines.set(key, entry);
  engine.on('ready', () => {
    entry.ready = true;
    entry.file = pickVideo(engine);
    log('ready', key.slice(0, 8), `${((Date.now() - entry.t0) / 1000).toFixed(1)}s`, entry.file ? entry.file.name : 'SEM VÍDEO');
    if (entry.file) startWarm(entry);
  });
  engine.on('error', (e) => { entry.err = String((e && e.message) || e); log('erro', key.slice(0, 8), entry.err); });
  log('novo', key.slice(0, 8), USE_DHT ? 'dht on' : 'dht off');
  // Sem UDP/DHT só o tracker HTTP entrega peers, e o do próprio torrent-stream pede poucos. Pedimos
  // muitos, de vários trackers, e repetimos enquanto há poucos peers conectados.
  [0, 8000, 20000, 45000, 90000].forEach((ms) => {
    const t = setTimeout(() => { if (engines.get(key) === entry && wiresOf(engine) < 40) harvestPeers(entry); }, ms);
    t.unref();
  });
  return entry;
}

/** Soma ao medidor o que o swarm deste torrent moveu desde a última amostra. */
function sample(entry) {
  try {
    const sw = entry.engine.swarm;
    if (!sw) return;
    const up = Math.max(0, (sw.uploaded || 0) - entry.seenUp);
    const down = Math.max(0, (sw.downloaded || 0) - entry.seenDown);
    entry.seenUp = sw.uploaded || 0;
    entry.seenDown = sw.downloaded || 0;
    meter.up += up;
    meter.down += down;
  } catch (e) { /* ignore */ }
}

/** Fecha o período: devolve o que mudou desde o último fechamento e acumula nos totais. */
function drainMeter() {
  for (const e of engines.values()) sample(e);
  const now = Date.now();
  const awake = Math.max(0, Math.round((now - meter.lastTick) / 1000));
  meter.lastTick = now;
  const d = { egress: meter.http + meter.up, ingress: meter.down, awake, streams: meter.streams };
  meter.http = 0; meter.up = 0; meter.down = 0; meter.streams = 0;
  for (const k of Object.keys(d)) { meter.total[k] += d[k]; meter.pend[k] += d[k]; }
  return d;
}

function reportNow(timeoutMs) {
  drainMeter();
  if (!FDSFLIX_URL || !NODE_KEY) { meter.reports.lastError = 'sem FDSFLIX_URL/NODE_KEY (não reporta)'; return Promise.resolve(false); }
  if (!nodeUrl) { meter.reports.lastError = 'URL do nó ainda desconhecida (aguardando a 1ª requisição)'; return Promise.resolve(false); }
  const p = meter.pend;
  const sent = { egress: p.egress, ingress: p.ingress, awake: p.awake, streams: p.streams };
  meter.reports.lastTryAt = Date.now();
  return fetch(FDSFLIX_URL + '/api/torrent-nodes/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-node-key': NODE_KEY },
    body: JSON.stringify({ node: nodeUrl, name: NODE_NAME, egressBytes: sent.egress, ingressBytes: sent.ingress, awakeSeconds: sent.awake, streams: sent.streams }),
    signal: AbortSignal.timeout(timeoutMs || 15000)
  }).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    // Só subtrai o que foi enviado (o medidor continuou somando durante o envio).
    for (const k of Object.keys(sent)) p[k] = Math.max(0, p[k] - sent[k]);
    meter.reports.ok += 1; meter.reports.lastOkAt = Date.now(); meter.reports.lastError = '';
    return true;
  }).catch((e) => {
    meter.reports.fail += 1; meter.reports.lastError = String((e && e.message) || e);
    return false; // pend segue acumulando e vai no próximo ciclo
  });
}

function harvestPeers(entry) {
  const peerId = Buffer.from('-TS0008-' + Math.random().toString(36).slice(2, 14).padEnd(12, 'x'));
  let n = 0;
  let c;
  try {
    c = new Tracker(peerId, 6881, { infoHash: entry.hash, announce: HTTP_TRACKERS });
  } catch (e) { return; }
  c.on('error', () => {});
  c.on('warning', () => {});
  c.on('peer', (addr) => { n++; try { entry.engine.connect(addr); } catch (e) { /* ignore */ } });
  try { c.start({ numwant: 200 }); } catch (e) { return; }
  setTimeout(() => {
    try { c.destroy(); } catch (e) { /* ignore */ }
    log('peers', entry.hash.slice(0, 8), `+${n} do tracker, conectados ${wiresOf(entry.engine)}`);
  }, 15000).unref();
}

/* --------------------- aquecimento (moov + começo do vídeo) --------------------- */

// Um MP4 só toca depois que o Chrome lê o `moov`. Em muitos (YIFY) ele fica NO FIM do arquivo: o
// navegador pede o final, espera os peers entregarem e só então começa. Aqui lemos os primeiros bytes,
// achamos onde o moov começa (caixas ftyp/free/mdat) e baixamos esse trecho + o começo ANTES de
// liberar o vídeo. Depois o Chrome só lê do disco.
// Devolve: offset do moov no FIM do arquivo; -2 se está no começo; -1 se não deu para saber.
function moovStartOf(buf, total) {
  let off = 0;
  for (let i = 0; i < 12 && off + 8 <= buf.length; i++) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'moov') return -2; // faststart: o moov já está no começo (coberto pelo começo do vídeo)
    if (size === 1) { if (off + 16 > buf.length) return -1; size = Number(buf.readBigUInt64BE(off + 8)); }
    if (size === 0) return -1; // a caixa vai até o fim do arquivo: não há moov depois
    if (type === 'mdat') return off + size < total ? off + size : -1;
    off += size;
  }
  return -1;
}

function drain(stream, onBytes, onEnd) {
  stream.on('data', (d) => onBytes(d));
  stream.on('end', onEnd);
  stream.on('error', onEnd);
}

function startWarm(entry) {
  const file = entry.file;
  const total = file.length;
  const w = { headNeed: Math.min(HEAD_BYTES, total), headHave: 0, tailNeed: 0, tailHave: 0, headDone: false, tailDone: false, parsed: false, done: false, t0: Date.now() };
  entry.warm = w;
  try { file.select(); } catch (e) { /* ignore */ }
  const remux = needsRemux(file.name);
  const check = () => {
    if (!w.done && w.headDone && (w.tailDone || !w.tailNeed)) { w.done = true; log('aquecido', entry.hash.slice(0, 8), `${((Date.now() - w.t0) / 1000).toFixed(1)}s`); }
  };
  const first = [];
  let firstLen = 0;
  const head = file.createReadStream({ start: 0, end: w.headNeed - 1 });
  entry.warmStreams = [head];
  drain(head, (d) => {
    w.headHave += d.length;
    if (!w.parsed && firstLen < 4096) { first.push(d); firstLen += d.length; }
    if (!w.parsed && (firstLen >= 4096 || w.headHave >= w.headNeed)) {
      w.parsed = true;
      let at = -1;
      if (!remux && /\.(mp4|m4v|mov)$/i.test(file.name)) at = moovStartOf(Buffer.concat(first), total);
      if (at === -1 && !remux) at = Math.max(1, total - 3 * 1024 * 1024); // não deu para ler: chuta os últimos 3 MB
      if (at > 0) {
        w.tailNeed = Math.min(total - at + 65536, MAX_TAIL, total); // +64 KB de folga
        const tail = file.createReadStream({ start: total - w.tailNeed, end: total - 1 });
        entry.warmStreams.push(tail);
        drain(tail, (x) => { w.tailHave += x.length; }, () => { w.tailDone = true; check(); });
      }
    }
  }, () => { w.headDone = true; if (!w.parsed) w.parsed = true; check(); });
}

function warmInfo(entry) {
  const w = entry.warm;
  if (!w) return null;
  const MB = 1048576;
  return {
    done: w.done,
    headMB: +(w.headHave / MB).toFixed(1), headNeedMB: +(w.headNeed / MB).toFixed(1),
    tailMB: +(w.tailHave / MB).toFixed(1), tailNeedMB: +(w.tailNeed / MB).toFixed(1),
    parsed: w.parsed
  };
}

function speedOf(entry) {
  try { return Math.round(entry.engine.swarm.downloadSpeed() / 1024); } catch (e) { return 0; }
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

// Instantâneo (não espera nada): o front consulta de 2 em 2 s para mostrar o progresso e liberar o vídeo.
function status(res, entry) {
  const file = entry.ready ? entry.file : null;
  json(res, 200, {
    ready: !!file,
    name: file ? file.name : null,
    wires: wiresOf(entry.engine),
    speedKBs: speedOf(entry),
    downloadedMB: entry.engine.swarm ? +(entry.engine.swarm.downloaded / 1048576).toFixed(1) : 0,
    warm: warmInfo(entry),
    reason: file ? '' : whyNot(entry)
  });
}

function stream(req, res, entry) {
  whenReady(entry, STREAM_WAIT_MS).then((ok) => {
    const file = ok ? entry.file : null;
    if (!file) { json(res, ok ? 404 : 504, { error: whyNot(entry) }); return; }
    try { file.select(); } catch (e) { /* ignore */ }
    // "Vídeo aberto" = pedido que começa do zero, no máximo 1 por minuto por torrent (o Chrome repete).
    if (!/bytes=[1-9]/.test(String(req.headers.range || '')) && Date.now() - entry.lastStreamAt > 60000) { meter.streams += 1; entry.lastStreamAt = Date.now(); }
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
      ff.stdout.on('data', (d) => { meter.http += d.length; });
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
    src.on('data', (d) => { meter.http += d.length; });
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
  // A URL pública deste nó (para o relatório) sai do Host da 1ª requisição vinda da internet. NODE_URL vence.
  // Só o Host (x-forwarded-host seria forjável por qualquer visitante e batizaria o nó errado).
  if (!nodeUrl) {
    const host = String(req.headers.host || '').split(',')[0].trim().toLowerCase();
    if (host && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host)) {
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      nodeUrl = `${proto === 'http' ? 'http' : 'https'}://${host}`;
    }
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'range', 'Access-Control-Max-Age': '600' });
    res.end();
    return;
  }
  if (u.pathname === '/ping') { res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('ok'); return; }
  if (u.pathname === '/usage') {
    drainMeter();
    const MB = 1048576;
    json(res, 200, {
      name: NODE_NAME || null,
      url: nodeUrl || null,
      reporting: Boolean(FDSFLIX_URL && NODE_KEY),
      fdsflix: FDSFLIX_URL || null,
      uploadSlots: UPLOAD_SLOTS,
      sinceMinutes: Math.round((Date.now() - meter.since) / 60000),
      egressMB: +(meter.total.egress / MB).toFixed(1),
      ingressMB: +(meter.total.ingress / MB).toFixed(1),
      awakeHours: +(meter.total.awake / 3600).toFixed(2),
      streams: meter.total.streams,
      pendingMB: +(meter.pend.egress / MB).toFixed(1),
      report: meter.reports
    });
    return;
  }
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
  const m = u.pathname.match(/^\/(stream|prepare|status)\/([a-fA-F0-9]{40})$/);
  if (!m) { json(res, 404, { error: 'rota' }); return; }
  const entry = engineFor(m[2], u.searchParams.get('magnet') || '');
  if (m[1] === 'prepare') prepare(res, entry);
  else if (m[1] === 'status') status(res, entry);
  else stream(req, res, entry);
});

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of engines) {
    if (now - v.last > IDLE_MS) { sample(v); try { v.engine.destroy(); } catch (e) {} engines.delete(k); }
  }
}, 60 * 1000).unref();

// Relatório de consumo: o 1º logo no começo (o nó aparece no painel), depois a cada REPORT_MS enquanto ligado.
setTimeout(() => reportNow(), 20000).unref();
setInterval(() => reportNow(), REPORT_MS).unref();
// Ao desligar (sleep/redeploy) tenta enviar o que faltou; o container pode ser morto logo depois.
let bye = false;
function goodbye() {
  if (bye) return; bye = true;
  Promise.race([reportNow(3000), new Promise((r) => setTimeout(r, 3500))]).then(() => process.exit(0));
}
process.on('SIGTERM', goodbye);
process.on('SIGINT', goodbye);

server.listen(PORT, () => log(`torrent streamer em :${PORT} (cache ${CACHE}, dht ${USE_DHT ? 'on' : 'off'}, upload ${UPLOAD_SLOTS}, relatório ${FDSFLIX_URL && NODE_KEY ? 'ligado' : 'DESLIGADO (sem FDSFLIX_URL/NODE_KEY)'})`));
