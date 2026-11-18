'use strict';

/**
 * fdsFlix — JKAnime (jkanime.net), segunda fonte de anime (ad-free; fallback do AnimesDigital).
 *
 * O site é aberto e o player "jk" entrega um MP4 direto no host `jkplayers.com`:
 *
 *   GET /buscar/?q=<título>          busca    → links /<slug>/
 *   GET /<slug>/                     anime    → episódios
 *   GET /<slug>/<n>/                 episódio → iframe /jkplayer/jk?u=stream/jkmedia/...
 *   GET /jkplayer/jk?u=...           player   → video: { url: 'https://jkplayers.com/stream/jkmedia/...', type: 'mp4' }
 *
 * O caminho do `u` carrega o IP de QUEM abriu a página (o MP4 é preso a esse IP). Por isso o
 * episódio e o player são buscados pelo **mesmo nó** do AdFallback (via `/_adshield/r/`), e o MP4
 * é preparado no mesmo nó (`prepareOn`), como o VixSrc faz. O navegador consome o media proxy do
 * nó — 0 byte no Render e nenhum anúncio no player do fdsFlix.
 *
 * Origem japonesa, legenda em espanhol (o site é ES). É fallback: o AnimesDigital (PT) vem antes.
 */

const adshieldFallback = require('./adshieldFallback');
const animesDigital = require('./animesDigital');
const { relayFetch } = require('./relayFetch');
const { signUrl } = require('../adproxy/lib/urls');
const { BUILTIN_PROXY_SECRET } = require('../adproxy/lib/secret');

const BASE = 'https://jkanime.net';
const REFERER = `${BASE}/`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const COMPAT_SECRET = String(process.env.ADSHIELD_COMPAT_SECRET || BUILTIN_PROXY_SECRET).trim();
const FETCH_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 10 * 60 * 1000;

const RESERVED = new Set([
  'buscar', 'dash', 'usuario', 'notificaciones', 'guardado', 'historial', 'directorio',
  'anime', 'pelicula', 'genero', 'letra', 'capitulo', 'contacto', 'donaciones', 'privacidad',
  'dmca', 'terminos', 'login', 'registro', 'perfil', 'ajustes', 'comentarios', 'solicitudes', 'listas'
]);

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  cache.set(key, { value, at: Date.now() });
  while (cache.size > 60) cache.delete(cache.keys().next().value);
}
function reset() { cache.clear(); }

function stripTags(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resultados da busca: { url, slug, label }. Ignora as páginas do próprio site. */
function parseSearch(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="https:\/\/jkanime\.net\/([a-z0-9][a-z0-9-]*)\/"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const slug = match[1];
    if (!slug || RESERVED.has(slug) || seen.has(slug)) continue;
    const label = stripTags(match[2]);
    if (!label) continue;
    seen.add(slug);
    out.push({ url: `${BASE}/${slug}/`, slug, label });
  }
  return out;
}

/** O iframe do player próprio (jk); os "um"/"umv" são de terceiros e ficam de fora. */
function parseJkIframe(html) {
  const match = String(html || '').match(/https:\/\/jkanime\.net\/jkplayer\/jk\?u=[^"'\s<>]+/i);
  return match ? match[0].replace(/&amp;/g, '&').replace(/&#038;/g, '&') : null;
}

/** O player monta `video: { url: 'https://jkplayers.com/stream/jkmedia/...', type: 'mp4' }`. */
function parseJkPlayer(html) {
  const source = String(html || '');
  const match = source.match(/video:\s*\{[\s\S]*?url:\s*'([^']+)'/i) ||
    source.match(/url:\s*'(https?:\/\/jkplayers\.com\/[^']+)'/i);
  if (!match) return null;
  const url = match[1].replace(/&amp;/g, '&').replace(/&#038;/g, '&');
  const type = source.match(/type:\s*'(mp4|hls|m3u8)'/i);
  return { url, type: type ? type[1].toLowerCase() : 'mp4' };
}

async function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,pt-BR;q=0.8'
  };
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return await res.text();
  } catch (error) { /* tenta o relay */ }
  try {
    const res = await relayFetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return await res.text();
  } catch (error) { /* desiste */ }
  return '';
}

/** Busca uma URL pelo /_adshield/r/ de UM nó (o IP que aparece no `u` do player é o do nó). */
async function fetchVia(base, url, timeoutMs = FETCH_TIMEOUT_MS) {
  const signed = `${base}/_adshield/r/${signUrl(url, REFERER, { secret: COMPAT_SECRET })}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(signed, { headers: { Accept: '*/*' }, redirect: 'follow', signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, contentType: res.headers.get('content-type') };
  } catch (error) {
    return { ok: false, status: 0, text: '', error: error.name === 'AbortError' ? 'tempo esgotado' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve um anime no JKAnime e prepara o MP4 no mesmo nó que abriu o player (o arquivo é
 * preso ao IP da página). Só roda para anime (TMDB gênero 16 + JP), como o AnimesDigital.
 */
async function findStream({ id, type, season = 1, episode = 1, title, note = () => {} } = {}) {
  if (!adshieldFallback.isEnabled()) return null;
  const info = await animesDigital.animeInfo(id, type);
  if (!info.isAnime) return null;

  const key = `${type}:${id}:${Math.max(1, Number(season) || 1)}:${Math.max(1, Number(episode) || 1)}`;
  const hit = cacheGet(key);
  if (hit) return hit.value;

  const names = [...new Set([title, ...(info.names || [])].filter(Boolean))].slice(0, 6);
  let chosen = null;
  for (const name of names) {
    const html = await fetchText(`${BASE}/buscar/?q=${encodeURIComponent(name)}`);
    if (!html) continue;
    chosen = animesDigital.chooseAnime(parseSearch(html), name, season, type);
    if (chosen) break;
  }
  if (!chosen) { note('JKAnime: título não encontrado'); return null; }

  const pageUrl = chosen.url.endsWith('/') ? chosen.url : chosen.url + '/';
  const episodeUrl = `${pageUrl}${Math.max(1, Number(episode) || 1)}/`;
  const nodes = adshieldFallback.mediaNodes();
  for (const node of nodes) {
    const episodePage = await fetchVia(node, episodeUrl);
    if (!episodePage.ok) continue;
    let jkUrl = parseJkIframe(episodePage.text);
    if (!jkUrl && type === 'movie') {
      // movie às vezes é a própria página do filme, sem o sufixo /1/
      const moviePage = await fetchVia(node, pageUrl);
      if (moviePage.ok) jkUrl = parseJkIframe(moviePage.text);
    }
    if (!jkUrl) continue;
    const player = await fetchVia(node, jkUrl);
    if (!player.ok) continue;
    const video = parseJkPlayer(player.text);
    if (!video) continue;
    const prepared = await adshieldFallback.prepareOn(node, {
      url: video.url,
      referer: REFERER,
      allowCompat: false,
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: REFERER }
    });
    if (!prepared || !prepared.ok || prepared.compat || !prepared.url) continue;
    const isHls = /mpegurl/i.test(prepared.contentType || '') || /\.m3u8/i.test(video.url);
    const value = {
      url: prepared.url,
      provider: 'JKAnime',
      quality: 'auto',
      isHls,
      cors: true,
      proxyBase: node,
      dubbed: false,
      audioLang: ''
    };
    cacheSet(key, { value });
    note(`JKAnime: entregue por ${node} (${video.type}, ${prepared.ms || 0} ms)`);
    return value;
  }
  note('JKAnime: nenhum nó conseguiu abrir o player/MP4');
  return null;
}

module.exports = {
  findStream,
  parseSearch,
  parseJkIframe,
  parseJkPlayer,
  _reset: reset
};
