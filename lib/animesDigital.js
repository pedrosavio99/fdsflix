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
 * O CDN (cdn-sv01.maximaimg.online) EXIGE Referer https://animesdigital.org/ (sem ele: 403), recusa
 * o header Origin e não manda CORS. Por isso o HLS é preparado no nó do AdFallback com o Referer
 * certo e o navegador consome a URL assinada do nó — 0 byte no Render, igual ao VixSrc.
 *
 * Prefere a página DUBLADA (público brasileiro); se não houver, a legendada. Só age em anime
 * (TMDB gênero 16 + origem JP) e em série/filme, para não gastar requisição em título comum.
 *
 * Títulos: o site usa o nome japonês/romaji ("Shingeki no Kyojin", "Kimetsu no Yaiba", "Boku no
 * Hero Academia"), então além do título do TMDB o provider tenta o original_name e os
 * alternative_titles; se a busca não casar, tenta o slug direto (/anime/a/<slug>[-dublado]).
 * Séries longas (One Piece) são paginadas de 50 em 50: o provider segue /page/N/ até achar o
 * episódio pedido (normalmente a última página tem os primeiros).
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
const CACHE_MAX = 120;
const MAX_PAGES = 6; // páginas de episódios por tentativa (série longa)

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

/** Resultados da busca: { url, label }. */
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

/** Páginas de episódios (/page/N/): { max, urls: Map<number, url> }. */
function parsePages(html) {
  const urls = new Map();
  const re = /href="(https:\/\/animesdigital\.org\/anime\/a\/[^"]+\/page\/(\d+)\/?)"/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const number = Number(match[2]);
    if (number > 0 && !urls.has(number)) urls.set(number, match[1]);
  }
  return { max: urls.size ? Math.max(...urls.keys()) : 0, urls };
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

/**
 * Nomes pelo AniList (romaji/english/native/synonyms). O TMDB devolve o original em japonês
 * (鬼滅の刃) e não traz o romaji que o site usa ("Kimetsu no Yaiba"); o AniList traz.
 * POST no GraphQL; tenta direto e cai no relay (Worker) se o Render for barrado.
 */
async function anilistNames(title) {
  const search = String(title || '').trim();
  if (!search) return [];
  const query = 'query($s:String){Media(search:$s,type:ANIME){title{romaji english native} synonyms}}';
  const body = JSON.stringify({ query, variables: { s: search } });
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const url = 'https://graphql.anilist.co';
  let res = null;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(6000) });
  } catch (error) { /* relay */ }
  if (!res || !res.ok) {
    try {
      res = await relayFetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
    } catch (error) { /* sem AniList */ }
  }
  if (!res || !res.ok) return [];
  let json = null;
  try { json = await res.json(); } catch (error) { return []; }
  const media = json && json.data && json.data.Media;
  if (!media) return [];
  return [media.title && media.title.romaji, media.title && media.title.english, media.title && media.title.native, ...(media.synonyms || [])]
    .filter(Boolean);
}

/** Nomes do TMDB: título pt-BR, original e alternative_titles (o site usa romaji). */
async function animeInfo(id, type) {
  const tmdbKey = String(process.env.TMDB_API_KEY || '').trim();
  if (!tmdbKey) return { isAnime: false, names: [] };
  const cacheKey = `tmdb:${type}:${id}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;
  try {
    const kind = type === 'movie' ? 'movie' : 'tv';
    const detailsUrl = `https://api.themoviedb.org/3/${kind}/${encodeURIComponent(id)}?api_key=${tmdbKey}&language=pt-BR`;
    const altsUrl = `https://api.themoviedb.org/3/${kind}/${encodeURIComponent(id)}/alternative_titles?api_key=${tmdbKey}`;
    const [detailsRes, altsRes] = await Promise.all([
      fetch(detailsUrl, { signal: AbortSignal.timeout(6000) }),
      fetch(altsUrl, { signal: AbortSignal.timeout(6000) }).catch(() => null)
    ]);
    if (!detailsRes.ok) return { isAnime: false, names: [] };
    const data = await detailsRes.json();
    const genres = (data.genres || []).map((g) => Number(g.id));
    const japanese = (data.origin_country || []).includes('JP') || data.original_language === 'ja';
    const isAnime = genres.includes(16) && japanese;

    const names = [];
    const add = (value) => {
      const text = String(value || '').trim();
      if (!text || text.length < 2) return;
      if (!names.some((item) => item.toLowerCase() === text.toLowerCase())) names.push(text);
    };
    // O AniList traz o romaji ("Kimetsu no Yaiba", "Shingeki no Kyojin"), que é o nome usado
    // pelo site; ele vem PRIMEIRO (é o slug mais provável) e os alternative_titles do TMDB por
    // último, para não ser cortado no limite.
    let aliases = [];
    if (isAnime) {
      try { aliases = await anilistNames(data.name || data.original_name); } catch (error) { aliases = []; }
    }
    add(aliases[0]);
    add(data.name || data.title);
    add(aliases[1]);
    add(data.original_name || data.original_title);
    for (const name of aliases.slice(2)) add(name);
    try {
      const alts = altsRes && altsRes.ok ? await altsRes.json() : null;
      for (const item of ((alts && (alts.results || alts.titles)) || []).slice(0, 20)) add(item.title);
    } catch (error) { /* sem alternativos */ }

    const value = { isAnime, names };
    cacheSet(cacheKey, value);
    return value;
  } catch (error) {
    return { isAnime: false, names: [] };
  }
}

/** Slugs diretos do site para um nome (o site usa hífens e sufixo -dublado). */
function slugVariants(name) {
  const base = normTitle(name).replace(/\s+/g, '-');
  if (!base) return [];
  return [...new Set([`${base}-dublado`, base, `${base}-legendado`])];
}

/**
 * Temporada que o rótulo carrega depois do nome. Devolve:
 *  - { exact:true, season:0 }  quando o rótulo é só o nome;
 *  - { exact:false, season:N } quando é o nome + marcador de temporada ("2", "2nd Season",
 *    "Temporada 2", "3 (Part 2)");
 *  - null quando é outra obra/arco ("One Piece: A Série", "Kimetsu no Yaiba: Hashira Geiko-hen").
 */
function seasonMarker(labelNorm, wantedNorm) {
  if (!labelNorm.startsWith(wantedNorm)) return null;
  const rest = labelNorm.slice(wantedNorm.length).trim();
  if (!rest) return { exact: true, season: 0 };
  const patterns = [
    /^(\d{1,2})$/,
    /^(\d{1,2})\s*(?:st|nd|rd|th)?\s*season$/,
    /^season\s*(\d{1,2})$/,
    /^(\d{1,2})\s*(?:a|ª)?\s*temporada$/,
    /^temporada\s*(\d{1,2})$/,
    /^(\d{1,2})\s*(?:part|parte)\s*\d+$/
  ];
  for (const re of patterns) {
    const match = rest.match(re);
    if (match) return { exact: false, season: Number(match[1]) };
  }
  return null;
}

/**
 * Escolhe a página do anime: mesma obra, temporada pedida e, no empate, a DUBLADA.
 * Rejeita arcos/live-action com nome parecido ("One Piece: A Série"); para esses, o slug
 * direto (um pouco depois) resolve.
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
    if (type === 'movie') {
      if (labelNorm === wanted) score = 100;
      else if (labelNorm.startsWith(wanted + ' ')) score = 70;
      else if (wanted.startsWith(labelNorm + ' ')) score = 60;
    } else {
      const marker = seasonMarker(labelNorm, wanted);
      if (!marker) continue;
      if (marker.exact) score = 100;
      else score = 88;
      if (wantedSeason > 1) {
        if (marker.season === wantedSeason) score += 25;
        else if (marker.season) score -= 10;
        else score -= 5;
      } else if (!marker.season || marker.season === 1) {
        score += 10;
      } else {
        score -= 20;
      }
    }
    if (!score) continue;
    if (/dublado/i.test(item.label)) score += 4;
    if (!best || score > best.score) best = { item, score };
  }
  return best && best.score >= 80 ? best.item : null;
}

async function pageFromSlug(name, season = 1) {
  const base = normTitle(name).replace(/\s+/g, '-');
  if (!base) return null;
  const list = [];
  if (Number(season) > 1) {
    list.push(
      `${base}-${season}-dublado`,
      `${base}-${season}`,
      `${base}-${season}a-temporada-dublado`,
      `${base}-temporada-${season}-dublado`,
      `${base}-${season}a-temporada`
    );
  }
  list.push(`${base}-dublado`, base);
  for (const slug of [...new Set(list)]) {
    const url = `${BASE}/anime/a/${slug}`;
    const html = await fetchText(url);
    if (html && /\/video\/a\//.test(html)) {
      return { url, label: name, dubbed: /dublado/.test(slug) };
    }
  }
  return null;
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
  const info = await animeInfo(id, type);
  if (!info.isAnime) return null;
  if (!options.title && !info.names.length) return null;

  const key = `hls:${type}:${id}:${season}:${episode}`;
  const hit = cacheGet(key);
  if (hit) {
    note(`AnimesDigital: reaproveitado do cache (${hit.host || 'nó'})`);
    return hit.value;
  }

  const names = [...new Set([options.title, ...info.names].filter(Boolean))].slice(0, 6);
  let page = null;
  // 1) slug direto dos 2 nomes mais prováveis (o romaji vem primeiro): 1-2 requisições.
  for (const name of names.slice(0, 2)) {
    page = await pageFromSlug(name, season);
    if (page) break;
  }
  // 2) busca (necessária para temporadas/arcos que o slug não cobre).
  if (!page) {
    for (const name of names.slice(0, 3)) {
      const searchHtml = await fetchText(`${BASE}/?s=${encodeURIComponent(name)}`);
      if (!searchHtml) continue;
      const chosen = chooseAnime(parseSearch(searchHtml), name, season, type);
      if (chosen) { page = chosen; break; }
    }
  }
  // 3) slug dos demais nomes (english/synonyms).
  if (!page) {
    for (const name of names.slice(2, 5)) {
      page = await pageFromSlug(name, season);
      if (page) break;
    }
  }
  if (!page) {
    note('AnimesDigital: título não encontrado (busca e slugs)');
    return null;
  }
  note(`AnimesDigital: página "${page.label}"`);

  let animeHtml = await fetchText(page.url);
  if (!animeHtml) {
    note('AnimesDigital: página do anime não respondeu');
    return null;
  }
  let episodes = parseEpisodes(animeHtml);
  let ep = episodes.find((item) => item.number === episode);
  if (!ep && type === 'movie') ep = episodes[0] || null;

  // Série longa (One Piece): a lista é paginada de 50 em 50; os primeiros episódios ficam
  // nas últimas páginas. Vai da última para trás, com teto.
  if (!ep) {
    const pages = parsePages(animeHtml);
    for (let n = pages.max; n >= Math.max(1, pages.max - MAX_PAGES + 1); n -= 1) {
      const url = pages.urls.get(n) || `${page.url.replace(/\/$/, '')}/page/${n}/`;
      const html = await fetchText(url);
      if (!html) continue;
      const list = parseEpisodes(html);
      ep = list.find((item) => item.number === episode) || (type === 'movie' ? list[0] : null);
      if (ep) break;
    }
  }
  if (!ep) {
    note(`AnimesDigital: episódio ${episode} não encontrado (${episodes.length} links na 1ª página)`);
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

  // O CDN exige Referer do site e recusa Origin: o nó busca e entrega.
  const dubbed = Boolean(page.dubbed) || /dublado/i.test(page.label);
  // `allowCompat:false`: o nó de build antigo pode devolver o compat `/_adshield/r/`, que não é
  // determinístico para esta fonte (medido: o Vercel devolveu um master que o player recusou; o
  // Wasmer serviu segmento TS válido). O media proxy entrega playlist e segmentos sempre.
  let prepared = await adshieldFallback.prepare({
    url: hls,
    referer: REFERER,
    allowCompat: false,
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      Referer: REFERER
    }
  });
  // O rodízio pode cair num nó de build antigo e devolver o compat /_adshield/r/ mesmo com
  // allowCompat:false (o prepare multi-nó de builds antigos ignorava a flag). Esse caminho variou
  // entre nós (Vercel falhou, Wasmer serviu): força um nó com proxy de mídia e, sem ele, devolve
  // null (melhor a cascata tentar outra fonte do que entregar um caminho não determinístico).
  if (prepared && prepared.ok && prepared.compat) {
    const candidates = typeof adshieldFallback.mediaNodes === 'function' ? adshieldFallback.mediaNodes() : [];
    for (const base of candidates) {
      if (base === prepared.node) continue;
      const retry = await adshieldFallback.prepareOn(base, {
        url: hls,
        referer: REFERER,
        allowCompat: false,
        headers: { 'User-Agent': UA, Accept: '*/*', Referer: REFERER }
      });
      if (retry && retry.ok && !retry.compat && retry.url) { prepared = retry; break; }
    }
  }
  if (!prepared || !prepared.ok || prepared.compat || !prepared.url) {
    note(`AnimesDigital: nó não preparou mídia (${(prepared && (prepared.error || (prepared.compat ? 'só compat, segmentos corrompem' : 'sem URL'))) || 'sem URL'})`);
    return null;
  }

  const value = {
    url: prepared.url,
    provider: 'AnimesDigital',
    isHls: true,
    quality: 'auto',
    cors: true,
    proxyBase: prepared.node,
    dubbed,
    audioLang: dubbed ? 'por' : '',
    host: prepared.host || ''
  };
  cacheSet(key, { value, host: value.host });
  note(`AnimesDigital: entregue por ${value.host || 'nó'} (${prepared.kind || 'hls'}, ${prepared.ms || 0} ms)`);
  return value;
}

module.exports = {
  findStream,
  animeInfo,
  parseSearch,
  parseEpisodes,
  parsePages,
  parsePlayer,
  chooseAnime,
  seasonMarker,
  slugVariants,
  normTitle,
  _reset: reset
};
