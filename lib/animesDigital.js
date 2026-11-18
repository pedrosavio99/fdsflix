'use strict';

/**
 * fdsFlix — AnimesDigital (animesdigital.org), fonte brasileira de anime.
 *
 * Por que existe: o AnimeFire está morto (o CDN akumast.net responde 404 desde 2026-10, e o
 * próprio extrator de referência do GoAnime já detecta isso). O AnimesDigital continua de pé,
 * com página DUBLADA e LEGENDADA, e publica cada episódio em HLS direto:
 *
 *   GET /?s=<título>                      busca        → links /anime/a/<slug>
 *   GET /anime/a/<slug>                   episódios    → links /video/a/<id> ("Episódio N")
 *   GET /video/a/<id>                     player       → iframe api.anivideo.net/videohls.php?d=<HLS>
 *
 * O CDN (cdn-sv01.maximaimg.online) EXIGE Referer https://animesdigital.org/ (sem ele: 403) e não
 * manda CORS. Por isso o HLS é preparado no nó do AdFallback com o Referer certo e o navegador
 * consome a URL assinada do nó — 0 byte no Render, igual ao VixSrc.
 *
 * Prefere a página DUBLADA (público brasileiro); se não houver, a legendada. Só age em anime
 * (TMDB gênero 16 + origem JP) e em série/filme, para não gastar requisição em título comum.
 */

const adshieldFallback = require('./adshieldFallback');
const { relayFetch } = require('./relayFetch');

const BASE = 'https://animesdigital.org';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const REFERER = BASE + '/';
const FETCH_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 80;

const cache = new Map(); // chave -> { value, at }

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

/** Texto sem acento/pontuação, palavras de áudio e "online/assistir" fora. */
function normTitle(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(dublado|legendado|dub|sub|todos os episodios|completo|online|assistir)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function absolute(href) {
  try {
    return new URL(String(href || ''), BASE).toString();
  } catch (error) {
    return '';
  }
}

/** Resultados da busca: { url, label, thumb }. */
function parseSearch(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]*\/anime\/a\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const url = absolute(match[1]);
    const label = stripTags(match[2]);
    if (!url || !label || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, label });
  }
  return out;
}

/** Episódios da página do anime: { url, number, label }. */
function parseEpisodes(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]*\/video\/a\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const url = absolute(match[1]);
    if (!url || seen.has(url)) continue;
    const label = stripTags(match[2]);
    const number = (label.match(/epis[oó]dio\s*(\d+(?:\.\d+)?)/i) || [])[1];
    seen.add(url);
    out.push({ url, number: number ? Number(number) : null, label });
  }
  return out;
}

/** HLS do player: o iframe videohls.php?d=<url codificada> (ou um .m3u8 solto). */
function parsePlayer(html) {
  const source = String(html || '');
  const direct = source.match(/videohls\.php\?d=([^"'&]+)/i);
  if (direct) {
    try {
      const url = decodeURIComponent(direct[1].replace(/&amp;/g, '&'));
      if (/^https?:\/\//i.test(url)) return url;
    } catch (error) { /* segue */ }
  }
  const loose = source.match(/https?:\/\/[^"'\\\s]+\.m3u8[^"'\\\s]*/i);
  return loose ? loose[0].replace(/&amp;/g, '&') : null;
}

async function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7',
    Referer: REFERER
  };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal });
    if (res.ok) return await res.text();
  } catch (error) { /* tenta o relay */ }
  try {
    const res = await relayFetch(url, { headers, redirect: 'follow', signal });
    if (res.ok) return await res.text();
  } catch (error) { /* desiste */ }
  return '';
}

/** Só anime: gênero 16 no TMDB + origem japonesa (ou idioma original japonês). */
async function isAnime(id, type) {
  const tmdbKey = String(process.env.TMDB_API_KEY || '').trim();
  if (!tmdbKey) return false;
  const cacheKey = `tmdb:${type}:${id}`;
  const hit = cacheGet(cacheKey);
  if (hit !== null) return hit;
  try {
    const kind = type === 'movie' ? 'movie' : 'tv';
    const res = await fetch(`https://api.themoviedb.org/3/${kind}/${encodeURIComponent(id)}?api_key=${tmdbKey}&language=pt-BR`, {
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return false;
    const data = await res.json();
    const genres = (data.genres || []).map((g) => Number(g.id));
    const japanese = (data.origin_country || []).includes('JP') || data.original_language === 'ja';
    const value = genres.includes(16) && japanese;
    cacheSet(cacheKey, value);
    return value;
  } catch (error) {
    return false;
  }
}

/** Número de temporada que o título do resultado carrega depois do nome (0 = base). */
function seasonOf(labelNorm, wantedNorm) {
  const rest = labelNorm.startsWith(wantedNorm) ? labelNorm.slice(wantedNorm.length).trim() : '';
  const match = rest.match(/^(\d{1,2})$/);
  return match ? Number(match[1]) : 0;
}

/**
 * Escolhe a página do anime: mesma obra, temporada pedida e, no empate, a DUBLADA.
 * Devolve null quando nenhum resultado parece o título.
 */
function chooseAnime(results, title, season, type) {
  const wanted = normTitle(title);
  if (!wanted) return null;
  const wantedSeason = Math.max(1, Number(season) || 1);
  let best = null;
  for (const item of results) {
    const labelNorm = normTitle(item.label);
    if (!labelNorm) continue;
    let score = 0;
    if (labelNorm === wanted) score = 100;
    else if (labelNorm.startsWith(wanted + ' ') || wanted.startsWith(labelNorm + ' ')) score = 70;
    else if (labelNorm.includes(wanted) || wanted.includes(labelNorm)) score = 45;
    if (!score) continue;

    if (type === 'tv') {
      const found = seasonOf(labelNorm, wanted);
      if (wantedSeason > 1) {
        if (found === wantedSeason) score += 25;
        else if (found) score -= 15;
        else score -= 5;
      } else if (!found || found === 1) {
        score += 10;
      } else {
        score -= 20;
      }
    }
    if (/dublado/i.test(item.label)) score += 4;
    if (!best || score > best.score) best = { item, score };
  }
  return best && best.score >= 45 ? best.item : null;
}

/**
 * Resolve um anime no AnimesDigital e prepara o HLS no nó do AdFallback (Referer obrigatório).
 *
 * @param {{id: string|number, type?: 'movie'|'tv', season?: number, episode?: number, title?: string, note?: Function}} options
 * @returns {Promise<{url: string, provider: string, isHls: true, quality: string, proxyBase: string, cors: true, dubbed?: boolean}|null>}
 */
async function findStream(options = {}) {
  const id = String(options.id || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const type = String(options.type) === 'movie' ? 'movie' : 'tv';
  const season = Math.max(1, Number(options.season) || 1);
  const episode = Math.max(1, Number(options.episode) || 1);
  const note = typeof options.note === 'function' ? options.note : () => {};

  if (!adshieldFallback.isEnabled()) {
    note('AnimesDigital: AdFallback desligado (sem ADSHIELD_FALLBACK_URLS) → pulado');
    return null;
  }
  if (!(await isAnime(id, type))) return null;
  if (!options.title) return null;

  const key = `hls:${type}:${id}:${season}:${episode}`;
  const hit = cacheGet(key);
  if (hit) {
    note(`AnimesDigital: reaproveitado do cache (${hit.host || 'nó'})`);
    return hit.value;
  }

  const searchHtml = await fetchText(`${BASE}/?s=${encodeURIComponent(options.title)}`);
  if (!searchHtml) {
    note('AnimesDigital: busca não respondeu');
    return null;
  }
  const chosen = chooseAnime(parseSearch(searchHtml), options.title, season, type);
  if (!chosen) {
    note('AnimesDigital: título não encontrado na busca');
    return null;
  }
  note(`AnimesDigital: página "${chosen.label}"`);

  const animeHtml = await fetchText(chosen.url);
  if (!animeHtml) {
    note('AnimesDigital: página do anime não respondeu');
    return null;
  }
  const episodes = parseEpisodes(animeHtml);
  let ep = episodes.find((item) => item.number === episode);
  if (!ep && type === 'movie') ep = episodes[0] || null;
  if (!ep) {
    note(`AnimesDigital: episódio ${episode} não está na página (${episodes.length} links)`);
    return null;
  }

  const playerHtml = await fetchText(ep.url);
  if (!playerHtml) {
    note('AnimesDigital: página do episódio não respondeu');
    return null;
  }
  const hls = parsePlayer(playerHtml);
  if (!hls) {
    note('AnimesDigital: player sem HLS');
    return null;
  }

  // O CDN exige Referer do AnimesDigital e não manda CORS: o nó busca e entrega.
  // NÃO mandar `Origin`: medido no nó, o CDN responde 403 quando esse header vai junto.
  const prepared = await adshieldFallback.prepare({
    url: hls,
    referer: REFERER,
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      Referer: REFERER
    }
  });
  if (!prepared || !prepared.ok || !prepared.url) {
    note(`AnimesDigital: nó não preparou (${(prepared && prepared.error) || 'sem URL'})`);
    return null;
  }

  const value = {
    url: prepared.url,
    provider: 'AnimesDigital',
    isHls: true,
    quality: 'auto',
    cors: true,
    proxyBase: prepared.node,
    dubbed: /dublado/i.test(chosen.label),
    audioLang: /dublado/i.test(chosen.label) ? 'por' : '',
    host: prepared.host || ''
  };
  cacheSet(key, { value, host: value.host });
  note(`AnimesDigital: entregue por ${value.host || 'nó'} (${prepared.kind || 'hls'}, ${prepared.ms || 0} ms)`);
  return value;
}

module.exports = {
  findStream,
  parseSearch,
  parseEpisodes,
  parsePlayer,
  chooseAnime,
  normTitle,
  _reset: reset
};
