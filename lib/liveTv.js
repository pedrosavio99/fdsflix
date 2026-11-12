'use strict';

/**
 * fdsFlix - TV ao vivo: cascata própria, independente da cascata de filmes.
 *
 * Fluxo de /api/live/stream?ch=<canal>:
 *   1. junta as fontes candidatas do canal (variáveis de ambiente, semente do catálogo, listas .m3u varridas);
 *   2. testa de verdade (lib/liveProbe.js: playlist + um segmento) e usa a primeira que entrega vídeo;
 *   3. decide por onde o vídeo vai, SEM passar pelo Render (limite de 5 GB/mês de saída):
 *        direct  -> HTTPS com CORS: o navegador busca direto na fonte;
 *        vercel  -> as demais: a Vercel busca e entrega (adproxy/lib/liveHls.mjs, rotas /live/hls e /live/np).
 *   4. se nenhuma Vercel serve TV ao vivo e a fonte não é direta, devolve erro claro (nunca passa vídeo pelo Render).
 *
 * Fontes que são PÁGINAS de player (HTML com anúncios; lib/liveProbe.js, LIVE_PAGE_HOSTS) entram como plano B
 * e vão pelo AdShield da Vercel (/_adshield/r/<token>), que remove os anúncios e bloqueia pop-ups.
 *
 * Fontes em MPEG-TS cru (sem playlist) são detectadas e contadas, mas ainda não tocam (hls.js só lê HLS).
 */

const crypto = require('crypto');
const { CHANNELS, CATALOG_URLS } = require('./liveChannels');
const { probeSource, fetchLimited, isPagePlayer } = require('./liveProbe');
const { BUILTIN_PROXY_SECRET } = require('../adproxy/lib/secret.js');

const OK_TTL_MS = 3 * 60 * 1000;
const FAIL_TTL_MS = 12 * 60 * 1000;
const CLIENT_BAD_TTL_MS = 2 * 60 * 1000;
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const PROBE_BATCH = 5;
const MAX_PROBES_PER_RESOLVE = 30;
const RESOLVE_BUDGET_MS = 25000;
const CATALOG_PER_CHANNEL = 40;
const CAPABILITY_TTL_MS = 10 * 60 * 1000;
const LINK_TTL_MS = 6 * 60 * 60 * 1000;

/* ------------------------------ utilidades ------------------------------- */

const byId = new Map(CHANNELS.map((c) => [c.id, c]));

function sid(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
}

/** Tira usuário, senha e token de uma URL para ela poder aparecer em log e relatório. */
function maskUrl(raw) {
  try {
    const u = new URL(raw);
    let path = u.pathname;
    const xt = path.match(/^(\/live)?\/[^/]+\/[^/]+\/(\d+)(\.\w+)?$/);
    if (xt) path = `${xt[1] || ''}/…/…/${xt[2]}${xt[3] || ''}`;
    else path = path.split('/').map((seg) => (/^[A-Za-z0-9_-]{20,}$/.test(seg) ? `${seg.slice(0, 4)}…` : seg)).join('/');
    const q = [...u.searchParams.keys()].map((k) => `${k}=…`).join('&');
    return `${u.protocol}//${u.host}${path}${q ? `?${q}` : ''}`;
  } catch (error) {
    return String(raw).slice(0, 60);
  }
}

/* Registro de eventos para a "área nerd" do administrador (anel de 300; sempre mascarado). */
const events = [];
function logEvent(type, message) {
  events.push({ t: Date.now(), type, message: String(message).slice(0, 400) });
  if (events.length > 300) events.shift();
}

function norm(value) {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/^(br|brasil|brazil|pt)\s*[:|-]\s*/, '')
    .replace(/\b(fhd|uhd|hd|sd|4k|h265|hevc|hdr|1080p?|720p?|480p?|360p?|backup|alt|\d+fps)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Lista .m3u -> [{name, url}] (só http/https). */
function parseM3u(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('#EXTINF')) continue;
    const named = lines[i].match(/tvg-name="([^"]*)"/);
    const name = (named && named[1]) || lines[i].slice(lines[i].lastIndexOf(',') + 1);
    let j = i + 1;
    while (j < lines.length && (lines[j].startsWith('#') || !lines[j].trim())) j += 1;
    const url = (lines[j] || '').trim();
    if (/^https?:\/\//i.test(url) && name.trim()) out.push({ name: name.trim(), url });
  }
  return out;
}

/** Xtream sem extensão devolve TS cru; a mesma conta costuma aceitar `.m3u8`. Tenta o HLS primeiro. */
function xtreamVariant(url) {
  return /^https?:\/\/[^/]+\/(?:live\/)?[^/]+\/[^/]+\/\d+$/.test(url) ? `${url}.m3u8` : null;
}

/**
 * Variantes HLS prováveis de uma URL que parece TS cru (o player só toca HLS). Testadas ANTES da URL original;
 * as que não existirem são descartadas pelo teste de saúde, então o custo é só uma consulta curta.
 */
function hlsVariants(url) {
  const out = [];
  const x = xtreamVariant(url);
  if (x) out.push(x);
  let u;
  try { u = new URL(url); } catch (error) { return out; }
  if (/\/mpegts$/i.test(u.pathname)) out.push(url.replace(/\/mpegts$/i, '/index.m3u8'));
  return out;
}

function envSources() {
  try {
    const raw = process.env.LIVE_SOURCES_JSON;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

/* ------------------------------- catálogos ------------------------------- */

const catalog = { at: 0, index: new Map(), loading: null, lists: 0, entries: 0 };

function catalogUrls() {
  const extra = String(process.env.LIVE_CATALOG_URLS || '').split(/[\s,;]+/).filter((u) => /^https?:\/\//i.test(u));
  return Array.from(new Set([...extra, ...CATALOG_URLS]));
}

function rank(url) {
  // https primeiro (pode tocar direto), depois porta 80, depois o resto; .m3u8 antes de TS cru.
  let u;
  try { u = new URL(url); } catch (error) { return 9; }
  const hls = /m3u8/i.test(url) ? 0 : 3;
  const proto = u.protocol === 'https:' ? 0 : (!u.port || u.port === '80') ? 1 : 2;
  return hls + proto;
}

async function loadCatalogs(fetchImpl) {
  if (/^(0|false|no)$/i.test(String(process.env.LIVE_SCAN_CATALOGS || ''))) return;
  if (catalog.loading) return catalog.loading;
  if (catalog.at && Date.now() - catalog.at < CATALOG_TTL_MS) return;
  catalog.loading = (async () => {
    const aliasToId = new Map();
    for (const c of CHANNELS) for (const a of [c.name, ...(c.aliases || [])]) aliasToId.set(norm(a), c.id);
    const index = new Map();
    const seen = new Set();
    let lists = 0;
    let entries = 0;
    await Promise.all(catalogUrls().map(async (u) => {
      try {
        const res = await fetchLimited(u, { timeoutMs: 15000, cap: 3 * 1024 * 1024, fetchImpl });
        if (res.status !== 200) return;
        lists += 1;
        for (const item of parseM3u(res.body.toString('utf8'))) {
          const id = aliasToId.get(norm(item.name));
          if (!id || seen.has(item.url)) continue;
          seen.add(item.url);
          entries += 1;
          if (!index.has(id)) index.set(id, []);
          index.get(id).push(item.url);
        }
      } catch (error) { /* lista fora do ar: segue com as outras */ }
    }));
    for (const [id, list] of index) index.set(id, list.sort((a, b) => rank(a) - rank(b)).slice(0, CATALOG_PER_CHANNEL));
    catalog.index = index;
    catalog.at = Date.now();
    catalog.lists = lists;
    catalog.entries = entries;
  })().finally(() => { catalog.loading = null; });
  return catalog.loading;
}

/* -------------------------------- candidatas ----------------------------- */

/** Fontes candidatas do canal, em ordem de preferência, sem repetição. */
function candidatesFor(id) {
  const ch = byId.get(id);
  if (!ch) return [];
  const out = [];
  const seen = new Set();
  const push = (url, origin) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, sid: sid(url), origin });
  };
  for (const u of envSources()[id] || []) {
    for (const alt of hlsVariants(String(u))) push(alt, 'env');
    push(String(u), 'env');
  }
  for (const u of ch.sources) {
    for (const alt of hlsVariants(u)) push(alt, 'seed');
    push(u, 'seed');
  }
  for (const u of catalog.index.get(id) || []) push(u, 'catalog');
  return out;
}

/* ------------------------------ cache de saúde --------------------------- */

const health = new Map(); // url -> { ok, kind, https, port, cors, at, reason, badUntil }
const inflight = new Map();

function fresh(entry) {
  if (!entry) return false;
  return Date.now() - entry.at < (entry.ok ? OK_TTL_MS : FAIL_TTL_MS);
}

function playable(entry) {
  return Boolean(
    entry && entry.ok && (entry.kind === 'hls' || entry.kind === 'hls-fmp4' || entry.kind === 'page') &&
    !(entry.badUntil && entry.badUntil > Date.now())
  );
}

async function check(url, deps = {}) {
  const cached = health.get(url);
  if (fresh(cached) && !deps.force) return cached;
  if (inflight.has(url)) return inflight.get(url);
  const job = (deps.probe || probeSource)(url, { timeoutMs: 7000, fetchImpl: deps.fetchImpl, skipHostCheck: deps.skipHostCheck })
    .then((r) => {
      const entry = { ok: r.ok, kind: r.kind, https: r.https, port: r.port, cors: r.cors, reason: r.reason || '', ms: r.ms, at: Date.now() };
      health.set(url, entry);
      logEvent('teste', `${r.ok ? 'OK ' : 'FALHOU '}${maskUrl(url)} · ${r.ok ? r.kind : r.reason} · ${r.ms}ms`);
      return entry;
    })
    .finally(() => inflight.delete(url));
  inflight.set(url, job);
  return job;
}

/** O cliente avisa que uma fonte que o servidor achou boa não tocou (geobloqueio, token por IP...). */
const id_ = (chId) => (byId.get(chId) ? byId.get(chId).name : chId);
function reportBad(chId, source) {
  const cand = candidatesFor(chId).find((c) => c.sid === source);
  if (!cand) return false;
  logEvent('navegador', `${id_(chId)}: a fonte ${source} (${maskUrl(cand.url)}) não tocou no navegador; fora da rotação por ${CLIENT_BAD_TTL_MS / 1000}s`);
  const entry = health.get(cand.url) || { ok: true, kind: 'hls', at: Date.now() };
  health.set(cand.url, { ...entry, badUntil: Date.now() + CLIENT_BAD_TTL_MS });
  return true;
}

/* ------------------------------ cascata do canal ------------------------- */

/**
 * Acha a melhor fonte que toca agora. `skip` = sids que o cliente já tentou.
 * @returns {Promise<{ok: boolean, source?: object, tried: number, rawTs: number, error?: string}>}
 */
async function resolveChannel(id, options = {}) {
  const ch = byId.get(id);
  if (!ch) return { ok: false, tried: 0, rawTs: 0, error: 'Canal desconhecido.' };
  await loadCatalogs(options.fetchImpl).catch(() => {});
  const skip = new Set(options.skip || []);
  const all = candidatesFor(id).filter((c) => !skip.has(c.sid));
  const started = Date.now();
  let tried = 0;
  let rawTs = 0;

  // 1) o que já está provado vivo, mais recente primeiro (revalida se passou da validade).
  const known = all.filter((c) => playable(health.get(c.url)));
  const rest = all.filter((c) => !known.includes(c) && !(fresh(health.get(c.url)) && !health.get(c.url).ok));
  // Páginas de player (com anúncio, tiradas pelo AdShield) ficam por último: só entram se nenhum HLS tocar.
  const isPage = (c) => {
    const h = health.get(c.url);
    return h && h.kind ? h.kind === 'page' : isPagePlayer(c.url);
  };
  const order = [...known.filter((c) => !isPage(c)), ...rest.filter((c) => !isPage(c)), ...known.filter(isPage), ...rest.filter(isPage)];

  for (let i = 0; i < order.length && tried < MAX_PROBES_PER_RESOLVE; i += PROBE_BATCH) {
    if (Date.now() - started > RESOLVE_BUDGET_MS) break;
    const batch = order.slice(i, i + PROBE_BATCH);
    const results = await Promise.all(batch.map((c) => check(c.url, options).then((e) => ({ c, e }))));
    tried += batch.length;
    for (const { c, e } of results) if (e.ok && e.kind === 'ts') rawTs += 1;
    // respeita a ordem de preferência dentro do lote
    const hit = results.find(({ e }) => playable(e) && e.kind !== 'page') || results.find(({ e }) => playable(e));
    if (hit) {
      logEvent('cascata', `${ch.name}: tocou ${maskUrl(hit.c.url)} (${hit.c.origin}) após ${tried} teste(s) em ${Date.now() - started}ms`);
      return { ok: true, source: { ...hit.c, ...health.get(hit.c.url) }, tried, rawTs };
    }
  }
  logEvent('cascata', `${ch.name}: sem sinal após ${tried} teste(s)${rawTs ? ` (${rawTs} só em TS cru)` : ''}`);
  const reason = rawTs
    ? 'As fontes que estão no ar entregam MPEG-TS cru, que o player ainda não toca.'
    : 'Nenhuma fonte deste canal respondeu agora.';
  return { ok: false, tried, rawTs, error: reason };
}

/* ------------------------- por onde o vídeo vai (sem Render) ------------- */

function liveSecret() {
  return String(process.env.PROXY_SECRET || process.env.SESSION_SECRET || BUILTIN_PROXY_SECRET).trim() || BUILTIN_PROXY_SECRET;
}

/** Mesma conta de adproxy/lib/liveHls.mjs: "live|validade|url". */
function signLive(url, exp, secret = liveSecret()) {
  return crypto.createHmac('sha256', secret).update(`live|${exp}|${url}`).digest('base64url').slice(0, 22);
}

function signedPath(route, url, now = Date.now(), secret) {
  const exp = now + LINK_TTL_MS;
  return `${route}?u=${encodeURIComponent(url)}&e=${exp}&s=${signLive(url, exp, secret)}`;
}

/** Token do AdShield (adproxy/lib/urls.js signUrl): base64url(JSON {u,r,v}) + "." + HMAC-SHA256. */
function adshieldToken(url, referer, secret = liveSecret()) {
  const payload = Buffer.from(JSON.stringify({ u: String(url), r: referer ? String(referer) : null, v: 1 }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

const capCache = new Map(); // `${base}${route}` -> { ok, at }

async function liveCapable(base, route, fetchImpl = fetch) {
  const key = `${base}${route}`;
  const hit = capCache.get(key);
  if (hit && Date.now() - hit.at < CAPABILITY_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const res = await fetchImpl(`${base}${route}?cap=1`, { signal: AbortSignal.timeout(6000) });
    const json = res.ok ? await res.json() : null;
    ok = Boolean(json && json.live);
  } catch (error) { ok = false; }
  capCache.set(key, { ok, at: Date.now() });
  return ok;
}

function edgeReachable(url) {
  // O Edge da Vercel só alcança as portas 80 e 443.
  const u = new URL(url);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return port === '80' || port === '443';
}

/**
 * @param {{url: string, https: boolean, cors: boolean}} source
 * @param {{pool?: string[], fetchImpl?: Function, now?: number}} [deps] pool = bases de Vercel já ordenadas por folga de cota
 * @returns {Promise<{mode: 'direct'|'vercel'|'page'|'none', url?: string, via?: string, reason?: string}>}
 */
async function planDelivery(source, deps = {}) {
  if (source.kind === 'page') {
    const pool = deps.pool || [];
    if (!pool.length) return { mode: 'none', reason: 'Esta fonte é uma página de player com anúncios e precisa do AdShield da Vercel (VIDSRC_PROXY_URLS).' };
    const origin = new URL(source.url).origin;
    return { mode: 'page', url: `${pool[0]}/_adshield/r/${adshieldToken(source.url, `${origin}/`)}`, via: `${new URL(pool[0]).host} (AdShield, sem anúncios)` };
  }
  if (source.https && source.cors) return { mode: 'direct', url: source.url, via: 'direto da fonte' };
  const pool = deps.pool || [];
  if (!pool.length) {
    return { mode: 'none', reason: 'Esta fonte exige a Vercel (HTTP ou sem CORS) e nenhuma Vercel está configurada (VIDSRC_PROXY_URLS).' };
  }
  const wantEdge = edgeReachable(source.url);
  const order = wantEdge ? ['/live/hls', '/live/np'] : ['/live/np'];
  let capable = 0;
  let verifies = 0;
  let lastWhy = '';
  for (const route of order) {
    for (const base of pool) {
      if (!(await liveCapable(base, route, deps.fetchImpl))) continue;
      capable += 1;
      const url = `${base}${signedPath(route, source.url, deps.now)}`;
      if (deps.verify) {
        // Confere de ponta a ponta (só a playlist, poucos KB): a Vercel responde 200 com #EXTM3U para esta fonte?
        if (verifies >= 3) break;
        verifies += 1;
        const v = await verifyVercel(url, deps.fetchImpl);
        if (!v.ok) {
          lastWhy = `${new URL(base).host}${route}: ${v.why}`;
          logEvent('vercel', `recusou ${maskUrl(source.url)} · ${lastWhy}`);
          continue;
        }
      }
      return { mode: 'vercel', url, via: `${new URL(base).host}${route}` };
    }
  }
  if (capable) return { mode: 'none', reason: `A Vercel não conseguiu abrir esta fonte (${lastWhy || 'sem detalhe'}).` };
  return { mode: 'none', reason: 'Nenhuma Vercel do pool tem a rota de TV ao vivo ainda. Reimplante o adproxy (bash deploy-vercel.sh) em cada conta.' };
}

async function verifyVercel(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(12000) });
    const body = await res.text();
    if (res.ok && body.startsWith('#EXTM3U')) return { ok: true };
    return { ok: false, why: `HTTP ${res.status} ${body.slice(0, 140).replace(/\s+/g, ' ')}` };
  } catch (error) {
    return { ok: false, why: error.message };
  }
}

/* ------------------------------- API pública ----------------------------- */

function publicChannel(ch) {
  const cands = candidatesFor(ch.id);
  const entries = cands.map((c) => health.get(c.url)).filter(Boolean);
  const alive = entries.some((e) => playable(e) && fresh(e));
  const probedAll = cands.length > 0 && cands.every((c) => fresh(health.get(c.url)));
  const rawOnly = !alive && entries.some((e) => e.ok && e.kind === 'ts');
  let status = 'unknown';
  if (alive) status = 'ok';
  else if (probedAll) status = rawOnly ? 'raw' : 'down';
  return { id: ch.id, name: ch.name, group: ch.group, status, sources: cands.length };
}

function channelsSnapshot() {
  const channels = CHANNELS.map(publicChannel);
  const groups = [];
  for (const ch of CHANNELS) if (!groups.includes(ch.group)) groups.push(ch.group);
  return {
    groups,
    channels,
    catalog: { lists: catalog.lists, matched: catalog.entries, scanning: Boolean(catalog.loading), updatedAt: catalog.at || null },
    note: 'status: ok = tem fonte tocando agora; down = nenhuma respondeu; raw = só TS cru; unknown = ainda não testado.'
  };
}

/* ------------------------------ área nerd (admin) ------------------------ */

/**
 * Tudo que o servidor sabe sobre a TV ao vivo agora: canais, fontes candidatas com o último teste de cada uma,
 * capacidade das Vercels e os últimos eventos. URLs mascaradas, salvo `full: true`.
 */
function diagnostics({ full = false } = {}) {
  const now = Date.now();
  const show = (u) => (full ? u : maskUrl(u));
  const totals = { fontes: 0, testadas: 0, hls: 0, ts: 0, pagina: 0, mortas: 0 };
  const channels = CHANNELS.map((ch) => {
    const cands = candidatesFor(ch.id).map((c) => {
      const h = health.get(c.url);
      totals.fontes += 1;
      if (h) {
        totals.testadas += 1;
        if (!h.ok) totals.mortas += 1;
        else if (h.kind === 'ts') totals.ts += 1;
        else if (h.kind === 'page') totals.pagina += 1;
        else totals.hls += 1;
      }
      return {
        sid: c.sid, origem: c.origin, url: show(c.url), pagina: isPagePlayer(c.url),
        teste: h ? {
          ok: h.ok, tipo: h.kind || null, motivo: h.reason || '', ms: h.ms, https: h.https, porta: h.port, cors: h.cors,
          idadeS: Math.round((now - h.at) / 1000), foraDaRotacaoS: h.badUntil > now ? Math.ceil((h.badUntil - now) / 1000) : 0
        } : null
      };
    });
    return { ...publicChannel(ch), fontes: cands };
  });
  return {
    agora: new Date(now).toISOString(),
    totais: totals,
    config: {
      varrerListas: !/^(0|false|no)$/i.test(String(process.env.LIVE_SCAN_CATALOGS || '')),
      aquecer: !/^(0|false|no)$/i.test(String(process.env.LIVE_WARM || '')),
      listas: catalog.lists, entradasCasadas: catalog.entries,
      listasAtualizadasHaMin: catalog.at ? Math.round((now - catalog.at) / 60000) : null,
      canaisComFontesDoEnv: Object.keys(envSources()),
      testesEmAndamento: inflight.size, aquecendo: warming
    },
    vercels: [...capCache.entries()].map(([key, v]) => ({ rota: key.replace(/^(https?:\/\/[^/]+)/, (h) => new URL(h).host), serveTV: v.ok, idadeS: Math.round((now - v.at) / 1000) })),
    eventos: events.slice(-200).map((e) => ({ hora: new Date(e.t).toISOString().slice(11, 19), tipo: e.type, msg: e.message })),
    channels
  };
}

/** Força um novo teste (ignora o cache) das fontes de um canal. */
async function retest(id, deps = {}) {
  const cands = candidatesFor(id);
  logEvent('retestar', `${id_(id)}: retestando ${Math.min(cands.length, 30)} fonte(s) a pedido do administrador`);
  let at = 0;
  const list = cands.slice(0, 30);
  const worker = async () => { while (at < list.length) { const c = list[at++]; await check(c.url, { ...deps, force: true }).catch(() => {}); } };
  await Promise.all(Array.from({ length: 5 }, worker));
  return list.length;
}

/* ------------------------------- aquecimento ----------------------------- */

let warmTimer = null;
let lastUse = 0;
let warming = false;

function touch() { lastUse = Date.now(); }

/** Testa os canais em segundo plano (só entra banda, nada sai) enquanto alguém usa a aba. */
async function warm(deps = {}) {
  if (warming) return;
  warming = true;
  try {
    await loadCatalogs(deps.fetchImpl).catch(() => {});
    const jobs = [];
    // 12 por canal e por rodada: primeiro as que nunca foram testadas, depois as de teste mais velho. Assim, canais com
    // dezenas de fontes (ESPN, SporTV) são cobertos inteiros em algumas rodadas, em vez de repetir sempre as 12 primeiras.
    for (const ch of CHANNELS) {
      candidatesFor(ch.id)
        .map((c, i) => ({ c, i, h: health.get(c.url) }))
        .filter((x) => !fresh(x.h))
        .sort((a, b) => (a.h ? 1 : 0) - (b.h ? 1 : 0) || (a.h ? a.h.at - b.h.at : a.i - b.i))
        .slice(0, 12)
        .forEach((x) => jobs.push(x.c.url));
    }
    let at = 0;
    const worker = async () => {
      while (at < jobs.length) { const url = jobs[at++]; await check(url, deps).catch(() => {}); }
    };
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 8 }, worker));
    logEvent('aquecimento', `${jobs.length} fontes testadas em ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    warming = false;
  }
}

let lastWarm = 0;
/** Chamado quando alguém abre a aba: aquece se os testes estão velhos (no máximo uma vez a cada 3 min). */
function warmIfStale(deps) {
  touch();
  if (warming || Date.now() - lastWarm < OK_TTL_MS) return false;
  lastWarm = Date.now();
  warm(deps).catch(() => {});
  return true;
}

function startWarmer() {
  if (warmTimer || /^(0|false|no)$/i.test(String(process.env.LIVE_WARM || ''))) return;
  warmTimer = setInterval(() => {
    if (Date.now() - lastUse < 30 * 60 * 1000) warm().catch(() => {});
  }, OK_TTL_MS);
  warmTimer.unref();
}

function _reset() {
  health.clear(); inflight.clear(); capCache.clear(); lastWarm = 0;
  catalog.at = 0; catalog.index = new Map(); catalog.lists = 0; catalog.entries = 0; catalog.loading = null;
}

module.exports = {
  maskUrl, logEvent, diagnostics, retest,
  CHANNELS, resolveChannel, planDelivery, channelsSnapshot, candidatesFor, reportBad, warm, warmIfStale, startWarmer, touch,
  loadCatalogs, parseM3u, norm, xtreamVariant, hlsVariants, signLive, signedPath, adshieldToken, liveCapable, edgeReachable, check, sid, _reset,
  _health: health, _catalog: catalog
};
