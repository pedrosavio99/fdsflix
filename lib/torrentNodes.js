'use strict';

/**
 * fdsFlix - Consumo dos nós do streamer de torrent (deploy/torrent-streamer).
 *
 * Um nó = uma conta (SnapDeploy) = um container. Quem MEDE é o próprio nó: ele vê todos os bytes que saem
 * (vídeo para o navegador + upload para os peers) e os que entram (download dos peers), e quantos segundos
 * ficou ligado. A cada ~2 min ele avisa o Render em POST /api/torrent-nodes/report (header x-node-key).
 * Aqui somamos por DIA (UTC) e por nó, guardamos no Supabase (supabase/torrent-nodes-schema.sql) e o painel
 * "Torrents" mostra quanto resta de banda e de container-horas por nó.
 *
 * Por que o nó mede e não o navegador (como nas Vercels): o <video> não informa quantos bytes recebeu, e o
 * nó também é quem sabe o upload para peers, que conta como banda de saída.
 *
 * LIMITES: o SnapDeploy NÃO publica um número de banda (os termos falam em "allowance razoável"); o que é
 * documentado é 100 container-horas/mês por CONTA e 100 req/min por IP no domínio compartilhado. Por isso a
 * cota de banda é uma ASSUNÇÃO sua (variável abaixo), não um fato. Ajuste quando descobrir o limite real.
 *
 * Variáveis (todas opcionais):
 *   TORRENT_NODES              URLs dos nós, separadas por vírgula/espaço/linha (aparecem no painel mesmo sem uso)
 *   TORRENT_NODE_KEY           segredo que os nós usam para reportar. Sem ela: derivada do Supabase/STATS_KEY
 *   TORRENT_NODE_QUOTA_GB      banda de saída assumida por nó/mês (padrão 10)
 *   TORRENT_NODE_QUOTAS        cota por nó: `URL=GB` separados por vírgula
 *   TORRENT_NODE_HOURS         container-horas por nó/mês (padrão 100, o limite documentado do plano free)
 *   TORRENT_NODE_RESET_DAY     dia do mês em que renova (padrão 1)
 *   TORRENT_NODE_FILE          cache local (padrão ./.torrent-nodes.json)
 *   SUPABASE_URL / SUPABASE_SECRET_KEY   histórico durável
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./usageStore');

const GB = 1024 ** 3;
const DAY_MS = 86400000;
const HISTORY_DAYS = 120;
const KEEP_DAYS = 400;
const MAX_NODES = 60;                 // chave vazada não enche a tabela
const MAX_EGRESS_PER_REPORT = 50 * GB;
const MAX_AWAKE_PER_REPORT = 24 * 3600;
const FLUSH_DELAY_MS = 20000;
const RETRY_DELAY_MS = 60000;
const PULL_EVERY_MS = 10 * 60000;
const SLEEP_AFTER_MS = 20 * 60000;    // sem relatório há isso = provavelmente dormindo
const MOVIE_GB = 0.7;                 // um filme 720p (YIFY) ≈ 0,7 GB; 1080p ≈ 1,5–2 GB
const FILE = path.resolve(process.env.TORRENT_NODE_FILE || path.join(__dirname, '..', '.torrent-nodes.json'));

const state = { daily: {}, seen: {} };   // seen[node] = { at, name }
let pending = {};
let inflight = {};
const sync = { hydrated: false, flushing: false, pulling: false, lastPullAt: null, lastFlushAt: null, lastPruneDay: '' };
let saveTimer = null;
let flushTimer = null;

/* ----------------------------- datas (UTC) ----------------------------- */

const isoDay = (d) => d.toISOString().slice(0, 10);
const today = (now = new Date()) => isoDay(now);
const addDays = (day, n) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));

function resetDay() {
  const day = Math.floor(Number(process.env.TORRENT_NODE_RESET_DAY));
  return Number.isFinite(day) && day >= 1 && day <= 28 ? day : 1;
}

function currentCycle(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), resetDay()));
  if (now < start) start.setUTCMonth(start.getUTCMonth() - 1);
  return isoDay(start);
}

function daysUntilReset(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), resetDay()));
  if (now >= next) next.setUTCMonth(next.getUTCMonth() + 1);
  return Math.max(0, Math.ceil((next - now) / DAY_MS));
}

/* ----------------------------- configuração ----------------------------- */

function normalizeNode(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function validNode(url) {
  return /^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(url) && url.length <= 200;
}

function configuredNodes() {
  const raw = String(process.env.TORRENT_NODES || '');
  return Array.from(new Set(raw.split(/[\s,;]+/).map(normalizeNode).filter(validNode)));
}

function quotaGb(node) {
  const map = new Map();
  for (const tok of String(process.env.TORRENT_NODE_QUOTAS || '').split(/[\s,;]+/)) {
    const eq = tok.lastIndexOf('=');
    if (eq <= 0) continue;
    const gb = Number(tok.slice(eq + 1));
    const url = normalizeNode(tok.slice(0, eq));
    if (validNode(url) && Number.isFinite(gb) && gb > 0) map.set(url, gb);
  }
  if (map.has(node)) return map.get(node);
  const def = Number(process.env.TORRENT_NODE_QUOTA_GB);
  return Number.isFinite(def) && def > 0 ? def : 10;
}

function hoursQuota() {
  const h = Number(process.env.TORRENT_NODE_HOURS);
  return Number.isFinite(h) && h > 0 ? h : 100;
}

/**
 * Segredo dos nós. Configure TORRENT_NODE_KEY. Se não houver, derivamos uma de um segredo que o servidor já
 * tem (chave do Supabase, senão a senha de admin), para o kit sair pronto sem variável nova.
 */
function nodeKey() {
  const env = String(process.env.TORRENT_NODE_KEY || '').trim();
  if (env) return env;
  const seed = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STATS_KEY || '118111');
  return crypto.createHash('sha256').update(`fdsflix-torrent-node:${seed}`).digest('hex').slice(0, 40);
}

function keyOK(provided) {
  const a = crypto.createHash('sha256').update(String(provided || '')).digest();
  const b = crypto.createHash('sha256').update(nodeKey()).digest();
  return Boolean(provided) && crypto.timingSafeEqual(a, b);
}

/* ----------------------------- mapa dia/nó ----------------------------- */

const zero = () => ({ egress: 0, ingress: 0, awake: 0, streams: 0, reports: 0 });

function addTo(map, day, node, d) {
  if (!map[day]) map[day] = {};
  if (!map[day][node]) map[day][node] = zero();
  const c = map[day][node];
  c.egress += d.egress || 0; c.ingress += d.ingress || 0; c.awake += d.awake || 0;
  c.streams += d.streams || 0; c.reports += d.reports || 0;
}

function entriesOf(map) {
  const out = [];
  for (const day of Object.keys(map)) for (const node of Object.keys(map[day])) out.push({ day, node, delta: map[day][node] });
  return out;
}

function mergeMaps(a, b) {
  const out = {};
  for (const e of [...entriesOf(a), ...entriesOf(b)]) addTo(out, e.day, e.node, e.delta);
  return out;
}

function sumRange(node, from, to) {
  const acc = zero();
  for (const day of Object.keys(state.daily)) {
    if (day < from || day > to) continue;
    const c = state.daily[day][node];
    if (!c) continue;
    acc.egress += c.egress; acc.ingress += c.ingress; acc.awake += c.awake; acc.streams += c.streams; acc.reports += c.reports;
  }
  return acc;
}

const pendingCount = () => entriesOf(pending).length + entriesOf(inflight).length;

/* ----------------------------- cache local ----------------------------- */

function load() {
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (p && p.v === 1) {
      state.daily = p.daily && typeof p.daily === 'object' ? p.daily : {};
      state.seen = p.seen && typeof p.seen === 'object' ? p.seen : {};
      pending = p.pending && typeof p.pending === 'object' ? p.pending : {};
    }
  } catch (err) { /* primeiro uso: começa do zero (o Supabase repõe) */ }
  pruneMemory();
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(FILE, JSON.stringify({ v: 1, daily: state.daily, seen: state.seen, pending: mergeMaps(pending, inflight) })); } catch (err) { /* disco somente leitura */ }
  }, 4000);
  if (saveTimer.unref) saveTimer.unref();
}

function pruneMemory() {
  const limit = addDays(today(), -KEEP_DAYS);
  for (const day of Object.keys(state.daily)) if (day < limit) delete state.daily[day];
}

/* ----------------------------- escrita ----------------------------- */

function num(v, max) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
}

/** Soma um relatório do nó. Devolve { ok, error }. */
function record(nodeUrl, body = {}) {
  const node = normalizeNode(nodeUrl);
  if (!validNode(node)) return { ok: false, error: 'url do nó inválida' };
  if (!state.seen[node] && Object.keys(state.seen).length >= MAX_NODES) return { ok: false, error: 'nós demais' };
  const delta = {
    egress: num(body.egressBytes, MAX_EGRESS_PER_REPORT),
    ingress: num(body.ingressBytes, MAX_EGRESS_PER_REPORT),
    awake: num(body.awakeSeconds, MAX_AWAKE_PER_REPORT),
    streams: num(body.streams, 10000),
    reports: 1
  };
  const name = String(body.name || '').replace(/[^\w .\-@]/g, '').slice(0, 40);
  delta.name = name;
  const day = today();
  addTo(state.daily, day, node, delta);
  addTo(pending, day, node, delta);
  state.seen[node] = { at: Date.now(), name: name || (state.seen[node] && state.seen[node].name) || '' };
  scheduleSave();
  scheduleFlush();
  return { ok: true };
}

function scheduleFlush(delay = FLUSH_DELAY_MS) {
  if (flushTimer || !store.enabled()) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => { /* já agendou nova tentativa */ }); }, delay);
  if (flushTimer.unref) flushTimer.unref();
}

async function addUsageRow(day, node, d) {
  await store.call('POST', '/rpc/fdsflix_add_node_usage', {
    p_day: day, p_node: node,
    p_egress: Math.round(d.egress || 0), p_ingress: Math.round(d.ingress || 0), p_awake: Math.round(d.awake || 0),
    p_streams: Math.round(d.streams || 0), p_reports: Math.round(d.reports || 0),
    p_name: (state.seen[node] && state.seen[node].name) || ''
  }, undefined, { quiet: true });
}

const storeStatus = { lastOkAt: null, lastError: '', tablesMissing: false };

function noteStoreError(err) {
  storeStatus.lastError = err.message;
  storeStatus.tablesMissing = Boolean(err.tablesMissing);
}

async function flush() {
  if (!store.enabled() || sync.flushing) return { sent: 0 };
  const batch = entriesOf(pending);
  if (!batch.length) return { sent: 0 };
  sync.flushing = true;
  inflight = pending;
  pending = {};
  let sent = 0;
  try {
    for (const item of batch) {
      await addUsageRow(item.day, item.node, item.delta);
      delete inflight[item.day][item.node];
      sent += 1;
    }
    sync.lastFlushAt = Date.now();
    storeStatus.lastOkAt = Date.now(); storeStatus.lastError = ''; storeStatus.tablesMissing = false;
    return { sent };
  } catch (err) {
    noteStoreError(err);
    scheduleFlush(RETRY_DELAY_MS);
    throw err;
  } finally {
    pending = mergeMaps(pending, inflight);
    inflight = {};
    sync.flushing = false;
    scheduleSave();
  }
}

async function fetchDaily(sinceDay) {
  const rows = [];
  for (let offset = 0; offset < 50000; offset += 1000) {
    const q = `/torrent_node_usage_daily?select=day,node,name,egress_bytes,ingress_bytes,awake_seconds,streams,reports` +
      `&day=gte.${encodeURIComponent(sinceDay)}&order=day.asc,node.asc&limit=1000&offset=${offset}`;
    const page = await store.call('GET', q, undefined, undefined, { quiet: true });
    rows.push(...(page || []));
    if (!page || page.length < 1000) break;
  }
  return rows;
}

/** Relê o Supabase (fonte da verdade) e reaplica o que ainda não foi enviado. */
async function pull() {
  if (!store.enabled() || sync.pulling) return { rows: 0 };
  sync.pulling = true;
  try {
    const since = addDays(today(), -HISTORY_DAYS);
    const rows = await fetchDaily(since);
    const fresh = {};
    for (const r of rows) {
      const node = normalizeNode(r.node);
      addTo(fresh, String(r.day).slice(0, 10), node, {
        egress: Number(r.egress_bytes) || 0, ingress: Number(r.ingress_bytes) || 0, awake: Number(r.awake_seconds) || 0,
        streams: Number(r.streams) || 0, reports: Number(r.reports) || 0
      });
      if (r.name && !(state.seen[node] && state.seen[node].name)) state.seen[node] = { at: (state.seen[node] || {}).at || 0, name: String(r.name) };
    }
    state.daily = mergeMaps(fresh, mergeMaps(pending, inflight));
    sync.hydrated = true;
    sync.lastPullAt = Date.now();
    storeStatus.lastOkAt = Date.now(); storeStatus.lastError = ''; storeStatus.tablesMissing = false;
    pruneMemory();
    scheduleSave();
    if (sync.lastPruneDay !== today()) {
      sync.lastPruneDay = today();
      store.call('DELETE', `/torrent_node_usage_daily?day=lt.${encodeURIComponent(addDays(today(), -KEEP_DAYS))}`, undefined, { Prefer: 'return=minimal' }, { quiet: true }).catch(() => { /* melhor esforço */ });
    }
    return { rows: rows.length };
  } catch (err) {
    noteStoreError(err);
    throw err;
  } finally {
    sync.pulling = false;
  }
}

async function syncNow() {
  let error = '';
  try { await flush(); await pull(); } catch (err) { error = err.message; }
  return { ok: !error, error, storage: storageStatus() };
}

function storageStatus() {
  return {
    provider: store.enabled() ? 'supabase' : 'local',
    configured: store.enabled(),
    ok: store.enabled() ? Boolean(sync.hydrated && !storeStatus.lastError) : false,
    tablesMissing: storeStatus.tablesMissing,
    error: storeStatus.lastError,
    hydrated: sync.hydrated,
    lastPullAt: sync.lastPullAt,
    lastFlushAt: sync.lastFlushAt,
    pendingRows: pendingCount()
  };
}

function start() {
  if (!store.enabled()) return;
  const run = () => pull().then(() => flush()).catch(() => { /* storageStatus guarda o erro */ });
  run();
  const t = setInterval(run, PULL_EVERY_MS);
  if (t.unref) t.unref();
}

/* ----------------------------- leitura ----------------------------- */

function labelOf(node) {
  const seen = state.seen[node];
  if (seen && seen.name) return seen.name;
  try { return new URL(node).hostname.replace(/\.containers\.snapdeploy\.app$/, '').replace(/\.snapdeploy\.app$/, ''); } catch (err) { return node; }
}

function nodeRow(node, now = new Date()) {
  const cycle = currentCycle(now);
  const day = today(now);
  const c = sumRange(node, cycle, day);
  const t = sumRange(node, day, day);
  const quota = quotaGb(node) * GB;
  const hoursQ = hoursQuota();
  const hoursUsed = c.awake / 3600;
  const left = Math.max(0, quota - c.egress);
  const hoursLeft = Math.max(0, hoursQ - hoursUsed);
  const seenAt = state.seen[node] ? state.seen[node].at : 0;
  const pctBytes = quota ? Math.min(100, (c.egress / quota) * 100) : 100;
  const pctHours = hoursQ ? Math.min(100, (hoursUsed / hoursQ) * 100) : 100;
  const daysElapsed = Math.max(1, Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${cycle}T00:00:00Z`)) / DAY_MS) + 1);
  // GB por filme medido (egress / streams), senão o padrão. Só vale com 3+ vídeos abertos no ciclo.
  const gbPerStream = c.streams >= 3 && c.egress > 0 ? c.egress / c.streams / GB : MOVIE_GB;
  return {
    node,
    label: labelOf(node),
    egressBytes: c.egress,
    ingressBytes: c.ingress,
    quotaBytes: quota,
    remainingBytes: left,
    pct: Number(pctBytes.toFixed(1)),
    todayEgressBytes: t.egress,
    hoursUsed: Number(hoursUsed.toFixed(2)),
    hoursQuota: hoursQ,
    hoursLeft: Number(hoursLeft.toFixed(1)),
    pctHours: Number(pctHours.toFixed(1)),
    streams: c.streams,
    gbPerStream: Number(gbPerStream.toFixed(2)),
    gbPerStreamMeasured: c.streams >= 3 && c.egress > 0,
    filmsLeft: Math.floor(left / GB / gbPerStream),
    gbPerDay: Number((c.egress / GB / daysElapsed).toFixed(2)),
    lastSeenAt: seenAt || null,
    asleep: !seenAt || (Date.now() - seenAt) > SLEEP_AFTER_MS,
    exhausted: pctBytes >= 98 || pctHours >= 98,
    exhaustedBy: pctBytes >= 98 ? 'banda' : (pctHours >= 98 ? 'horas' : ''),
    assumedQuota: true
  };
}

/** Todos os nós: os do env, os que já reportaram e os que o navegador pediu (`extra`). */
function allNodes(extra = []) {
  const set = new Set([...configuredNodes(), ...Object.keys(state.seen)]);
  for (const n of extra) { const u = normalizeNode(n); if (validNode(u)) set.add(u); }
  for (const day of Object.keys(state.daily)) for (const n of Object.keys(state.daily[day])) set.add(n);
  return Array.from(set).slice(0, MAX_NODES);
}

function snapshot(extra = [], now = new Date()) {
  const nodes = allNodes(extra).map((n) => nodeRow(n, now));
  const sum = (k) => nodes.reduce((a, n) => a + n[k], 0);
  return {
    cycleStart: currentCycle(now),
    daysLeft: daysUntilReset(now),
    quotaGbDefault: quotaGb(''),
    hoursQuota: hoursQuota(),
    nodes,
    configured: configuredNodes(),
    total: {
      egressBytes: sum('egressBytes'),
      ingressBytes: sum('ingressBytes'),
      quotaBytes: sum('quotaBytes'),
      remainingBytes: sum('remainingBytes'),
      filmsLeft: sum('filmsLeft'),
      hoursUsed: Number(sum('hoursUsed').toFixed(2)),
      hoursQuota: nodes.length * hoursQuota(),
      pct: sum('quotaBytes') ? Number(Math.min(100, (sum('egressBytes') / sum('quotaBytes')) * 100).toFixed(1)) : 0
    },
    // Ordem de preferência para escolher onde tocar: sobra de banda, sem nó esgotado na frente.
    rank: nodes.filter((n) => !n.exhausted).sort((a, b) => b.remainingBytes - a.remainingBytes).map((n) => n.node),
    storage: storageStatus(),
    note: 'Banda medida pelo próprio nó (saída = vídeo + upload para peers). A cota é uma ASSUNÇÃO sua: o SnapDeploy não publica o limite.'
  };
}

load();
start();

module.exports = {
  record, snapshot, keyOK, nodeKey, configuredNodes, normalizeNode, validNode, quotaGb, hoursQuota,
  syncNow, flush, pull, storageStatus, currentCycle, daysUntilReset, MOVIE_GB
};
