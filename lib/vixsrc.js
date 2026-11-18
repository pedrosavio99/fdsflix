'use strict';

/**
 * fdsFlix — VixSrc (fonte aberta, sem gate de IP).
 *
 * Por que existe: em 2026-11 o player do Vidsrc (stellarconductornexus.com) passou a exigir
 * Cloudflare Turnstile para IPs de datacenter. A página do player vem com `turnstile:true`,
 * `apiToken` VAZIO e um `gateTicket`; o token só é emitido depois do desafio no navegador
 * (/embed/verify.php), é preso ao IP e vive ~1 min. Sem apiToken não há `stream_urls` — e o
 * desafio é por IP, então a pool de Vercels/Wasmers não consegue mais extrair o Vidsrc.
 *
 * O VixSrc (vixsrc.to) é um provedor aberto, sem Turnstile, com o mesmo catálogo (testado com
 * "A Odisseia" TMDB 1368337 e Game of Thrones S1E1/S2E3). O token da playlist é preso ao IP que
 * o gerou, então TUDO tem de acontecer no MESMO nó do AdFallback:
 *
 *   1. o nó busca /api + /embed pelo /_adshield/r/ (URL assinada, sem abrir proxy);
 *   2. extraímos `window.streams[0].url` + `masterPlaylist.params` (token/expires);
 *   3. o próprio nó prepara a master no proxy de mídia (MEDIA_PROXY=1), devolvendo uma URL
 *      assinada que o navegador consome direto (playlist/segmentos reescritos pelo nó).
 *
 * O Render só faz 2-3 chamadas pequenas e devolve a URL assinada — 0 bytes de vídeo.
 *
 * Sem AdFallback configurado, devolve null e a cascata segue como antes (nada muda).
 */

const { signUrl } = require('../adproxy/lib/urls');
const { BUILTIN_PROXY_SECRET } = require('../adproxy/lib/secret');
const adshieldFallback = require('./adshieldFallback');

// Mesmo segredo público que o /_adshield/r/ usa nos nós (lib/secret.js do adproxy).
const COMPAT_SECRET = String(process.env.ADSHIELD_COMPAT_SECRET || BUILTIN_PROXY_SECRET).trim();
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const BASE = 'https://vixsrc.to';
const REFERER = `${BASE}/`;
const API_TIMEOUT_MS = 12000;
const PREPARE_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 20 * 60 * 1000;
const CACHE_MAX = 60;

const cache = new Map(); // "movie:603" -> { value, at }

function apiPath(type, id, season, episode) {
  if (String(type) === 'tv') {
    return `/api/tv/${encodeURIComponent(id)}/${Math.max(1, Number(season) || 1)}/${Math.max(1, Number(episode) || 1)}`;
  }
  return `/api/movie/${encodeURIComponent(id)}`;
}

/**
 * Busca uma URL pelo /_adshield/r/ de UM nó (assinada com o segredo público do adproxy).
 * Devolve texto cru; HTML (a página do embed) já vem sanitizado pelo nó, mas os scripts inline
 * com `window.streams`/`masterPlaylist` são preservados (medido).
 */
async function fetchVia(base, url, timeoutMs = API_TIMEOUT_MS) {
  const signed = `${base}/_adshield/r/${signUrl(url, REFERER, { secret: COMPAT_SECRET })}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(signed, {
      headers: { Accept: '*/*' },
      redirect: 'follow',
      signal: controller.signal
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, contentType: res.headers.get('content-type') };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: '',
      error: error.name === 'AbortError' ? 'tempo esgotado' : error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extrai a master playlist da página do embed.
 * A página traz `window.streams = [{url:"https://vixsrc.to/playlist/<id>?ub=1"}]` e
 * `masterPlaylist.params = { token, expires }`; o player oficial monta a URL com esses params
 * + h=1&lang=en (sem eles a playlist responde 403).
 *
 * @returns {string|null} URL da master (ou null se a página não for o embed esperado).
 */
function parseEmbed(html) {
  const source = String(html || '');
  const streamsMatch = source.match(/window\.streams\s*=\s*(\[[\s\S]*?\])\s*;/);
  const tokenMatch = source.match(/'token'\s*:\s*'([^']+)'/);
  const expiresMatch = source.match(/'expires'\s*:\s*'([^']+)'/);
  if (!streamsMatch || !tokenMatch) return null;

  let streams;
  try {
    streams = JSON.parse(streamsMatch[1]);
  } catch (error) {
    return null;
  }
  const first = Array.isArray(streams) ? streams.find((item) => item && item.url) : null;
  if (!first) return null;

  let url;
  try {
    url = new URL(first.url);
  } catch (error) {
    return null;
  }
  url.searchParams.set('token', tokenMatch[1]);
  if (expiresMatch) url.searchParams.set('expires', expiresMatch[1]);
  url.searchParams.set('h', '1');
  url.searchParams.set('lang', 'en');
  return url.toString();
}

function cacheKey(type, id, season, episode) {
  return `${type === 'tv' ? 'tv' : 'movie'}:${id}:${type === 'tv' ? season : 0}:${type === 'tv' ? episode : 0}`;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function reset() {
  cache.clear();
}

/**
 * Resolve um título no VixSrc usando os nós do AdFallback (o nó que resolve é o mesmo que entrega).
 *
 * @param {{id: string|number, type?: 'movie'|'tv', season?: number, episode?: number, note?: Function}} options
 * @returns {Promise<{url: string, provider: string, isHls: true, quality: string, proxyBase: string, host: string, cors: true}|null>}
 */
async function resolveVixSrc(options = {}) {
  const id = String(options.id || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const type = String(options.type) === 'tv' ? 'tv' : 'movie';
  const season = Math.max(1, Number(options.season) || 1);
  const episode = Math.max(1, Number(options.episode) || 1);
  const note = typeof options.note === 'function' ? options.note : () => {};

  if (!adshieldFallback.isEnabled()) {
    note('VixSrc: AdFallback desligado (sem ADSHIELD_FALLBACK_URLS) → pulado');
    return null;
  }

  const key = cacheKey(type, id, season, episode);
  const hit = cacheGet(key);
  if (hit) {
    note(`VixSrc: reaproveitado do cache (${hit.host})`);
    return hit;
  }

  const limit = Math.max(1, Math.min(8, Number(process.env.VIXSRC_MAX_NODES) || 5));
  // Nós EXPLÍCITOS do AdFallback primeiro (têm o proxy de mídia); o pool do Vidsrc é reserva e pode
  // ser build antigo — cada tentativa num nó sem proxy custa ~1 s e o token nem é usado.
  const preferred = adshieldFallback.mediaNodes ? adshieldFallback.mediaNodes() : [];
  const ordered = [...preferred, ...adshieldFallback.order().filter((base) => !preferred.includes(base))];
  const nodes = ordered.slice(0, limit);
  for (const base of nodes) {
    const host = adshieldFallback.hostOf(base);
    // Nó já descoberto como build antigo (sem proxy de mídia): não gasta /api + /embed à toa.
    if (adshieldFallback.isLegacy && adshieldFallback.isLegacy(base)) {
      note(`VixSrc: ${host} sem proxy de mídia (já testado); pulado`);
      continue;
    }
    const api = await fetchVia(base, `${BASE}${apiPath(type, id, season, episode)}`);
    if (!api.ok) {
      note(`VixSrc: ${host} /api HTTP ${api.status || api.error}`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(api.text);
    } catch (error) {
      note(`VixSrc: ${host} /api não é JSON`);
      continue;
    }
    const src = String((parsed && parsed.src) || '');
    if (!src) {
      note(`VixSrc: ${host} sem src (título fora do catálogo)`);
      continue;
    }

    const embedUrl = /^https?:\/\//i.test(src) ? src : `${BASE}${src}`;
    const embed = await fetchVia(base, embedUrl);
    if (!embed.ok) {
      note(`VixSrc: ${host} /embed HTTP ${embed.status}`);
      continue;
    }
    const master = parseEmbed(embed.text);
    if (!master) {
      note(`VixSrc: ${host} embed sem window.streams`);
      continue;
    }

    // O token da master é preso ao IP do nó que fez /api + /embed: o prepare TEM de ser no mesmo nó.
    // `allowCompat:false` porque o compat (/_adshield/r/) trata segmento .html como HTML e corrompe
    // o vídeo — VixSrc exige um nó com o proxy de mídia (MEDIA_PROXY=1, o kit do AdFallback).
    const prepared = await adshieldFallback.prepareOn(base, {
      url: master,
      referer: REFERER,
      userAgent: BROWSER_UA,
      timeoutMs: PREPARE_TIMEOUT_MS,
      allowCompat: false
    });
    if (!prepared || !prepared.ok || !prepared.url || prepared.compat) {
      note(`VixSrc: ${host} prepare falhou (${(prepared && prepared.error) || 'sem URL'})`);
      continue;
    }

    const value = {
      url: prepared.url,
      provider: 'VixSrc',
      isHls: true,
      quality: 'auto',
      cors: true,
      proxyBase: base,
      host: prepared.host || host
    };
    cacheSet(key, value);
    note(`VixSrc: entregue por ${value.host} (${prepared.kind || 'hls'}, ${prepared.ms || 0} ms)`);
    return value;
  }

  return null;
}

module.exports = {
  resolveVixSrc,
  parseEmbed,
  apiPath,
  _reset: reset
};
