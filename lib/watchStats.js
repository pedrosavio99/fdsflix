'use strict';

/**
 * fdsFlix - O que o público assiste: filmes, séries e canais de TV, agregado por DIA (sem IP, sem pessoa).
 *
 * Irmão do lib/visitors.js (que diz QUEM entra): aqui se conta O QUÊ. Uma linha por dia e por título/canal:
 *   { kind: 'movie'|'series'|'live', key, title, watches, viewers }
 *   watches = começos de sessão (o mesmo aparelho no mesmo título conta 1x a cada 30 min: recarregar a página ou
 *             trocar de fonte não infla); viewers = aparelhos diferentes no dia (aproximado).
 * Vai ao Supabase em lote (supabase/watch-schema.sql). Sem a tabela ou sem Supabase o site segue normal e a lista
 * fica só em memória (zera a cada reinício). Nenhuma env nova.
 */

const { CHANNELS } = require('./liveChannels');
const store = require('./usageStore');
const geo = require('./geo');
const visitors = require('./visitors');

const DAY_MS = 86400000;
const SESSION_MS = 30 * 60000;
const FLUSH_MS = 30000;
const READ_CACHE_MS = 20000;
const KEEP_DAYS = 400;
const MAX_SEEN = 50000;
const MAX_ROWS_PER_DAY = 5000;
const PAGE = 1000;

let local = new Map();     // dia -> Map(kind|key -> linha)
let pending = new Map();   // kind|key|dia -> delta ainda não enviado
let inflight = new Map();
const seen = new Map();    // visitante|kind:key -> último começo (ms)
const seenDay = new Map(); // visitante|kind:key -> dia em que já contou como "aparelho"
let flushing = false;
let flushTimer = null;
let lastPruneDay = '';
let readCache = { at: 0, since: '', rows: null };
const sync = { lastFlushAt: null, lastError: '', tablesMissing: false };

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const clean = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f<>"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** O que esta requisição é: { kind, key, title } ou null (não é o começo de uma sessão de vídeo). */
function classify(req) {
  if (String(req.method || 'GET').toUpperCase() !== 'GET') return null;
  const path = String(req.path || req.url || '').split('?')[0];
  const q = req.query || {};
  if (path === '/api/stream') {
    const series = String(q.type || '') === 'tv';
    const id = /^\d+$/.test(String(q.id || '')) ? String(q.id) : '';
    const title = clean(q.title, 70);
    if (!id && !title) return null;
    return { kind: series ? 'series' : 'movie', key: `${series ? 's' : 'm'}:${id || 't-' + title.toLowerCase().slice(0, 40)}`, title: title || `TMDB ${id}` };
  }
  if (path === '/api/live/stream') {
    if (q.skip || q.bad) return null; // troca de fonte: é o mesmo assistir
    const ch = CHANNELS.find((c) => c.id === clean(q.ch, 40));
    return ch ? { kind: 'live', key: `l:${ch.id}`, title: ch.name } : null;
  }
  return null;
}

function bump(map, mapKey, base, add) {
  let r = map.get(mapKey);
  if (!r) { r = { day: base.day, kind: base.kind, key: base.key, title: '', watches: 0, viewers: 0, last_at: 0 }; map.set(mapKey, r); }
  r.watches += add.watches || 0;
  r.viewers += add.viewers || 0;
  if (add.title) r.title = add.title;
  r.last_at = Math.max(r.last_at, add.at || 0);
}

function record(req, now = Date.now()) {
  if (String(process.env.VISITORS_OFF || '') === '1') return null;
  let c;
  try { c = classify(req); } catch (err) { return null; }
  if (!c) return null;
  const headers = req.headers || {};
  if (visitors.isBot(headers['user-agent'])) return null;
  const ip = visitors.clientIp(req);
  if (!ip || geo.isPrivate(ip)) return null;

  const who = `${visitors.visitorId(ip)}|${c.kind}:${c.key}`;
  const last = seen.get(who) || 0;
  seen.set(who, now);
  if (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
  const again = now - last < SESSION_MS;
  const day = isoDay(now);
  const newViewer = seenDay.get(who) !== day;
  if (newViewer) { seenDay.set(who, day); if (seenDay.size > MAX_SEEN) seenDay.delete(seenDay.keys().next().value); }
  if (again && !newViewer) return null;

  const add = { watches: again ? 0 : 1, viewers: newViewer ? 1 : 0, title: c.title, at: now };
  let rows = local.get(day);
  if (!rows) {
    rows = new Map();
    local.set(day, rows);
    for (const old of [...local.keys()]) if (old < isoDay(now - 40 * DAY_MS)) local.delete(old);
  }
  if (rows.size < MAX_ROWS_PER_DAY || rows.has(`${c.kind}|${c.key}`)) bump(rows, `${c.kind}|${c.key}`, { day, ...c }, add);
  if (store.enabled()) {
    bump(pending, `${c.kind}|${c.key}|${day}`, { day, ...c }, add);
    scheduleFlush();
  }
  return add;
}

/* ------------------------------ Supabase ------------------------------ */

function scheduleFlush() {
  if (!store.enabled() || flushTimer || flushing) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref();
}

const payload = (map) => [...map.values()].map((r) => ({
  day: r.day, kind: r.kind, key: r.key, title: r.title, watches: r.watches, viewers: r.viewers, last_at: new Date(r.last_at || Date.now()).toISOString()
}));

function mergeInto(target, src) {
  for (const [k, r] of src) bump(target, k, r, { watches: r.watches, viewers: r.viewers, title: r.title, at: r.last_at });
}

async function flush() {
  if (!store.enabled() || flushing || !pending.size) return { ok: true, sent: 0 };
  flushing = true;
  inflight = pending;
  pending = new Map();
  const count = inflight.size;
  try {
    await store.call('POST', '/rpc/fdsflix_add_watches', { p_rows: payload(inflight) }, undefined, { quiet: true });
    inflight = new Map();
    sync.lastFlushAt = Date.now();
    sync.lastError = '';
    sync.tablesMissing = false;
    readCache = { at: 0, since: '', rows: null };
    await pruneOld().catch(() => {});
    return { ok: true, sent: count };
  } catch (err) {
    mergeInto(pending, inflight); // não perde nada: soma de volta e tenta no próximo ciclo
    inflight = new Map();
    sync.lastError = err.message;
    sync.tablesMissing = Boolean(err.tablesMissing);
    return { ok: false, sent: 0, error: err.message };
  } finally {
    flushing = false;
    if (pending.size) scheduleFlush();
  }
}

async function pruneOld() {
  const today = isoDay(Date.now());
  if (lastPruneDay === today) return;
  await store.call('DELETE', `/watch_daily?day=lt.${encodeURIComponent(isoDay(Date.now() - KEEP_DAYS * DAY_MS))}`, undefined, { Prefer: 'return=minimal' }, { quiet: true });
  lastPruneDay = today;
}

async function fetchRows(sinceDay) {
  const rows = [];
  for (let offset = 0; offset < 50000; offset += PAGE) {
    const page = await store.call('GET',
      `/watch_daily?select=day,kind,key,title,watches,viewers,last_at&day=gte.${encodeURIComponent(sinceDay)}&order=day.asc,kind.asc,key.asc&limit=${PAGE}&offset=${offset}`,
      undefined, undefined, { quiet: true });
    for (const r of page || []) {
      rows.push({ day: String(r.day).slice(0, 10), kind: r.kind, key: r.key, title: r.title || '', watches: Number(r.watches) || 0, viewers: Number(r.viewers) || 0, last_at: Date.parse(r.last_at) || 0 });
    }
    if (!page || page.length < PAGE) break;
  }
  return rows;
}

async function loadRows(sinceDay) {
  const map = new Map();
  if (store.enabled()) {
    if (!readCache.rows || readCache.since !== sinceDay || Date.now() - readCache.at > READ_CACHE_MS) {
      try {
        readCache = { at: Date.now(), since: sinceDay, rows: await fetchRows(sinceDay) };
        sync.lastError = '';
        sync.tablesMissing = false;
      } catch (err) {
        sync.lastError = err.message;
        sync.tablesMissing = Boolean(err.tablesMissing);
        readCache = { at: 0, since: '', rows: null };
      }
    }
    for (const r of readCache.rows || []) bump(map, `${r.kind}|${r.key}|${r.day}`, r, { watches: r.watches, viewers: r.viewers, title: r.title, at: r.last_at });
    mergeInto(map, inflight);
    mergeInto(map, pending);
  } else {
    for (const [day, rows] of local) if (day >= sinceDay) for (const [k, r] of rows) bump(map, `${k}|${day}`, r, { watches: r.watches, viewers: r.viewers, title: r.title, at: r.last_at });
  }
  return [...map.values()].filter((r) => r.day >= sinceDay);
}

/** Mais assistidos do período, por tipo. `viewers` é soma dos dias (a mesma pessoa em dias diferentes conta de novo). */
async function top({ days = 30, limit = 20 } = {}) {
  const span = Math.max(1, Math.min(120, Math.floor(Number(days)) || 30));
  const max = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 20));
  const since = isoDay(Date.now() - (span - 1) * DAY_MS);
  const rows = await loadRows(since);
  const by = new Map();
  const totals = { movie: 0, series: 0, live: 0 };
  for (const r of rows) {
    const id = `${r.kind}|${r.key}`;
    let t = by.get(id);
    if (!t) { t = { kind: r.kind, key: r.key, title: '', watches: 0, viewers: 0, days: new Set(), lastAt: 0 }; by.set(id, t); }
    t.watches += r.watches;
    t.viewers += r.viewers;
    t.days.add(r.day);
    if (r.last_at >= t.lastAt && r.title) { t.title = r.title; t.lastAt = r.last_at; }
    if (totals[r.kind] != null) totals[r.kind] += r.watches;
  }
  const lists = { movie: [], series: [], live: [] };
  for (const t of by.values()) {
    if (lists[t.kind]) lists[t.kind].push({ key: t.key, title: t.title || t.key, watches: t.watches, viewers: t.viewers, days: t.days.size, lastAt: t.lastAt ? new Date(t.lastAt).toISOString() : null });
  }
  for (const k of Object.keys(lists)) lists[k].sort((a, b) => b.watches - a.watches || b.viewers - a.viewers || a.title.localeCompare(b.title)).splice(max);
  return {
    days: span, since, totals, top: lists,
    storage: { provider: store.enabled() ? 'supabase' : 'memória', lastFlushAt: sync.lastFlushAt, lastError: sync.lastError, tablesMissing: sync.tablesMissing, pendingRows: pending.size + inflight.size }
  };
}

function reset() {
  local = new Map(); pending = new Map(); inflight = new Map(); seen.clear(); seenDay.clear();
  flushing = false; if (flushTimer) clearTimeout(flushTimer); flushTimer = null; lastPruneDay = '';
  readCache = { at: 0, since: '', rows: null };
  sync.lastFlushAt = null; sync.lastError = ''; sync.tablesMissing = false;
}

module.exports = { record, classify, top, flush, reset };
