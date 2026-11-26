'use strict';

/**
 * fdsFlix - Falhas de reprodução e uso de cada fonte (só o administrador vê).
 *
 * Duas coisas:
 *   1. FALHAS: qual título, quando, em que etapa, por que e quais fontes foram tentadas. O servidor registra a busca
 *      que não entregou (404/503/502 do /api/stream); o navegador conta o que só ele sabe (erro do player, vídeo que
 *      nunca começou, "Outra versão", torrent). Se o mesmo aparelho conseguir tocar o título em até 15 min, a falha
 *      fica marcada como "depois tocou por <fonte>".
 *   2. FONTES: por dia/visitante/fonte, quantas vezes o link foi entregue, quantas o vídeo tocou e quantas deu problema.
 *
 * Vai ao Supabase em lote (supabase/play-reports-schema.sql). Sem a tabela ou sem Supabase o site segue normal e tudo
 * fica só em memória (zera quando o servidor reinicia). Nenhuma env nova. VISITORS_OFF=1 desliga junto dos acessos.
 * O navegador manda só o id opaco da fonte (`src`); o nome é resolvido aqui, para o público nunca ver nome de provedor.
 */

const crypto = require('crypto');
const store = require('./usageStore');
const visitors = require('./visitors');

const DAY_MS = 86400000;
const FLUSH_MS = 10000;
const READ_CACHE_MS = 15000;
const KEEP_ERRORS_DAYS = 30;
const KEEP_USE_DAYS = 90;
const DUP_MS = 2 * 60000;          // mesma falha repetida (ex.: o front insiste no 503) conta 1x
const RESOLVE_MS = 15 * 60000;     // tocou até aqui depois da falha = resolvida
const PLAY_MS = 30 * 60000;        // recarregar o mesmo vídeo não infla o uso
const RATE_WINDOW_MS = 10 * 60000;
const RATE_MAX = 80;
const MAX_MEMORY_ERRORS = 500;
const MAX_PENDING = 2000;
const MAX_KEYS = 20000;
const PAGE = 1000;
const STAGES = new Set(['player', 'espera', 'troca', 'rede', 'torrent']);

let errors = new Map();      // id -> falha (memória: base da lista sem Supabase e da marca "depois tocou")
let dirty = new Map();       // id -> falha a enviar (upsert)
let usage = new Map();       // dia|visitante|fonte -> linha (memória)
let pendingUse = new Map();  // delta a enviar
const lastDup = new Map();
const lastPlay = new Map();
const lastCtx = new Map();   // visitante|título -> { source, trace } da última busca
const traces = new Map();    // título -> trace da busca que está rodando (quem pegou carona não roda o handler)
const rate = new Map();
let flushing = false;
let flushTimer = null;
let lastPruneDay = '';
let readCache = { at: 0, days: 0, data: null };
const sync = { lastFlushAt: null, lastError: '', tablesMissing: false };

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const disabled = () => /^(1|true|yes)$/i.test(String(process.env.VISITORS_OFF || ''));

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f<>"'`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Tira query string e trechos com cara de token: o motivo é para diagnóstico, não para guardar links assinados. */
function scrub(value, max) {
  return clean(String(value == null ? '' : value)
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1?…')
    .replace(/[A-Za-z0-9_-]{40,}/g, '…'), max);
}

function setCapped(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_KEYS) map.delete(map.keys().next().value);
}

/** Quem fez a requisição, ou null se for robô. */
function who(req) {
  const ua = (req.headers || {})['user-agent'];
  if (visitors.isBot(ua)) return null;
  const ip = visitors.clientIp(req);
  return ip ? { visitor: visitors.visitorId(ip), device: visitors.parseDevice(ua) } : null;
}

function titleOf(q) {
  const series = String(q.type || '') === 'tv';
  const id = /^\d{1,10}$/.test(String(q.id || '')) ? String(q.id) : '';
  if (!id) return null;
  const season = series ? Math.max(1, Math.min(999, Math.floor(Number(q.s)) || 1)) : 0;
  const episode = series ? Math.max(1, Math.min(9999, Math.floor(Number(q.e)) || 1)) : 0;
  return {
    kind: series ? 'series' : 'movie',
    tmdbId: id,
    season,
    episode,
    title: clean(q.title, 90) || `TMDB ${id}`,
    key: series ? `tv:${id}:${season}x${episode}` : `movie:${id}`
  };
}

function compactTrace(trace) {
  // As linhas de legenda não são fonte de vídeo: ficam fora.
  return (Array.isArray(trace) ? trace : []).filter((t) => !/^Legendas/.test(String(t && t.provider))).slice(0, 30).map((t) => ({
    p: clean(t && t.provider, 40),
    o: clean(t && t.outcome, 20),
    ms: Math.max(0, Math.round(Number(t && t.ms) || 0)),
    n: scrub((Array.isArray(t && t.notes) ? t.notes : []).filter((n) => !/^nós:/.test(String(n))).slice(-2).join(' · '), 220)
  })).filter((t) => t.p);
}

const sourceName = (provider, via) => {
  const name = clean(provider, 50);
  return name && via === 'adshield' ? `${name} · via nó` : name;
};

/* ------------------------------ registro ------------------------------ */

function addUse(visitor, source, add, now) {
  if (!source) return;
  const day = isoDay(now);
  const key = `${day}|${visitor}|${source}`;
  for (const map of store.enabled() ? [usage, pendingUse] : [usage]) {
    let r = map.get(key);
    if (!r) {
      if (map.size >= MAX_KEYS) map.delete(map.keys().next().value);
      r = { day, visitor, source, delivered: 0, plays: 0, fails: 0, last_at: 0 };
      map.set(key, r);
    }
    r.delivered += add.delivered || 0;
    r.plays += add.plays || 0;
    r.fails += add.fails || 0;
    r.last_at = Math.max(r.last_at, now);
  }
  scheduleFlush();
}

function markDirty(row) {
  if (!store.enabled()) return;
  dirty.set(row.id, row);
  while (dirty.size > MAX_PENDING) dirty.delete(dirty.keys().next().value);
  scheduleFlush();
}

function addError(person, t, data, now) {
  const dup = `${person.visitor}|${t.key}|${data.stage}|${data.source}|${data.reason}`;
  if (now - (lastDup.get(dup) || 0) < DUP_MS) return null;
  setCapped(lastDup, dup, now);
  const row = {
    id: `${now.toString(36)}-${crypto.randomBytes(5).toString('hex')}`,
    at: now, visitor: person.visitor, device: person.device,
    kind: t.kind, title_key: t.key, tmdb_id: t.tmdbId, title: t.title, season: t.season, episode: t.episode,
    stage: data.stage, source: data.source || '', status: data.status || 0,
    reason: data.reason, detail: data.detail || '', trace: data.trace || [],
    admin: Boolean(data.admin), resolved_by: '', resolved_at: 0
  };
  errors.set(row.id, row);
  while (errors.size > MAX_MEMORY_ERRORS) errors.delete(errors.keys().next().value);
  markDirty(row);
  return row;
}

const SERVER_REASONS = {
  404: 'Nenhuma fonte encontrou este título',
  502: 'Erro no servidor ao preparar o vídeo',
  503: 'As fontes estavam fora do ar (ou só entregariam pelo Render)'
};

/**
 * Resposta do /api/stream. `play` = { provider, error, trace } vindo do handler (quem pegou carona num pedido igual
 * não tem: usa o trace que o primeiro deixou). `nameOfSrc` traduz o id opaco da resposta pública.
 */
function onStreamResponse(req, { status, body, play, nameOfSrc, admin }, now = Date.now()) {
  if (disabled() || (req.query || {}).probe) return null; // consulta do player lento, não é um pedido de verdade
  const t = titleOf(req.query || {});
  const person = who(req);
  if (!t || !person) return null;
  const info = play || {};
  if (info.trace) setCapped(traces, t.key, { at: now, trace: compactTrace(info.trace), error: scrub(info.error, 600) });
  const shared = traces.get(t.key);
  const fresh = shared && now - shared.at < 90000 ? shared : null;
  const trace = fresh ? fresh.trace : [];
  const b = body || {};

  if (status < 400 && b.url) {
    const source = sourceName(info.provider || b.provider || (nameOfSrc && nameOfSrc(b.src)), b.via);
    setCapped(lastCtx, `${person.visitor}|${t.key}`, { at: now, source, trace });
    addUse(person.visitor, source, { delivered: 1 }, now);
    return null;
  }
  if (status !== 404 && status !== 502 && status !== 503) return null;
  setCapped(lastCtx, `${person.visitor}|${t.key}`, { at: now, source: '', trace });
  return addError(person, t, {
    stage: 'busca', source: '', status, admin,
    // Com `skip` a busca já excluía a versão descartada: o que faltou foi uma segunda opção.
    reason: (req.query || {}).skip && status !== 502 ? 'Não havia outra versão além da descartada' : SERVER_REASONS[status],
    detail: (fresh && fresh.error) || scrub(b.error, 600),
    trace
  }, now);
}

function allowed(visitor, now) {
  const r = rate.get(visitor);
  if (!r || now - r.since > RATE_WINDOW_MS) { setCapped(rate, visitor, { since: now, n: 1 }); return true; }
  r.n += 1;
  return r.n <= RATE_MAX;
}

/**
 * Aviso do navegador: { event: 'ok'|'fail'|'embed', type, id, s, e, title, src, via, engine, embed, stage, reason, detail }.
 */
function onClientReport(req, { nameOfSrc, admin } = {}, now = Date.now()) {
  if (disabled()) return { ok: true, ignored: true };
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const t = titleOf(body);
  const person = who(req);
  if (!t || !person) return { ok: false };
  if (!allowed(person.visitor, now)) return { ok: false, limited: true };

  const ctxKey = `${person.visitor}|${t.key}`;
  const ctx = lastCtx.get(ctxKey) || { source: '', trace: [] };
  let source = '';
  if (body.engine === 'torrent') source = 'Torrent';
  else if (body.event === 'embed') source = `Player externo: ${clean(body.embed, 24) || '?'}`;
  else if (/^[0-9a-f]{6}$/.test(String(body.src || ''))) source = sourceName(nameOfSrc && nameOfSrc(body.src), body.via);

  if (body.event === 'ok' || body.event === 'embed') {
    if (!source) return { ok: true, ignored: true };
    const playKey = `${ctxKey}|${source}`;
    if (now - (lastPlay.get(playKey) || 0) >= PLAY_MS) {
      setCapped(lastPlay, playKey, now);
      addUse(person.visitor, source, { plays: 1 }, now);
    }
    // O iframe externo não dá para confirmar que tocou: não marca nada como resolvido.
    if (body.event === 'ok') {
      for (const row of errors.values()) {
        if (row.visitor !== person.visitor || row.title_key !== t.key || row.resolved_by || now - row.at > RESOLVE_MS) continue;
        row.resolved_by = source;
        row.resolved_at = now;
        markDirty(row);
      }
    }
    return { ok: true };
  }

  if (body.event !== 'fail' || !STAGES.has(body.stage)) return { ok: false };
  const row = addError(person, t, {
    stage: body.stage,
    source: source || (body.stage === 'torrent' ? 'Torrent' : ''),
    reason: scrub(body.reason, 200) || 'Falha sem descrição',
    detail: scrub(body.detail, 600),
    trace: ctx.trace,
    admin
  }, now);
  if (row && row.source) addUse(person.visitor, row.source, { fails: 1 }, now);
  return { ok: true };
}

/** Middleware do /api/stream: vem ANTES do streamGuard para ver também a resposta de quem pegou carona. */
function observeStream({ nameOfSrc, isAdmin }) {
  return (req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body) => {
      try {
        onStreamResponse(req, { status: res.statusCode || 200, body, play: res.locals && res.locals.play, nameOfSrc, admin: isAdmin(req) });
      } catch (err) { /* estatística nunca derruba o vídeo */ }
      return send(body);
    };
    next();
  };
}

/* ------------------------------ Supabase ------------------------------ */

function scheduleFlush() {
  if (!store.enabled() || flushTimer || flushing) return;
  // Tabela ainda não criada: tenta de novo com calma (o dono pode rodar o SQL a qualquer momento).
  flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, sync.tablesMissing ? 60000 : FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref();
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

async function flush() {
  if (!store.enabled() || flushing || (!dirty.size && !pendingUse.size)) return { ok: true };
  flushing = true;
  const errBatch = dirty;
  const useBatch = pendingUse;
  dirty = new Map();
  pendingUse = new Map();
  let errSent = !errBatch.size;
  let useSent = !useBatch.size;
  try {
    if (errBatch.size) {
      await store.call('POST', '/play_errors?on_conflict=id',
        [...errBatch.values()].map((r) => ({ ...r, at: iso(r.at), resolved_at: iso(r.resolved_at) })),
        { Prefer: 'resolution=merge-duplicates,return=minimal' }, { quiet: true });
      errSent = true;
    }
    if (useBatch.size) {
      await store.call('POST', '/rpc/fdsflix_add_source_use',
        { p_rows: [...useBatch.values()].map((r) => ({ ...r, last_at: iso(r.last_at) })) }, undefined, { quiet: true });
      useSent = true;
    }
    sync.lastFlushAt = Date.now();
    sync.lastError = '';
    sync.tablesMissing = false;
    readCache = { at: 0, days: 0, data: null };
    await prune().catch(() => {});
    return { ok: true };
  } catch (err) {
    // Devolve à fila só o que não subiu; o que chegou depois (mais novo) tem prioridade.
    if (!errSent) dirty = new Map([...errBatch, ...dirty]);
    if (!useSent) {
      for (const [k, r] of useBatch) {
        const n = pendingUse.get(k);
        if (!n) pendingUse.set(k, r);
        else { n.delivered += r.delivered; n.plays += r.plays; n.fails += r.fails; n.last_at = Math.max(n.last_at, r.last_at); }
      }
    }
    sync.lastError = err.message;
    sync.tablesMissing = Boolean(err.tablesMissing);
    return { ok: false, error: err.message };
  } finally {
    flushing = false;
    if (dirty.size || pendingUse.size) scheduleFlush();
  }
}

async function prune() {
  const today = isoDay(Date.now());
  if (lastPruneDay === today) return;
  await store.call('DELETE', `/play_errors?at=lt.${encodeURIComponent(isoDay(Date.now() - KEEP_ERRORS_DAYS * DAY_MS))}`, undefined, { Prefer: 'return=minimal' }, { quiet: true });
  await store.call('DELETE', `/play_source_daily?day=lt.${encodeURIComponent(isoDay(Date.now() - KEEP_USE_DAYS * DAY_MS))}`, undefined, { Prefer: 'return=minimal' }, { quiet: true });
  lastPruneDay = today;
}

async function fetchStored(sinceDay) {
  const errRows = await store.call('GET', `/play_errors?select=*&at=gte.${encodeURIComponent(sinceDay)}&order=at.desc&limit=${PAGE}`, undefined, undefined, { quiet: true });
  const useRows = [];
  for (let offset = 0; offset < 50000; offset += PAGE) {
    const page = await store.call('GET',
      `/play_source_daily?select=day,visitor,source,delivered,plays,fails,last_at&day=gte.${encodeURIComponent(sinceDay)}&order=day.asc,visitor.asc,source.asc&limit=${PAGE}&offset=${offset}`,
      undefined, undefined, { quiet: true });
    useRows.push(...(page || []));
    if (!page || page.length < PAGE) break;
  }
  return {
    errors: (errRows || []).map((r) => ({ ...r, at: Date.parse(r.at) || 0, resolved_at: Date.parse(r.resolved_at) || 0 })),
    usage: useRows.map((r) => ({
      day: String(r.day).slice(0, 10), visitor: String(r.visitor), source: String(r.source),
      delivered: Number(r.delivered) || 0, plays: Number(r.plays) || 0, fails: Number(r.fails) || 0, last_at: Date.parse(r.last_at) || 0
    }))
  };
}

async function loadRows(days, sinceDay) {
  let fromStore = null;
  if (store.enabled()) {
    if (!readCache.data || readCache.days !== days || Date.now() - readCache.at > READ_CACHE_MS) {
      try {
        readCache = { at: Date.now(), days, data: await fetchStored(sinceDay) };
        sync.lastError = '';
        sync.tablesMissing = false;
      } catch (err) {
        sync.lastError = err.message;
        sync.tablesMissing = Boolean(err.tablesMissing);
        readCache = { at: 0, days: 0, data: null };
      }
    }
    fromStore = readCache.data;
  }
  if (!fromStore) {
    // Sem Supabase (ou tabela ainda não criada): vale o que está na memória deste processo.
    return { errors: [...errors.values()], usage: [...usage.values()] };
  }
  const errMap = new Map(fromStore.errors.map((r) => [r.id, r]));
  for (const r of dirty.values()) errMap.set(r.id, r);
  const useMap = new Map(fromStore.usage.map((r) => [`${r.day}|${r.visitor}|${r.source}`, { ...r }]));
  for (const [k, r] of pendingUse) {
    const have = useMap.get(k);
    if (!have) useMap.set(k, { ...r });
    else { have.delivered += r.delivered; have.plays += r.plays; have.fails += r.fails; have.last_at = Math.max(have.last_at, r.last_at); }
  }
  return { errors: [...errMap.values()], usage: [...useMap.values()] };
}

/* ------------------------------ relatório ------------------------------ */

const pct = (part, total) => (total ? Math.round((part / total) * 1000) / 10 : 0);

async function report({ days = 7 } = {}) {
  const span = Math.max(1, Math.min(90, Math.floor(Number(days)) || 7));
  const since = isoDay(Date.now() - (span - 1) * DAY_MS);
  const data = await loadRows(span, since);

  const bySource = new Map();
  const byVisitor = new Map();
  let totalPlays = 0;
  let totalDelivered = 0;
  for (const r of data.usage) {
    if (r.day < since) continue;
    let s = bySource.get(r.source);
    if (!s) { s = { source: r.source, plays: 0, delivered: 0, fails: 0, lastAt: 0 }; bySource.set(r.source, s); }
    s.plays += r.plays;
    s.delivered += r.delivered;
    s.fails += r.fails;
    s.lastAt = Math.max(s.lastAt, r.last_at);
    totalPlays += r.plays;
    totalDelivered += r.delivered;
    if (r.plays) {
      let v = byVisitor.get(r.visitor);
      if (!v) { v = { total: 0, last: '', lastAt: 0, sources: new Map() }; byVisitor.set(r.visitor, v); }
      v.total += r.plays;
      v.sources.set(r.source, (v.sources.get(r.source) || 0) + r.plays);
      if (r.last_at >= v.lastAt) { v.lastAt = r.last_at; v.last = r.source; }
    }
  }

  const sources = [...bySource.values()]
    .sort((a, b) => b.plays - a.plays || b.delivered - a.delivered || a.source.localeCompare(b.source))
    .map((s) => ({
      ...s,
      pct: pct(s.plays, totalPlays),
      // Das vezes em que se soube o desfecho, quantas deram certo.
      successPct: s.plays + s.fails ? pct(s.plays, s.plays + s.fails) : null,
      lastAt: iso(s.lastAt)
    }));

  const list = data.errors.filter((r) => isoDay(r.at) >= since).sort((a, b) => b.at - a.at);
  const titles = new Map();
  for (const r of list) {
    let t = titles.get(r.title_key);
    if (!t) { t = { key: r.title_key, title: r.title, kind: r.kind, season: r.season, episode: r.episode, count: 0, unresolved: 0, lastAt: r.at, lastReason: r.reason }; titles.set(r.title_key, t); }
    t.count += 1;
    if (!r.resolved_by) t.unresolved += 1;
  }

  const visitorsOut = {};
  const seat = (id) => visitorsOut[id] || (visitorsOut[id] = { last: '', sources: [], errors: 0, unresolved: 0, lastError: '' });
  for (const [id, v] of byVisitor) {
    const out = seat(id);
    out.last = v.last;
    out.sources = [...v.sources.entries()].sort((a, b) => b[1] - a[1]).map(([source, n]) => ({ source, plays: n, pct: pct(n, v.total) }));
  }
  for (const r of list) { // já vem da mais nova para a mais antiga
    const out = seat(r.visitor);
    out.errors += 1;
    if (!r.resolved_by) out.unresolved += 1;
    if (!out.lastError) out.lastError = `${r.title}: ${r.reason}`;
  }

  return {
    generatedAt: new Date().toISOString(),
    days: span,
    totals: { plays: totalPlays, delivered: totalDelivered, errors: list.length, unresolved: list.filter((r) => !r.resolved_by).length },
    sources,
    titles: [...titles.values()].sort((a, b) => b.unresolved - a.unresolved || b.count - a.count || b.lastAt - a.lastAt).slice(0, 50)
      .map((t) => ({ ...t, lastAt: iso(t.lastAt) })),
    errors: list.slice(0, 200).map((r) => ({
      at: iso(r.at), visitor: r.visitor, device: r.device, kind: r.kind, key: r.title_key, tmdbId: r.tmdb_id, title: r.title,
      season: r.season, episode: r.episode, stage: r.stage, source: r.source, status: r.status, reason: r.reason, detail: r.detail,
      trace: r.trace || [], admin: Boolean(r.admin), resolvedBy: r.resolved_by || ''
    })),
    visitors: visitorsOut,
    storage: {
      provider: store.enabled() ? 'supabase' : 'memória',
      tablesMissing: sync.tablesMissing,
      lastError: sync.lastError,
      pending: dirty.size + pendingUse.size
    }
  };
}

function reset() {
  errors = new Map(); dirty = new Map(); usage = new Map(); pendingUse = new Map();
  lastDup.clear(); lastPlay.clear(); lastCtx.clear(); traces.clear(); rate.clear();
  flushing = false; if (flushTimer) clearTimeout(flushTimer); flushTimer = null; lastPruneDay = '';
  readCache = { at: 0, days: 0, data: null };
  sync.lastFlushAt = null; sync.lastError = ''; sync.tablesMissing = false;
}

module.exports = { observeStream, onStreamResponse, onClientReport, report, flush, reset };
