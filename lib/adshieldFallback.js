'use strict';

/**
 * fdsFlix — AdFallback: rodízio de AdShields de FALLBACK (só filmes).
 *
 * O problema: o Render Free tem 5 GB/mês de saída, então `renderBound()` PULA toda fonte cujo
 * vídeo teria que passar por ele. Na prática só o Vidsrc (pelas Vercels/Wasmers da pool) sobra —
 * se a pool inteira engasga por um minuto, o site responde 503 mesmo com o VidLink Pro tendo
 * achado o filme.
 *
 * O AdFallback é um SEGUNDO conjunto de nós do adproxy (com MEDIA_PROXY=1) que só entra quando a
 * cascata normal terminou sem nada entregável. Ele busca a playlist/arquivo com o token do nó e
 * entrega ao navegador: ZERO bytes de vídeo no Render.
 *
 * É um RODÍZIO, igual ao pool do Vidsrc:
 *  - `ADSHIELD_FALLBACK_URLS` aceita vários nós (vírgula/espaço). Um filme inteiro sai de um nó só.
 *  - o nó com mais folga (menos bytes no ciclo) é escolhido; empate sorteia.
 *  - nó que falhou por infraestrutura (rede, 5xx, tempo) vai para o fim por 90 s.
 *  - nó acima da cota vai para o fim (a estimativa pode estar errada, então não é descartado).
 *  - o navegador informa os bytes que baixou de cada nó (hls.js/`<video>`) e isso alimenta a folga.
 *
 * Variáveis (todas opcionais; sem a primeira, NADA muda no comportamento atual):
 *   ADSHIELD_FALLBACK_URLS      lista de nós, separados por vírgula/espaço
 *   ADSHIELD_FALLBACK_BASE_URL  um nó só (compatibilidade)
 *   ADSHIELD_FALLBACK_KEY       chave compartilhada (MEDIA_PROXY_KEY do nó)
 *   ADSHIELD_FALLBACK_QUOTA_GB  cota mensal de CADA nó (padrão 100)
 *   ADSHIELD_FALLBACK_QUOTAS    cota por nó que não é Vercel: `URL=GB,...` (ex.: Wasmer)
 *   ADSHIELD_FALLBACK_MAX_NODES quantos nós tentar por filme (padrão 3)
 *   ADSHIELD_FALLBACK_BUDGET_MS tempo total gasto tentando nós (padrão 20000)
 *   ADSHIELD_FALLBACK_FILE      cache do contador (padrão ./.fallback-usage.json)
 *   ADSHIELD_FALLBACK=0         desliga sem apagar as URLs
 *   USAGE_RESET_DAY             dia do mês da renovação (o mesmo do pool do Vidsrc)
 */

const fs = require('fs');
const path = require('path');

const { signUrl } = require('../adproxy/lib/urls');
const { BUILTIN_PROXY_SECRET } = require('../adproxy/lib/secret');

// Token do caminho "compat": os nós ANTIGOS (sem /_adshield/media) têm o /_adshield/r/<token>,
// que aceita qualquer URL assinada e respeita o Referer do token. Serve para fontes HLS/mp4 que
// exigem Referer (AnimeFire e afins) — NÃO serve para o VidLink, que recusa qualquer Referer.
const COMPAT_SECRET = String(process.env.ADSHIELD_COMPAT_SECRET || BUILTIN_PROXY_SECRET).trim();

// Nós que responderam 404 no /media/prepare = build antigo (sem proxy de mídia). Guardamos para não
// gastar uma tentativa neles a cada filme: para fonte SEM Referer (VidLink) eles são pulados na hora;
// para fonte COM Referer, o caminho compat é tentado direto. Volta a testar depois de 30 min (caso
// o nó seja reenviado com o kit novo).
const LEGACY_TTL_MS = 30 * 60 * 1000;
const legacyNodes = new Map(); // base -> timestamp do 404
const deliveredNodes = new Set(); // bases que já entregaram mídia (vão na frente no rodízio)

function isLegacy(base, now = Date.now()) {
  const at = legacyNodes.get(base);
  if (!at) return false;
  if (now - at > LEGACY_TTL_MS) {
    legacyNodes.delete(base);
    return false;
  }
  return true;
}

const GB = 1024 ** 3;
const DAY_MS = 86400000;
const MAX_REPORT_BYTES = 600 * 1024 * 1024;
const COOLDOWN_MS = 90 * 1000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_BUDGET_MS = 20000; // tempo total por filme tentando nós (não deixa a espera virar minuto)
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 100;
const SAVE_DELAY_MS = 4000;

const FILE = path.resolve(process.env.ADSHIELD_FALLBACK_FILE || path.join(__dirname, '..', '.fallback-usage.json'));

let roundRobin = 0; // desempate entre nós com a mesma folga (rodízio de verdade)

const state = { cycle: '', bytes: {} }; // bytes[base] = medidos no ciclo atual
const health = new Map();               // base -> { at, why }
const cache = new Map();                // chave -> { value, expires }
let saveTimer = null;
let warnedLoop = false;

/* ------------------------------- configuração ------------------------------- */

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/**
 * Nós do AdFallback, sem repetição: os explícitos (ADSHIELD_FALLBACK_URLS) + os do pool do Vidsrc
 * (VIDSRC_PROXY_URLS). Os antigos do pool entram como COMPAT: servem fonte HLS/mp4 com Referer;
 * para VidLink são pulados de graça (não têm a rota de mídia). Assim você não precisa cadastrar
 * URL nenhuma: o que já está publicado é aproveitado sozinho.
 */
function nodes() {
  const raw = [
    process.env.ADSHIELD_FALLBACK_URLS,
    process.env.ADSHIELD_FALLBACK_BASE_URL,
    process.env.VIDSRC_PROXY_URLS,
    process.env.VIDSRC_PROXY_URL
  ].filter(Boolean).join(',');
  const list = raw
    .split(/[\s,;]+/)
    .map(normalizeBase)
    .filter((item) => /^https?:\/\//i.test(item));
  return Array.from(new Set(list));
}

function hostOf(base) {
  try {
    return new URL(base).host;
  } catch (error) {
    return String(base || '');
  }
}

/** Um nó apontando para o próprio Render põe o vídeo na banda dele: melhor recusar do que quebrar. */
function pointsAtRender() {
  const own = [process.env.RENDER_EXTERNAL_URL, process.env.PUBLIC_BASE_URL]
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).host;
      } catch (error) {
        return '';
      }
    })
    .filter(Boolean);
  if (!own.length) return null;
  const bad = nodes().find((base) => own.includes(hostOf(base)));
  if (bad && !warnedLoop) {
    warnedLoop = true;
    console.warn(`[adfallback] ${hostOf(bad)} é o próprio Render: ignorado (usaria a banda dele). Use o nó externo.`);
  }
  return bad || null;
}

function isEnabled() {
  return nodes().length > 0 && String(process.env.ADSHIELD_FALLBACK || '1') !== '0' && !pointsAtRender();
}

function key() {
  return String(process.env.ADSHIELD_FALLBACK_KEY || '').trim();
}

function resetDay() {
  const day = Number(process.env.USAGE_RESET_DAY);
  return Number.isFinite(day) && day >= 1 && day <= 28 ? Math.floor(day) : 1;
}

/** Início do ciclo atual (mês que começa no USAGE_RESET_DAY), em UTC. */
function cycleStart(now = new Date()) {
  const day = resetDay();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const thisMonth = new Date(Date.UTC(year, month, day));
  return now >= thisMonth ? thisMonth : new Date(Date.UTC(year, month - 1, day));
}

function cycleKey(now = new Date()) {
  return cycleStart(now).toISOString().slice(0, 10);
}

function quotaGb(base) {
  const raw = String(process.env.ADSHIELD_FALLBACK_QUOTAS || '');
  for (const item of raw.split(/[\s,;]+/).filter(Boolean)) {
    const eq = item.lastIndexOf('=');
    if (eq <= 0) continue;
    if (normalizeBase(item.slice(0, eq)) !== base) continue;
    const gb = Number(item.slice(eq + 1));
    if (Number.isFinite(gb) && gb > 0) return gb;
  }
  const fallback = Number(process.env.ADSHIELD_FALLBACK_QUOTA_GB);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 100;
}

function quotaBytes(base) {
  return quotaGb(base) * GB;
}

/* --------------------------------- contador --------------------------------- */

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.bytes && typeof parsed.bytes === 'object') {
      state.bytes = parsed.bytes;
      state.cycle = String(parsed.cycle || '');
    }
  } catch (error) {
    /* sem arquivo (ou corrompido): começa do zero */
  }
  refreshCycle();
}

function refreshCycle(now = new Date()) {
  const current = cycleKey(now);
  if (state.cycle !== current) {
    state.cycle = current;
    state.bytes = {};
  }
}

function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      refreshCycle();
      fs.writeFileSync(FILE, JSON.stringify({ cycle: state.cycle, bytes: state.bytes }), 'utf8');
    } catch (error) {
      /* disco cheio/read-only: o rodízio segue só em memória */
    }
  }, SAVE_DELAY_MS);
  if (saveTimer.unref) saveTimer.unref();
}

function usedBytes(base) {
  refreshCycle();
  return Number(state.bytes[normalizeBase(base)]) || 0;
}

/**
 * O navegador informa quanto baixou de cada nó (POST /api/usage). Só aceita nós configurados:
 * evita lixo no contador e mantém o arquivo pequeno.
 */
function record(base, bytes, seconds = 0) {
  const target = normalizeBase(base);
  if (!target || !nodes().includes(target)) return { ok: false, error: 'nó de fallback desconhecido' };
  const amount = Math.max(0, Math.min(MAX_REPORT_BYTES, Math.round(Number(bytes) || 0)));
  if (!amount) return { ok: false, error: 'bytes inválidos' };
  refreshCycle();
  state.bytes[target] = (Number(state.bytes[target]) || 0) + amount;
  saveState();
  return { ok: true, base: target, bytes: state.bytes[target], seconds: Number(seconds) || 0 };
}

/* -------------------------------- rodízio ---------------------------------- */

function cooling(base, now = Date.now()) {
  const hit = health.get(base);
  return Boolean(hit && now - hit.at < COOLDOWN_MS);
}

/** Erro do nó (infra: vale castigar) × erro daquela mídia (não vale). */
function infraFailure(status, message) {
  if (status === 0 || status === 408 || status === 429 || status >= 500) return true;
  return /tempo esgotado|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(String(message || ''));
}

/**
 * Ordem do rodízio: mais folga primeiro; nó em cooldown ou acima da cota vai para o fim
 * (não é descartado: a estimativa pode estar errada).
 */
function order(now = Date.now()) {
  const list = nodes().map((base) => {
    const used = usedBytes(base);
    const quota = quotaBytes(base);
    return {
      base,
      used,
      quota,
      // Folga sem arredondar: 2 MB já conta na hora de escolher (a % só serve para exibir).
      slack: quota > 0 ? used / quota : 1,
      exhausted: quota > 0 && used >= quota * 0.98,
      cooling: cooling(base, now),
      legacy: isLegacy(base, now),
      delivered: deliveredNodes.has(base)
    };
  });

  // Quem já entregou mídia por este nó vem primeiro; nós de build antigo (sem rota de mídia) por
  // último — eles só servem o caminho compat (fonte com Referer).
  const byUse = (a, b) => Number(b.delivered) - Number(a.delivered) || a.slack - b.slack;
  const healthy = list.filter((item) => !item.cooling && !item.exhausted && !item.legacy).sort(byUse);
  const legacy = list.filter((item) => !item.cooling && !item.exhausted && item.legacy).sort(byUse);
  const exhausted = list.filter((item) => !item.cooling && item.exhausted).sort(byUse);
  const cold = list.filter((item) => item.cooling).sort(byUse);

  // Empate no topo (ex.: todos zerados): alterna a cada chamada — rodízio de verdade.
  let first = healthy;
  if (healthy.length) {
    const minSlack = healthy[0].slack;
    const tie = healthy.filter((item) => item.slack === minSlack && item.delivered === healthy[0].delivered);
    const rest = healthy.filter((item) => !tie.includes(item));
    const shift = tie.length ? roundRobin % tie.length : 0;
    first = [...tie.slice(shift), ...tie.slice(0, shift), ...rest];
  }
  roundRobin += 1;

  return [...first, ...legacy, ...exhausted, ...cold].map((item) => item.base);
}

function snapshot(now = Date.now()) {
  const list = order(now).map((base) => ({
    base,
    host: hostOf(base),
    usedBytes: usedBytes(base),
    usedGb: Math.round((usedBytes(base) / GB) * 100) / 100,
    quotaGb: quotaGb(base),
    quotaBytes: quotaBytes(base),
    usedPct: quotaBytes(base) > 0 ? Math.round((usedBytes(base) / quotaBytes(base)) * 10000) / 100 : 100,
    cooling: cooling(base, now),
    legacy: isLegacy(base, now),
    delivered: deliveredNodes.has(base),
    reason: (health.get(base) && health.get(base).why) || null
  }));
  const totalUsedBytes = list.reduce((sum, item) => sum + item.usedBytes, 0);
  return {
    enabled: isEnabled(),
    count: list.length,
    nodes: list,
    totalUsedBytes,
    totalUsedGb: Math.round((totalUsedBytes / GB) * 1000) / 1000,
    totalQuotaGb: list.reduce((sum, item) => sum + item.quotaGb, 0)
  };
}

/* --------------------------------- HTTP ------------------------------------ */

function pickHeader(headers, ...names) {
  if (!headers || typeof headers !== 'object') return '';
  for (const name of names) {
    if (headers[name]) return String(headers[name]);
  }
  const lowered = new Map(Object.keys(headers).map((name) => [name.toLowerCase(), headers[name]]));
  for (const name of names) {
    const value = lowered.get(name.toLowerCase());
    if (value) return String(value);
  }
  return '';
}

/**
 * Caminho compatível com os nós ANTIGOS (build sem /_adshield/media): assina a URL para o
 * /_adshield/r/<token> deles. Só tenta quando a fonte tem Referer (é o que o nó antigo repassa) e
 * confirma com um HEAD antes de entregar — se a rota não existir ou recusar a assinatura, segue a vida.
 */
async function compatPrepare(base, options, timeoutMs = 8000) {
  const referer = String(options.referer || '').trim();
  if (!referer) return { ok: false, compat: true, error: 'compat precisa de Referer (fonte sem perfil de ponte)' };
  const mediaUrl = `${base}/_adshield/r/${signUrl(options.url, referer, { secret: COMPAT_SECRET })}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(mediaUrl, { method: 'HEAD', headers: { Accept: '*/*' }, signal: controller.signal });
    const contentType = String(res.headers.get('content-type') || '');
    if (!res.ok) {
      return { ok: false, compat: true, status: res.status, error: `compat HTTP ${res.status}`, ms: Date.now() - started };
    }
    const path = (() => { try { const u = new URL(options.url); return u.pathname + u.search; } catch (e) { return ''; } })();
    const hls = /mpegurl/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(path);
    return {
      ok: true,
      compat: true,
      kind: hls ? 'hls' : 'file',
      url: mediaUrl,
      contentType: contentType || null,
      node: base,
      host: hostOf(base),
      ms: Date.now() - started
    };
  } catch (error) {
    return { ok: false, compat: true, error: error.name === 'AbortError' ? 'tempo esgotado (compat)' : error.message, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function requestNode(base, options, timeoutMs) {
  const query = new URLSearchParams({ u: options.url });
  if (options.referer) query.set('r', options.referer);
  if (options.origin) query.set('o', options.origin);
  if (options.userAgent) query.set('a', options.userAgent);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${base}/_adshield/media/prepare?${query.toString()}`, {
      headers: key() ? { 'x-media-key': key(), Accept: 'application/json' } : { Accept: 'application/json' },
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || !data.ok || !data.url) {
      const error = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error, ms: Date.now() - started };
    }
    return {
      ok: true,
      kind: data.kind,
      url: data.url,
      contentType: data.contentType || null,
      node: base,
      host: hostOf(base),
      ms: Date.now() - started
    };
  } catch (error) {
    const why = error.name === 'AbortError' ? 'tempo esgotado no nó' : error.message;
    return { ok: false, status: 0, error: why, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function cacheGet(cacheKey) {
  const hit = cache.get(cacheKey);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(cacheKey);
    return null;
  }
  return hit.value;
}

function cacheSet(cacheKey, value) {
  cache.set(cacheKey, { value, expires: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * Pede a um dos nós uma URL assinada para esta mídia, no ordem do rodízio.
 * O primeiro que responder vence; o filme inteiro fica naquele nó.
 *
 * @param {{url: string, headers?: object, referer?: string, timeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, kind?: 'hls'|'file', url?: string, node?: string, error?: string, notes?: string[]}>}
 */
async function prepare(options = {}) {
  const mediaUrl = String(options.url || '').trim();
  if (!isEnabled()) return { ok: false, error: 'AdFallback desligado (sem ADSHIELD_FALLBACK_URLS)' };
  if (!/^https?:\/\//i.test(mediaUrl)) return { ok: false, error: 'URL de mídia inválida' };

  const headers = options.headers || {};
  const referer = String(options.referer || pickHeader(headers, 'Referer') || '').trim();
  const origin = pickHeader(headers, 'Origin').trim();
  const userAgent = pickHeader(headers, 'User-Agent').trim();
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;

  const request = { url: mediaUrl, referer, origin, userAgent };
  const cacheKey = [mediaUrl, referer, origin, userAgent].join('|');
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const limit = Math.max(1, Math.min(10, Number(process.env.ADSHIELD_FALLBACK_MAX_NODES) || 3));
  const budget = Math.max(3000, Number(process.env.ADSHIELD_FALLBACK_BUDGET_MS) || DEFAULT_BUDGET_MS);
  const notes = [];
  const started = Date.now();

  let attempts = 0;
  for (const base of order()) {
    if (Date.now() - started > budget) {
      notes.push('orçamento de tempo esgotado');
      break;
    }
    if (attempts >= limit) break;

    // Nó sabidamente antigo (404 no /media/prepare): sem Referer não há como entregar — pula de graça,
    // sem gastar uma das tentativas. Com Referer, tenta o compat (/_adshield/r/<token>).
    if (isLegacy(base)) {
      if (!request.referer) {
        notes.push(`${hostOf(base)}: build antigo (sem rota de mídia); fonte sem Referer, pulado`);
        continue;
      }
      attempts += 1;
      const compat = await compatPrepare(base, request, timeoutMs);
      if (compat.ok) {
        deliveredNodes.add(base);
        const value = { ...compat, ms: Date.now() - started };
        cacheSet(cacheKey, value);
        return value;
      }
      notes.push(`${hostOf(base)}: compat falhou (${compat.error})`);
      continue;
    }

    attempts += 1;
    const result = await requestNode(base, request, Math.min(timeoutMs, budget - (Date.now() - started)));
    if (result.ok) {
      health.delete(base);
      deliveredNodes.add(base);
      const value = { ...result, ms: Date.now() - started };
      cacheSet(cacheKey, value);
      return value;
    }

    // 404/405 = build antigo. Não conta como tentativa (é só descoberta de capacidade) e, se a fonte
    // tem Referer, o compat ainda pode salvar.
    if (result.status === 404 || result.status === 405) {
      attempts -= 1;
      legacyNodes.set(base, Date.now());
      if (request.referer) {
        attempts += 1;
        const compat = await compatPrepare(base, request, timeoutMs);
        if (compat.ok) {
          health.delete(base);
          deliveredNodes.add(base);
          const value = { ...compat, ms: Date.now() - started };
          cacheSet(cacheKey, value);
          return value;
        }
        notes.push(`${hostOf(base)}: sem rota de mídia e o compat falhou (${compat.error})`);
        continue;
      }
      notes.push(`${hostOf(base)}: build antigo (sem rota de mídia); fonte sem Referer`);
      continue;
    }

    notes.push(`${hostOf(base)}: ${result.error}`);
    if (infraFailure(result.status, result.error)) health.set(base, { at: Date.now(), why: String(result.error).slice(0, 80) });
  }

  // Não guarda falha em cache: o nó pode estar acordando (Vercel/Wasmer frios).
  return { ok: false, error: notes.join(' · ') || 'nenhum nó respondeu', notes, ms: Date.now() - started };
}

/**
 * Testa UM nó candidato (fora do rodízio) com uma URL de mídia real. Serve para decidir se vale
 * somar a URL em ADSHIELD_FALLBACK_URLS: se o CDN bloqueia aquele IP, você descobre em 10 s.
 */
async function probe(base, options = {}) {
  const target = String(base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'URL do nó inválida' };
  const url = String(options.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'URL de mídia inválida' };
  const headers = options.headers || {};
  return requestNode(target, {
    url,
    referer: String(options.referer || pickHeader(headers, 'Referer') || '').trim(),
    origin: pickHeader(headers, 'Origin').trim(),
    userAgent: pickHeader(headers, 'User-Agent').trim()
  }, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
}

function _reset(now = new Date()) {
  cache.clear();
  health.clear();
  legacyNodes.clear();
  deliveredNodes.clear();
  roundRobin = 0;
  state.bytes = {};
  state.cycle = cycleKey(now);
}

loadState();

module.exports = {
  isEnabled,
  nodes,
  hostOf,
  host: () => (nodes()[0] ? hostOf(nodes()[0]) : null),
  hosts: () => nodes().map(hostOf),
  prepare,
  probe,
  compatPrepare,
  order,
  record,
  snapshot,
  usedBytes,
  quotaGb,
  cycleKey,
  _reset
};
