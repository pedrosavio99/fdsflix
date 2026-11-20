'use strict';

/**
 * Medidor de banda de SAÍDA do próprio servidor (o que o Render conta), com histórico DURÁVEL.
 *
 * O painel do Render separa a banda em duas contas, e as duas pesam no mês:
 *   - "HTTP Responses"    = bytes que o servidor RESPONDE a quem o chamou (página, API, vídeo, legenda…);
 *   - "Service-Initiated" = bytes que o servidor ENVIA por iniciativa própria (chamadas a TMDB, Supabase,
 *                           provedores, relays…). Sem isto, metade do consumo ficava invisível.
 *
 * Como medimos:
 *   - HTTP: o middleware conta o que sai em cada resposta, por tipo de rota (`classify`).
 *   - Iniciado pelo servidor: cada conexão de saída (fetch/https) é registrada pelo `net.Socket.connect` e seus
 *     bytes escritos/lidos na rede são somados POR HOST (`bytesWritten` = enviado, `bytesRead` = recebido).
 *     Loopback (CinePro, ffmpeg local) não conta: não sai da máquina e o Render não cobra.
 *
 * Histórico: o contador em memória zera a cada deploy/reinício (foram ~144 commits em novembro), então os totais
 * por DIA são gravados no Supabase (`pix_settings`, chave `egress:AAAA-MM-DD`) a cada 10 min e ao desligar.
 * Sem Supabase, grava em data/egress.json (some quando o Render reinicia). O dia é UTC, como o painel do Render.
 *
 * Variáveis: EGRESS_LOG_MIN (log no console, padrão 5), EGRESS_SAVE_MIN (gravação, padrão 10), EGRESS_FILE.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');

const startedAt = Date.now();
const MAX_HOSTS_PER_DAY = 40;
const KEEP_DAYS = 62;
const KEY = 'egress:';

let nowFn = () => Date.now();
let store = null;         // { kind, enabled(), get(day), put(day, v), list(n) }
let trackLoopback = false; // testes
const live = new Map();   // dia -> { http: Map(nome -> {b, r}), out: Map(host -> {s, r, c}) }  (só o que ESTE processo mediu)
const bases = new Map();  // dia -> o que já estava gravado antes deste processo subir (lido uma vez)
const dirty = new Set();
const persisted = { kind: '', lastSaveAt: 0, lastError: '', saves: 0 };
const guard = { allowedEnv: 0, allowedInternal: 0, rejected: 0, last: null };

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const today = () => dayOf(nowFn());
const mb = (bytes) => Number((bytes / 1048576).toFixed(3));

function bucket(day) {
  let b = live.get(day);
  if (!b) { b = { http: new Map(), out: new Map() }; live.set(day, b); }
  return b;
}

function classify(pathname) {
  if (pathname === '/api/proxy') return 'video: /api/proxy';
  if (pathname === '/api/hls-proxy') return 'video: /api/hls-proxy';
  if (pathname.startsWith('/hls/')) return 'video: /hls (ffmpeg)';
  if (pathname.startsWith('/api/subtitle')) return 'legendas';
  if (pathname.startsWith('/api/usage')) return 'api: usage';
  if (pathname.startsWith('/api/visitors')) return 'api: visitors';
  if (pathname.startsWith('/api/')) return 'api: ' + (pathname.split('/')[2] || '?');
  if (pathname.startsWith('/vendor/') || pathname.startsWith('/cv/')) return 'estatico: vendor/cv';
  return 'estatico: pagina';
}

function addHttp(name, bytes) {
  const day = today();
  const m = bucket(day).http;
  const g = m.get(name) || { b: 0, r: 0 };
  g.b += bytes;
  g.r += 1;
  m.set(name, g);
  dirty.add(day);
}

function addOut(host, sent, recv, conns) {
  if (!host) return;
  const day = today();
  const m = bucket(day).out;
  const g = m.get(host) || { s: 0, r: 0, c: 0 };
  g.s += sent;
  g.r += recv;
  g.c += conns;
  m.set(host, g);
  dirty.add(day);
}

function middleware(req, res, next) {
  const name = classify(String(req.path || req.url || '/'));
  let sent = 0;
  const write = res.write;
  const end = res.end;
  res.write = function (chunk, encoding) {
    if (chunk) sent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : undefined);
    return write.apply(this, arguments);
  };
  res.end = function (chunk, encoding) {
    if (chunk && typeof chunk !== 'function') sent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : undefined);
    return end.apply(this, arguments);
  };
  // 'close' dispara também quando o cliente desiste no meio: conta só o que de fato foi escrito.
  res.on('close', () => addHttp(name, sent));
  next();
}

/* ------------------------- saída iniciada pelo servidor ------------------------- */

const sockets = new Map(); // socket -> { host, w, r }
let installed = false;

function isLocalHost(host) {
  return /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0|::ffff:127\.)/i.test(host);
}

function hostFromConnectArgs(args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0]; // net normaliza para [options, cb]
  if (o && typeof o === 'object') {
    if (o.path && !o.host) return ''; // socket unix
    return String(o.servername || o.host || o.hostname || '').toLowerCase();
  }
  if (typeof o === 'number') return String(args[1] || 'localhost').toLowerCase();
  return '';
}

function sampleSocket(socket, entry) {
  let w = 0;
  let r = 0;
  try { w = Number(socket.bytesWritten) || 0; r = Number(socket.bytesRead) || 0; } catch (err) { return; }
  const dw = Math.max(0, w - entry.w);
  const dr = Math.max(0, r - entry.r);
  entry.w = w;
  entry.r = r;
  if (dw || dr) addOut(entry.host, dw, dr, 0);
}

function sampleAll() {
  for (const [socket, entry] of sockets) sampleSocket(socket, entry);
}

/** Liga a medição das conexões de saída (idempotente). Chamar uma vez, cedo, no boot do servidor. */
function install() {
  if (installed) return;
  installed = true;
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(...args) {
    try {
      const host = hostFromConnectArgs(args);
      if (host && (trackLoopback || !isLocalHost(host)) && !sockets.has(this)) {
        const entry = { host, w: 0, r: 0 };
        sockets.set(this, entry);
        addOut(host, 0, 0, 1);
        this.once('close', () => { sampleSocket(this, entry); sockets.delete(this); });
      }
    } catch (err) { /* medir nunca atrapalha a conexão */ }
    return original.apply(this, args);
  };
}

/* --------------------------------- trava de vídeo --------------------------------- */

/** A trava `blockRenderVideo` avisa aqui o que decidiu (diagnóstico: aparece no painel). */
function noteGuard(kind, req) {
  if (kind === 'env') guard.allowedEnv += 1;
  else if (kind === 'internal') guard.allowedInternal += 1;
  else {
    guard.rejected += 1;
    guard.last = {
      at: nowFn(),
      path: String((req && req.path) || ''),
      addr: String((req && req.socket && req.socket.remoteAddress) || ''),
      forwarded: Boolean(req && req.headers && req.headers['x-forwarded-for'])
    };
  }
}

/* ----------------------------------- persistência ----------------------------------- */

function plain(b) {
  const http = {};
  for (const [k, g] of b.http) http[k] = { b: g.b, r: g.r };
  const out = {};
  for (const [k, g] of b.out) out[k] = { s: g.s, r: g.r, c: g.c };
  return { http, out };
}

function merge(a, b) {
  const res = { http: {}, out: {} };
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [k, g] of Object.entries(src.http || {})) {
      const t = res.http[k] || (res.http[k] = { b: 0, r: 0 });
      t.b += g.b || 0; t.r += g.r || 0;
    }
    for (const [k, g] of Object.entries(src.out || {})) {
      const t = res.out[k] || (res.out[k] = { s: 0, r: 0, c: 0 });
      t.s += g.s || 0; t.r += g.r || 0; t.c += g.c || 0;
    }
  }
  return res;
}

/** Guarda só os maiores hosts do dia; o resto vira "(outros)". */
function trim(v) {
  const entries = Object.entries(v.out || {});
  if (entries.length <= MAX_HOSTS_PER_DAY) return v;
  entries.sort((a, b) => (b[1].s + b[1].r) - (a[1].s + a[1].r));
  const out = {};
  const rest = { s: 0, r: 0, c: 0 };
  entries.forEach(([k, g], i) => {
    if (i < MAX_HOSTS_PER_DAY - 1) out[k] = g;
    else { rest.s += g.s; rest.r += g.r; rest.c += g.c; }
  });
  out['(outros)'] = rest;
  return { http: v.http, out };
}

function filePath() {
  return process.env.EGRESS_FILE || path.join(__dirname, '..', 'data', 'egress.json');
}

function fileStore() {
  const read = () => { try { return JSON.parse(fs.readFileSync(filePath(), 'utf8')).days || {}; } catch (err) { return {}; } };
  return {
    kind: 'arquivo',
    enabled: () => true,
    async get(day) { return read()[day] || null; },
    async put(day, v) {
      const days = read();
      days[day] = v;
      const keep = Object.keys(days).sort().slice(-KEEP_DAYS);
      const next = {};
      keep.forEach((d) => { next[d] = days[d]; });
      fs.mkdirSync(path.dirname(filePath()), { recursive: true });
      fs.writeFileSync(filePath() + '.tmp', JSON.stringify({ days: next }));
      fs.renameSync(filePath() + '.tmp', filePath());
    },
    async list(n) { const d = read(); return Object.keys(d).sort().reverse().slice(0, n).map((day) => ({ day, v: d[day] })); }
  };
}

function supabaseStore(us) {
  const quiet = { quiet: true };
  return {
    kind: 'supabase',
    enabled: () => true,
    async get(day) {
      const rows = await us.call('GET', `/pix_settings?select=v&k=eq.${encodeURIComponent(KEY + day)}&limit=1`, undefined, undefined, quiet);
      return rows && rows[0] ? rows[0].v : null;
    },
    async put(day, v) {
      await us.call('POST', '/pix_settings?on_conflict=k', { k: KEY + day, v, updated_at: new Date(nowFn()).toISOString() },
        { Prefer: 'resolution=merge-duplicates,return=minimal' }, quiet);
    },
    async list(n) {
      const rows = await us.call('GET', `/pix_settings?select=k,v&k=like.${encodeURIComponent(KEY + '*')}&order=k.desc&limit=${n}`, undefined, undefined, quiet);
      return (rows || []).map((r) => ({ day: String(r.k).slice(KEY.length), v: r.v }));
    }
  };
}

function theStore() {
  if (store) return store;
  let chosen = null;
  try {
    const us = require('./usageStore');
    if (us.enabled()) chosen = supabaseStore(us);
  } catch (err) { /* sem Supabase */ }
  store = chosen || fileStore();
  persisted.kind = store.kind;
  return store;
}

async function ensureBase(day) {
  if (bases.has(day)) return bases.get(day);
  const v = await theStore().get(day);
  bases.set(day, v || null);
  return v || null;
}

/** Grava os totais dos dias que mudaram (o que já estava gravado + o que este processo mediu). */
async function flush() {
  sampleAll();
  const days = [...dirty];
  for (const day of days) {
    const b = live.get(day);
    if (!b) { dirty.delete(day); continue; }
    try {
      const base = await ensureBase(day);
      await theStore().put(day, trim(merge(base, plain(b))));
      dirty.delete(day);
      persisted.lastSaveAt = nowFn();
      persisted.lastError = '';
      persisted.saves += 1;
    } catch (err) {
      persisted.lastError = String(err && err.message || err).slice(0, 160);
    }
  }
}

/* ------------------------------------ relatórios ------------------------------------ */

function describeDay(day, v) {
  const http = Object.entries(v.http || {}).map(([name, g]) => ({ name, mb: mb(g.b), requests: g.r })).sort((a, b) => b.mb - a.mb);
  const out = Object.entries(v.out || {})
    .map(([host, g]) => ({ host, sentMb: mb(g.s), recvMb: mb(g.r), conns: g.c }))
    .sort((a, b) => (b.sentMb + b.recvMb) - (a.sentMb + a.recvMb));
  const sum = (arr, f) => Number(arr.reduce((a, x) => a + f(x), 0).toFixed(3));
  return {
    day,
    httpMb: sum(http, (x) => x.mb),
    videoMb: sum(http.filter((x) => x.name.startsWith('video:')), (x) => x.mb),
    outSentMb: sum(out, (x) => x.sentMb),
    outRecvMb: sum(out, (x) => x.recvMb),
    http,
    out
  };
}

/**
 * Painel do admin: por dia (hoje já com o que este processo mediu), total do mês e o estado da trava de vídeo.
 * `days` = quantos dias de histórico (padrão 31).
 */
async function report({ days = 31 } = {}) {
  sampleAll();
  const rows = new Map();
  let listError = '';
  try {
    for (const r of await theStore().list(Math.max(1, Math.min(KEEP_DAYS, days)))) if (r.v) rows.set(r.day, r.v);
  } catch (err) { listError = String(err && err.message || err).slice(0, 160); }
  for (const [day, b] of live) {
    let base = null;
    try { base = await ensureBase(day); } catch (err) { base = rows.get(day) || null; listError = listError || String(err.message).slice(0, 160); }
    rows.set(day, merge(base, plain(b)));
  }
  const list = [...rows.keys()].sort().slice(-days).map((day) => describeDay(day, rows.get(day)));
  const t = today();
  const month = t.slice(0, 7);
  const monthRows = list.filter((d) => d.day.startsWith(month));
  const agg = describeDay(month, monthRows.reduce((acc, d) => merge(acc, {
    http: Object.fromEntries(d.http.map((x) => [x.name, { b: x.mb * 1048576, r: x.requests }])),
    out: Object.fromEntries(d.out.map((x) => [x.host, { s: x.sentMb * 1048576, r: x.recvMb * 1048576, c: x.conns }]))
  }), { http: {}, out: {} }));
  const pickTotals = (d) => d && ({ httpMb: d.httpMb, videoMb: d.videoMb, outSentMb: d.outSentMb, outRecvMb: d.outRecvMb });
  return {
    now: nowFn(),
    today: pickTotals(list.find((d) => d.day === t)) || { httpMb: 0, videoMb: 0, outSentMb: 0, outRecvMb: 0 },
    month: { ...pickTotals(agg), http: agg.http.slice(0, 12), out: agg.out.slice(0, 15), days: monthRows.length },
    days: list.map((d) => ({ ...d, http: d.http.slice(0, 8), out: d.out.slice(0, 8) })),
    sinceBootMinutes: Math.round((nowFn() - startedAt) / 60000),
    persistence: { kind: persisted.kind || theStore().kind, lastSaveAt: persisted.lastSaveAt || null, saves: persisted.saves, error: persisted.lastError || listError || '' },
    videoGuard: { ...guard }
  };
}

/** Só o que ESTE processo mediu (síncrono; zera a cada reinício). Mantido para /api/egress e o log. */
function snapshot() {
  sampleAll();
  const http = new Map();
  const out = new Map();
  for (const b of live.values()) {
    for (const [k, g] of b.http) { const t = http.get(k) || { b: 0, r: 0 }; t.b += g.b; t.r += g.r; http.set(k, t); }
    for (const [k, g] of b.out) { const t = out.get(k) || { s: 0, r: 0, c: 0 }; t.s += g.s; t.r += g.r; t.c += g.c; out.set(k, t); }
  }
  const rows = [...http.entries()].map(([name, g]) => ({ name, mb: mb(g.b), requests: g.r })).sort((a, b) => b.mb - a.mb);
  const outbound = [...out.entries()].map(([host, g]) => ({ host, sentMb: mb(g.s), recvMb: mb(g.r), conns: g.c }))
    .sort((a, b) => (b.sentMb + b.recvMb) - (a.sentMb + a.recvMb));
  return {
    sinceMinutes: Math.round((nowFn() - startedAt) / 60000),
    totalMb: Number(rows.reduce((a, r) => a + r.mb, 0).toFixed(3)),
    outboundSentMb: Number(outbound.reduce((a, r) => a + r.sentMb, 0).toFixed(3)),
    note: 'Desde que este processo subiu (reinício zera; o histórico por dia está em /api/admin/egress). totalMb = respostas HTTP; outbound = o que o servidor enviou/recebeu em chamadas que ele mesmo iniciou.',
    groups: rows,
    outbound
  };
}

let logTimer = null;
let saveTimer = null;

function startLogging() {
  const minutes = Math.max(1, Number(process.env.EGRESS_LOG_MIN) || 5);
  logTimer = setInterval(() => {
    const s = snapshot();
    if (!s.groups.length && !s.outbound.length) return;
    console.log(
      `[egress] resp ${s.totalMb} MB · saída própria ${s.outboundSentMb} MB em ${s.sinceMinutes} min · ` +
      s.groups.slice(0, 5).map((r) => `${r.name} ${r.mb} MB/${r.requests}req`).join(' · ') +
      (s.outbound.length ? ' · fora: ' + s.outbound.slice(0, 4).map((r) => `${r.host} ↑${r.sentMb}/↓${r.recvMb} MB`).join(' · ') : '')
    );
  }, minutes * 60 * 1000);
  logTimer.unref();
  const saveMin = Math.max(1, Number(process.env.EGRESS_SAVE_MIN) || 10);
  saveTimer = setInterval(() => { flush().catch(() => {}); }, saveMin * 60 * 1000);
  saveTimer.unref();
}

/** Testes: zera tudo e troca o relógio/armazém. */
function _reset(opts = {}) {
  live.clear(); bases.clear(); dirty.clear(); sockets.clear();
  guard.allowedEnv = 0; guard.allowedInternal = 0; guard.rejected = 0; guard.last = null;
  persisted.kind = ''; persisted.lastSaveAt = 0; persisted.lastError = ''; persisted.saves = 0;
  store = opts.store || null;
  nowFn = opts.now || (() => Date.now());
  trackLoopback = Boolean(opts.trackLoopback);
}

module.exports = { middleware, snapshot, report, flush, install, noteGuard, startLogging, classify, _reset };
