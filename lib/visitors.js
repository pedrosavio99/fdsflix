'use strict';

/**
 * fdsFlix - Contador de acessos por visitante (IP): quem entrou, de onde, em que aparelho e o que assistiu.
 *
 * O QUE CONTA: abrir a página (/), buscar/listar (/api/search, /api/popular...) e pedir vídeo (/api/stream).
 * Não conta: bots, health check, rotas internas (/api/usage, /api/visitors, /api/pool). O envio periódico do
 * player (POST /api/usage) só marca "online agora", sem somar acesso.
 *
 * MODELO: uma linha por DIA (UTC) e por visitante: { requests, watches, first_at, last_at, país/cidade/provedor,
 * dispositivo, último título }. Vai para o Supabase em lote (supabase/visitors-schema.sql). Sem Supabase,
 * funciona só em memória (zera a cada reinício do Render).
 *
 * PRIVACIDADE: IP é dado pessoal (LGPD). Por isso:
 *   - quem lê é só quem tem a chave (STATS_KEY ou API_KEY); sem nenhuma das duas a rota fica desligada;
 *   - linhas com mais de VISITORS_KEEP_DAYS dias (padrão 90) são apagadas;
 *   - VISITORS_HASH_IP=1 guarda um hash do IP em vez do IP (a contagem de pessoas continua valendo).
 *
 * Variáveis (todas opcionais): STATS_KEY, VISITORS_HASH_IP, VISITORS_KEEP_DAYS, GEO_API_URL (lib/geo.js),
 * VISITORS_OFF=1 (desliga a coleta).
 */

const crypto = require('crypto');
const { CHANNELS } = require('./liveChannels');
const liveEpg = require('./liveEpg');
const net = require('net');
const store = require('./usageStore');
const geo = require('./geo');

const DAY_MS = 86400000;
const ONLINE_MS = 5 * 60000;
const FLUSH_MS = 30000;
const READ_CACHE_MS = 20000;
const MAX_PER_DAY = 20000;     // teto de visitantes/dia em memória (IPs forjados não estouram a RAM)
const MAX_ONLINE = 20000;
const MAX_LIST = 300;
const PAGE = 1000;

const FIELDS = 'day,visitor,country,region,city,isp,device,requests,watches,first_at,last_at,last_watch';

// local[dia] = Map(visitor -> linha). pending/inflight[dia|visitor] = o que ainda não foi ao Supabase.
let local = new Map();
let pending = new Map();
let inflight = new Map();
const online = new Map();      // visitor -> último sinal (ms)
let flushing = false;
let flushTimer = null;
let lastPruneDay = '';
let readCache = { at: 0, since: '', rows: null };
const sync = { lastFlushAt: null, lastError: '', tablesMissing: false, warmed: false };

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function disabled() {
  return /^(1|true|yes)$/i.test(String(process.env.VISITORS_OFF || ''));
}

function keepDays() {
  const n = Math.floor(Number(process.env.VISITORS_KEEP_DAYS));
  return Number.isFinite(n) && n >= 7 ? Math.min(n, 3650) : 90;
}

/* ------------------------------ IP, aparelho, bots ------------------------------ */

function normalizeIp(value) {
  let ip = String(value || '').trim().replace(/^\[|\]$/g, '');
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const zone = ip.indexOf('%');
  if (zone > 0) ip = ip.slice(0, zone);
  return net.isIP(ip) ? ip.toLowerCase() : '';
}

/**
 * IP do visitante. No Render a requisição passa pela Cloudflare, que PREENCHE cf-connecting-ip /
 * true-client-ip por cima do que o cliente mandar; só depois vem o X-Forwarded-For. Quem acessa direto,
 * sem a borda, poderia forjar esses cabeçalhos: isso só inflaria a estatística, não dá acesso a nada.
 */
function clientIp(req) {
  const h = (req && req.headers) || {};
  const candidates = [
    h['cf-connecting-ip'],
    h['true-client-ip'],
    String(h['x-forwarded-for'] || '').split(',')[0],
    req && req.ip,
    req && req.socket && req.socket.remoteAddress
  ];
  for (const c of candidates) {
    const ip = normalizeIp(c);
    if (ip) return ip;
  }
  return '';
}

function isBot(ua) {
  const s = String(ua || '');
  if (s.length < 10) return true; // sem user-agent de navegador de verdade
  // "bot" só como palavra ou sufixo de nome/versão (Googlebot/2.1), para não pegar aparelhos como o Cubot.
  return /\bbot\b|[a-z]bot\/|crawl|spider|slurp|monitor|uptime|pingdom|headless|lighthouse|curl\/|wget|python-requests|python-urllib|aiohttp|axios|node-fetch|undici|go-http|java\/|facebookexternalhit|render\//i.test(s);
}

/** "Android · Chrome", "iPhone · Safari", "Windows · Edge", "TV · Navegador"... (só o essencial). */
function parseDevice(ua) {
  const s = String(ua || '');
  let os = 'Outro';
  if (/smart-?tv|tizen|web0s|webos|hbbtv|appletv|crkey|bravia|aftb|aftt|firetv|roku|vidaa|netcast/i.test(s)) os = 'TV';
  else if (/iphone/i.test(s)) os = 'iPhone';
  else if (/ipad/i.test(s)) os = 'iPad';
  else if (/android/i.test(s)) os = 'Android';
  else if (/windows/i.test(s)) os = 'Windows';
  else if (/cros/i.test(s)) os = 'ChromeOS';
  else if (/mac os x|macintosh/i.test(s)) os = 'macOS';
  else if (/linux|x11/i.test(s)) os = 'Linux';

  let browser = 'Navegador';
  if (/edg(e|a|ios)?\//i.test(s)) browser = 'Edge';
  else if (/opr\/|opera/i.test(s)) browser = 'Opera';
  else if (/samsungbrowser/i.test(s)) browser = 'Samsung Internet';
  else if (/firefox|fxios/i.test(s)) browser = 'Firefox';
  else if (/chrome|crios|chromium/i.test(s)) browser = 'Chrome';
  else if (/safari/i.test(s)) browser = 'Safari';
  return `${os} · ${browser}`;
}

function visitorId(ip) {
  if (!/^(1|true|yes)$/i.test(String(process.env.VISITORS_HASH_IP || ''))) return ip;
  const secret = String(process.env.STATS_KEY || process.env.API_KEY || 'fdsflix-visitors');
  return 'h_' + crypto.createHmac('sha256', secret).update(ip).digest('hex').slice(0, 20);
}

const EXCLUDED = ['/api/health', '/api/usage', '/api/visitors', '/api/pool', '/api/admin', '/api/egress', '/api/diag', '/api/debug'];

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f<>"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** O que esta requisição significa: { count, watch } (soma acesso), { touch } (só "online") ou null (ignora). */
function classify(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const path = String(req.path || req.url || '').split('?')[0];
  if (method === 'POST' && path === '/api/usage') return { count: false, watch: '', touch: true };
  if (method !== 'GET') return null;
  if (path === '/' || path === '/index.html') return { count: true, watch: '' };
  if (!path.startsWith('/api/') || EXCLUDED.some((p) => path === p || path.startsWith(p + '/'))) return null;
  if (path === '/api/stream') {
    const q = req.query || {};
    const type = String(q.type || '') === 'tv' ? 'tv' : 'movie';
    const id = /^\d+$/.test(String(q.id || '')) ? String(q.id) : '';
    const title = cleanText(q.title, 70) || (id ? `TMDB ${id}` : 'vídeo');
    const ep = type === 'tv' ? ` T${Math.max(1, Number(q.s) || 1)}E${Math.max(1, Number(q.e) || 1)}` : '';
    return { count: true, watch: `${title}${ep}`.slice(0, 100) };
  }
  if (path === '/api/live/stream') {
    // TV ao vivo: "TV · Canal — programa no ar". Só a primeira chamada de cada vez que o canal é aberto conta como "assistiu";
    // as seguintes (troca de fonte: skip/bad) são o mesmo assistir.
    const q = req.query || {};
    if (q.skip || q.bad) return { count: true, watch: '' };
    const id = cleanText(q.ch, 40);
    const channel = CHANNELS.find((c) => c.id === id);
    if (!channel) return { count: true, watch: '' };
    let program = '';
    try { const e = liveEpg.nowNext()[id]; program = e && e.now ? cleanText(e.now.t, 50) : ''; } catch (err) { program = ''; }
    return { count: true, watch: `TV · ${channel.name}${program ? ' — ' + program : ''}`.slice(0, 100) };
  }
  return { count: true, watch: '' };
}

/* ------------------------------ registro ------------------------------ */

function newRow(day, id, now) {
  return {
    day, visitor: id, country: '', region: '', city: '', isp: '', device: '',
    requests: 0, watches: 0, first_at: now, last_at: now, last_watch: ''
  };
}

function fillGeo(row, g) {
  if (!g) return;
  if (!row.country && g.country) row.country = g.country;
  if (!row.region && g.region) row.region = g.region;
  if (!row.city && g.city) row.city = g.city;
  if (!row.isp && g.isp) row.isp = g.isp;
}

function pendingRow(day, id, now) {
  const key = `${day}|${id}`;
  let row = pending.get(key);
  if (!row) {
    row = newRow(day, id, now);
    pending.set(key, row);
  }
  return row;
}

function scheduleFlush() {
  if (!store.enabled() || flushTimer || flushing) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {});
  }, FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref();
}

function applyGeoLater(ip, day, id) {
  geo.lookup(ip).then((g) => {
    if (!g) return;
    const row = local.get(day) && local.get(day).get(id);
    if (row) fillGeo(row, g);
    if (store.enabled()) {
      fillGeo(pendingRow(day, id, Date.now()), g);
      scheduleFlush();
    }
  }).catch(() => {});
}

/**
 * Chamado a cada requisição (barato, síncrono). Nunca lança. Devolve a linha do dia ou null se ignorou.
 */
function record(req, now = Date.now()) {
  if (disabled()) return null;
  let cls;
  try { cls = classify(req); } catch (err) { return null; }
  if (!cls) return null;
  const headers = req.headers || {};
  if (isBot(headers['user-agent'])) return null;
  const ip = clientIp(req);
  // Loopback/rede privada = o próprio servidor falando com ele mesmo (ex.: fluxo de stream), não uma pessoa.
  if (!ip || geo.isPrivate(ip)) return null;
  const id = visitorId(ip);

  if (online.size >= MAX_ONLINE) {
    for (const [k, at] of online) if (now - at > ONLINE_MS) online.delete(k);
    if (online.size >= MAX_ONLINE) online.delete(online.keys().next().value);
  }
  online.set(id, now);
  if (!cls.count) return null;

  const day = isoDay(now);
  let rows = local.get(day);
  if (!rows) {
    rows = new Map();
    local.set(day, rows);
    for (const old of [...local.keys()]) if (old < isoDay(now - 3 * DAY_MS)) local.delete(old); // guarda só 3 dias
  }
  let row = rows.get(id);
  if (!row) {
    if (rows.size >= MAX_PER_DAY) return null;
    row = newRow(day, id, now);
    rows.set(id, row);
  }
  const device = parseDevice(headers['user-agent']);
  const persist = store.enabled();
  const p = persist ? pendingRow(day, id, now) : null;

  row.requests += 1;
  row.last_at = now;
  if (!row.device) row.device = device;
  if (cls.watch) { row.watches += 1; row.last_watch = cls.watch; }
  if (p) {
    p.requests += 1;
    p.last_at = now;
    p.first_at = Math.min(p.first_at, now);
    if (!p.device) p.device = device;
    if (cls.watch) { p.watches += 1; p.last_watch = cls.watch; }
  }

  if (!row.country) {
    const known = geo.peek(ip);
    if (known) {
      fillGeo(row, known);
      if (p) fillGeo(p, known);
    } else if (known === undefined && !geo.isPrivate(ip)) {
      applyGeoLater(ip, day, id);
    }
  }
  if (persist) scheduleFlush();
  return row;
}

/* ------------------------------ Supabase ------------------------------ */

const toIso = (ms) => new Date(ms).toISOString();

function payload(map) {
  return [...map.values()].map((r) => ({
    day: r.day, visitor: r.visitor, country: r.country, region: r.region, city: r.city, isp: r.isp,
    device: r.device, requests: r.requests, watches: r.watches,
    first_at: toIso(r.first_at), last_at: toIso(r.last_at), last_watch: r.last_watch
  }));
}

function mergeInto(target, src) {
  for (const [key, r] of src) {
    const t = target.get(key);
    if (!t) { target.set(key, { ...r }); continue; }
    t.requests += r.requests;
    t.watches += r.watches;
    t.first_at = Math.min(t.first_at, r.first_at);
    t.last_at = Math.max(t.last_at, r.last_at);
    fillGeo(t, r);
    if (!t.device && r.device) t.device = r.device;
    if (r.last_watch) t.last_watch = r.last_watch;
  }
}

/** Envia o que falta ao Supabase (1 chamada com todas as linhas). Em falha, devolve para a fila. */
async function flush() {
  if (!store.enabled() || flushing || !pending.size) return { ok: true, sent: 0 };
  flushing = true;
  inflight = pending;
  pending = new Map();
  const count = inflight.size;
  try {
    await store.call('POST', '/rpc/fdsflix_add_visits', { p_rows: payload(inflight) }, undefined, { quiet: true });
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
  const before = isoDay(Date.now() - keepDays() * DAY_MS);
  await store.call('DELETE', `/visitor_daily?day=lt.${encodeURIComponent(before)}`, undefined, { Prefer: 'return=minimal' }, { quiet: true });
  lastPruneDay = today;
}

async function fetchRows(sinceDay) {
  const rows = [];
  for (let offset = 0; offset < 50000; offset += PAGE) {
    const page = await store.call(
      'GET',
      `/visitor_daily?select=${FIELDS}&day=gte.${encodeURIComponent(sinceDay)}&order=day.asc,visitor.asc&limit=${PAGE}&offset=${offset}`,
      undefined, undefined, { quiet: true }
    );
    for (const r of page || []) {
      rows.push({
        day: String(r.day).slice(0, 10), visitor: String(r.visitor),
        country: r.country || '', region: r.region || '', city: r.city || '', isp: r.isp || '',
        device: r.device || '', requests: Number(r.requests) || 0, watches: Number(r.watches) || 0,
        first_at: Date.parse(r.first_at) || 0, last_at: Date.parse(r.last_at) || 0, last_watch: r.last_watch || ''
      });
    }
    if (!page || page.length < PAGE) break;
  }
  return rows;
}

/** Linhas do período: Supabase + o que ainda não subiu; sem Supabase, só a memória deste processo. */
async function loadRows(sinceDay) {
  const map = new Map();
  if (store.enabled()) {
    if (!readCache.rows || readCache.since !== sinceDay || Date.now() - readCache.at > READ_CACHE_MS) {
      try {
        readCache = { at: Date.now(), since: sinceDay, rows: await fetchRows(sinceDay) };
        sync.lastError = '';
        sync.tablesMissing = false;
        if (!sync.warmed) seedGeo(readCache.rows);
      } catch (err) {
        sync.lastError = err.message;
        sync.tablesMissing = Boolean(err.tablesMissing);
        readCache = { at: 0, since: '', rows: null };
      }
    }
    for (const r of readCache.rows || []) map.set(`${r.day}|${r.visitor}`, { ...r });
    mergeInto(map, inflight);
    mergeInto(map, pending);
  } else {
    for (const [day, rows] of local) if (day >= sinceDay) for (const r of rows.values()) map.set(`${day}|${r.visitor}`, { ...r });
  }
  return [...map.values()].filter((r) => r.day >= sinceDay);
}

/** IPs já localizados no banco não precisam ser consultados de novo depois de um reinício. */
function seedGeo(rows) {
  sync.warmed = true;
  for (const r of rows) if (r.country && net.isIP(r.visitor)) geo.seed(r.visitor, r);
}

/* ------------------------------ estatísticas ------------------------------ */

function top(counter, limit) {
  return [...counter.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit);
}

function place(v) {
  return [v.city, v.region, v.country].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(', ');
}

async function stats(options = {}) {
  const days = Math.max(1, Math.min(90, Math.floor(Number(options.days)) || 7));
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const sinceDay = isoDay(now - (days - 1) * DAY_MS);
  const rows = await loadRows(sinceDay);
  const today = isoDay(now);

  const byVisitor = new Map();
  const byDay = new Map();
  for (let i = 0; i < days; i += 1) byDay.set(isoDay(now - (days - 1 - i) * DAY_MS), { day: '', visitors: new Set(), requests: 0, watches: 0 });
  for (const [day, d] of byDay) d.day = day;

  for (const r of rows) {
    let v = byVisitor.get(r.visitor);
    if (!v) {
      v = { visitor: r.visitor, country: '', region: '', city: '', isp: '', device: '', days: new Set(), requests: 0, watches: 0, first_at: Infinity, last_at: 0, last_watch: '' };
      byVisitor.set(r.visitor, v);
    }
    fillGeo(v, r);
    if (!v.device && r.device) v.device = r.device;
    v.days.add(r.day);
    v.requests += r.requests;
    v.watches += r.watches;
    v.first_at = Math.min(v.first_at, r.first_at || Infinity);
    if (r.last_at >= v.last_at) { v.last_at = r.last_at; if (r.last_watch) v.last_watch = r.last_watch; }
    const d = byDay.get(r.day);
    if (d) { d.visitors.add(r.visitor); d.requests += r.requests; d.watches += r.watches; }
  }

  // Horário de chegada (Brasília, UTC-3 sem horário de verão): quantas visitas (visitante+dia) começaram em cada hora.
  const hours = new Array(24).fill(0);
  for (const r of rows) {
    if (Number.isFinite(r.first_at) && r.first_at > 0) hours[new Date(r.first_at - 3 * 3600000).getUTCHours()] += 1;
  }

  const countries = new Map();
  const cities = new Map();
  const devices = new Map();
  const isps = new Map();
  for (const v of byVisitor.values()) {
    countries.set(v.country || '??', (countries.get(v.country || '??') || 0) + 1);
    const c = place(v) || 'Desconhecida';
    cities.set(c, (cities.get(c) || 0) + 1);
    devices.set(v.device || 'Desconhecido', (devices.get(v.device || 'Desconhecido') || 0) + 1);
    if (v.isp) isps.set(v.isp, (isps.get(v.isp) || 0) + 1);
  }

  const todayRow = byDay.get(today) || { visitors: new Set(), requests: 0, watches: 0 };
  let onlineCount = 0;
  for (const at of online.values()) if (now - at <= ONLINE_MS) onlineCount += 1;
  let requests = 0;
  let watches = 0;
  for (const v of byVisitor.values()) { requests += v.requests; watches += v.watches; }

  const list = [...byVisitor.values()]
    .sort((a, b) => b.last_at - a.last_at)
    .slice(0, MAX_LIST)
    .map((v) => ({
      visitor: v.visitor,
      location: place(v),
      country: v.country, region: v.region, city: v.city, isp: v.isp, device: v.device,
      daysActive: v.days.size, requests: v.requests, watches: v.watches,
      firstSeen: Number.isFinite(v.first_at) ? new Date(v.first_at).toISOString() : null,
      lastSeen: v.last_at ? new Date(v.last_at).toISOString() : null,
      lastWatch: v.last_watch,
      online: online.has(v.visitor) && now - online.get(v.visitor) <= ONLINE_MS
    }));

  return {
    generatedAt: new Date(now).toISOString(),
    days,
    online: { count: onlineCount, windowMin: ONLINE_MS / 60000 },
    today: { visitors: todayRow.visitors.size, requests: todayRow.requests, watches: todayRow.watches },
    period: { visitors: byVisitor.size, requests, watches, returning: [...byVisitor.values()].filter((v) => v.days.size > 1).length },
    countries: top(countries, 15).map(([country, visitors]) => ({ country, visitors })),
    cities: top(cities, 20).map(([city, visitors]) => ({ city, visitors })),
    devices: top(devices, 12).map(([device, visitors]) => ({ device, visitors })),
    isps: top(isps, 12).map(([isp, visitors]) => ({ isp, visitors })),
    hours,
    series: [...byDay.values()].map((d) => ({ day: d.day, visitors: d.visitors.size, requests: d.requests, watches: d.watches })),
    visitors: list,
    hashed: /^(1|true|yes)$/i.test(String(process.env.VISITORS_HASH_IP || '')),
    storage: {
      supabase: store.enabled(),
      geo: geo.enabled(),
      pending: pending.size + inflight.size,
      lastFlushAt: sync.lastFlushAt ? new Date(sync.lastFlushAt).toISOString() : null,
      error: sync.lastError,
      tablesMissing: sync.tablesMissing,
      keepDays: keepDays(),
      note: store.enabled()
        ? (sync.tablesMissing ? 'Tabela não criada: rode supabase/visitors-schema.sql no SQL Editor.' : '')
        : 'Sem Supabase: os números ficam só na memória e zeram quando o servidor reinicia.'
    }
  };
}

/* ------------------------------ ciclo de vida ------------------------------ */

function init() {
  if (disabled()) return;
  if (store.enabled()) {
    const t = setTimeout(() => { stats({ days: 7 }).catch(() => {}); }, 8000); // aquece o cache de localização
    if (t.unref) t.unref();
  }
}

function reset() {
  local = new Map();
  pending = new Map();
  inflight = new Map();
  online.clear();
  flushing = false;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  lastPruneDay = '';
  readCache = { at: 0, since: '', rows: null };
  sync.lastFlushAt = null;
  sync.lastError = '';
  sync.tablesMissing = false;
  sync.warmed = false;
}

module.exports = { record, stats, flush, init, reset, clientIp, parseDevice, isBot, classify, visitorId, normalizeIp };
