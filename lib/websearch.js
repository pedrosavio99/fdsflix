'use strict';

/**
 * "Buscar na web" (só administrador): faz o que a pessoa faria — pesquisa
 * "assistir <filme> online grátis dublado" — e devolve as páginas que prometem o filme,
 * com o que cada uma entrega (player, m3u8/mp4, dublado/legendado).
 *
 * Por que existe: as fontes por API (Vidsrc, VidLink, MGEB…) cobrem bem o catálogo, mas
 * quando tropeçam não há plano B. Este motor é o plano B: vai na fonte que a busca achar.
 *
 * Como funciona:
 *   1. monta 3 buscas em pt-BR (com "dublado", "completo" e o ano);
 *   2. pesquisa no DuckDuckGo (HTML) e no Bing, com o parser de cada um;
 *   3. junta, tira duplicata e ordena (site de streaming primeiro, agregador de crítica depois);
 *   4. abre as primeiras páginas e tira delas: player (iframe), arquivo (m3u8/mp4),
 *      os pares `data-url` + `data-tipo` (é assim que os sites marcam dublado/legendado)
 *      e o player do tema Dooplay (`data-post`/`data-nume`).
 *
 * NADA aqui aparece para o visitante: a rota exige a senha e o painel é `.admin-only`.
 */

const { fetchSmart, relayStatus } = require('./extractFetch');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const SEARCH_TIMEOUT_MS = 9000;
const PROBE_TIMEOUT_MS = 8000;

// Sites que aparecem na busca mas não são "fonte" (catálogo, crítica, loja, rede social).
const NOT_A_SOURCE = /(^|\.)(disneyplus|primevideo|netflix|max\.com|hbomax|adorocinema|filmow|filmelier|justwatch|plex|letterboxd|rottentomatoes|metacritic|ingresso|cinemark|cinépolis|imdb|wikipedia|youtube|youtu\.be|dailymotion|vimeo|tv\.apple|apple|google|play\.google|facebook|instagram|tiktok|twitter|x\.com|reddit|mercadolivre|americanas|magazineluiza|submarino|shopee|aliexpress|uol|terra|globo|g1|folha|estadao|brasildefato|omelete|legiao|tecmundo|canaltech|olhardigital|blog|medium|cbf|wikipedia)/i;

// Assets que aparecem em data-url/data-src mas não são player.
const ASSET = /\.(?:js|css|jpg|jpeg|png|webp|svg|gif|woff2?|ico|json|xml|txt|html?)(?:\?|$)/i;
const ASSET_HOST = /(^|\.)(googletagmanager|google-analytics|onesignal|gstatic|jquery|cloudflare|jsdelivr|unpkg|cdnjs|fontawesome)/i;

const STREAM_HINT = /(assistir|online|dublado|legendado|completo|filme|serie|série|hd|1080|720|gratis|grátis)/i;

function config() {
  return {
    enabled: String(process.env.WEBSEARCH_ENABLED || '1') !== '0',
    maxResults: Math.max(3, Math.min(12, Number(process.env.WEBSEARCH_MAX) || 8))
  };
}

/* ------------------------------------------------------------------ */
/* Consultas                                                           */
/* ------------------------------------------------------------------ */

function buildQueries({ title, year, type, season, episode }) {
  const name = String(title || '').replace(/[“”"':]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return [];
  const y = Number(year) || 0;
  const base = y ? `${name} ${y}` : name;
  const queries = [];
  if (type === 'tv') {
    const ep = season && episode ? ` ${season} temporada ${episode} episodio` : '';
    queries.push(`assistir ${base}${ep} online dublado`);
    queries.push(`${base}${ep} dublado assistir online`);
    queries.push(`assistir ${base}${ep} completo dublado hd`);
  } else {
    queries.push(`assistir ${base} online gratis dublado`);
    queries.push(`${base} dublado completo online`);
    queries.push(`assistir ${name} online dublado hd`);
  }
  return queries.slice(0, 3);
}

/* ------------------------------------------------------------------ */
/* Busca                                                               */
/* ------------------------------------------------------------------ */

/**
 * Busca um HTML tentando direto → relay residencial → Worker (lib/extractFetch.js).
 * `options.relay === false` força só o direto (usado em teste).
 */
async function fetchText(url, timeoutMs, extraHeaders = {}, options = {}) {
  if (options.relay === false) {
    const r = await fetchSmart(url, { timeoutMs, headers: extraHeaders });
    return { ...r, viaRelay: r.via !== 'direto' };
  }
  const r = await fetchSmart(url, { timeoutMs, headers: extraHeaders });
  return { ...r, viaRelay: r.via !== 'direto' };
}

/** DuckDuckGo HTML: os links vêm com `?uddg=<url>`. */
function parseDdg(html) {
  const out = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const href = (/href="([^"]+)"/.exec(m[0]) || [])[1] || '';
    const dec = href.match(/[?&]uddg=([^&]+)/);
    let url = dec ? decodeURIComponent(dec[1]) : href;
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:/i.test(url)) continue;
    if (/(^|\.)(duckduckgo)\./i.test(hostOf(url))) continue;
    out.push({ url, title: stripTags(m[1]) });
  }
  return out;
}

/** O Bing embrulha o resultado num redirect `bing.com/ck/a?...&u=a1<base64>`. */
function decodeBingRedirect(url) {
  try {
    const target = new URL(String(url).replace(/&amp;/g, '&')).searchParams.get('u');
    if (!target) return url;
    if (!/^a1/.test(target)) return url;
    const decoded = Buffer.from(target.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch (err) {
    return url;
  }
}

/** Bing: resultados em <li class="b_algo"><h2><a href="...">. */
function parseBing(html) {
  const out = [];
  const blocks = html.split('class="b_algo"').slice(1);
  for (const block of blocks) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = decodeBingRedirect(link[1]);
    if (!/^https?:/i.test(url)) continue;
    if (/(^|\.)(bing|duckduckgo|microsoft)\./i.test(hostOf(url))) continue;
    out.push({ url, title: stripTags(link[2]) });
  }
  return out;
}

function stripTags(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchOne(engine, query) {
  const url = engine === 'bing'
    ? `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=30&setlang=pt-br&cc=BR`
    : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchText(url, SEARCH_TIMEOUT_MS);
  if (!res.ok) return { engine, ok: false, status: res.status, viaRelay: res.viaRelay, results: [] };
  const results = engine === 'bing' ? parseBing(res.text) : parseDdg(res.text);
  return { engine, ok: true, status: res.status, viaRelay: res.viaRelay, results };
}

// Palavras que não identificam o filme.
const STOP = /^(the|a|o|as|os|um|uma|de|da|do|das|dos|e|of|and|in|on|para|com|por|ao|aos)$/i;

function titleTokens(title) {
  return normTitle(title).split(' ').filter((t) => t.length >= 4 && !STOP.test(t));
}

/** O resultado tem alguma palavra do título? (mata resultado de busca genérico) */
function matchesTitle(item, title) {
  const tokens = titleTokens(title);
  if (!tokens.length) return true;
  const haystack = (String(item.title || '') + ' ' + String(item.url || '')).toLowerCase();
  const hits = tokens.filter((t) => haystack.includes(t)).length;
  // Título com 2+ palavras: exige 2 (mata "viagem" de pacote de viagem em "A Viagem de Chihiro").
  return tokens.length >= 2 ? hits >= 2 : hits >= 1;
}

function scoreResult(item, year) {
  const url = item.url;
  const host = hostOf(url);
  if (!host) return -100;
  if (/(^|\.)(bing|duckduckgo|microsoft|go\.microsoft)\./i.test(host)) return -100;
  // Site de catálogo/crítica/loja/rede social não é fonte: sai da lista.
  if (NOT_A_SOURCE.test(host)) return -100;
  let score = 5;
  if (STREAM_HINT.test(url)) score += 2;
  if (STREAM_HINT.test(item.title || '')) score += 2;
  if (/dublado/i.test(url) || /dublado/i.test(item.title || '')) score += 3;
  if (year && url.includes(String(year))) score += 1;
  return score;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (err) { return ''; }
}

/* ------------------------------------------------------------------ */
/* Sonda na página: o que ela entrega para tocar                       */
/* ------------------------------------------------------------------ */

const STREAM_RE = /https?:\/\/[^"'\s\\<>]+\.(?:m3u8|mp4)(?:\?[^"'\s\\<>]*)?/g;

function probeHtml(html, pageUrl) {
  const text = String(html || '');
  const pageHost = hostOf(pageUrl);

  const streams = [];
  for (const raw of text.match(STREAM_RE) || []) {
    const url = raw.replace(/&amp;/g, '&');
    if (/nao_encontrado|not_found|placeholder/i.test(url)) continue;
    if (!streams.includes(url)) streams.push(url);
  }

  const iframes = [];
  const iframeRe = /<iframe[^>]+src="([^"]+)"/g;
  let m;
  while ((m = iframeRe.exec(text))) {
    const src = m[1].replace(/&amp;/g, '&');
    if (!/^https?:/i.test(src)) continue;
    if (!iframes.includes(src)) iframes.push(src);
  }

  // Padrão dos sites de filme: <... data-tipo="dublado" data-url="https://player/...">
  // Só entra o que tem `data-tipo` (é o que marca dublado/legendado); o resto é miniatura/script.
  const options = [];
  const tagRe = /<[^>]+data-(?:url|src|player|embed)="([^"]+)"[^>]*>/g;
  while ((m = tagRe.exec(text))) {
    const tag = m[0];
    const url = m[1].replace(/&amp;/g, '&');
    if (!/^https?:/i.test(url)) continue;
    const tipo = (tag.match(/data-tipo="([^"]+)"/) || [])[1] || '';
    if (!tipo) continue;
    if (ASSET.test(url) || ASSET_HOST.test(hostOf(url))) continue;
    const label = (tag.match(/data-(?:nome|name|label|server|servidor)="([^"]+)"/) || [])[1] || '';
    const audio = /dublad/i.test(tipo + ' ' + label + ' ' + url)
      ? 'dublado'
      : (/legendad/i.test(tipo + ' ' + label + ' ' + url) ? 'legendado' : '');
    if (options.some((o) => o.url === url)) continue;
    options.push({ url, label: stripTags(label) || tipo, audio });
  }

  const dooplay = /dooplay_player_option[^>]*data-post="(\d+)"/.exec(text)
    ? { post: /data-post="(\d+)"/.exec(text)[1] }
    : null;

  return {
    host: pageHost,
    title: stripTags((text.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''),
    streams: streams.slice(0, 4),
    iframes: iframes.slice(0, 4),
    options: options.slice(0, 8),
    dooplay
  };
}

async function probePage(url) {
  const res = await fetchText(url, PROBE_TIMEOUT_MS, { Referer: 'https://www.google.com/' });
  if (!res.ok) return { url, ok: false, status: res.status, viaRelay: res.viaRelay, streams: [], iframes: [], options: [] };
  return { url, ok: true, status: res.status, viaRelay: res.viaRelay, ...probeHtml(res.text, url) };
}

/* ------------------------------------------------------------------ */
/* Busca DENTRO dos sites de filme (funciona quando o buscador não traz) */
/*                                                                      */
/* O redecanais é WordPress + tema Dooplay:                              */
/*   /search/<título>/                       -> lista com /filme/<slug>/ */
/*   /filme/<slug>/                          -> data-post + 6 servidores */
/*   /wp-json/dooplayer/v1/<post>/movie/<n>  -> {"embed_url":"..."}      */
/* Todos os servidores são por id do TMDB.                               */
/* ------------------------------------------------------------------ */

const SITES = [
  { key: 'redecanais', base: 'https://www4.redecanais.vip' }
];

/** Nomes do título em vários idiomas (pt-BR, original, inglês, alternativos). */
async function tmdbNames(id, type) {
  const key = String(process.env.TMDB_API_KEY || '').trim();
  const cleanId = String(id || '');
  if (!key || !/^\d{1,12}$/.test(cleanId)) return [];
  const base = String(process.env.TMDB_API_BASE || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
  const kind = type === 'tv' ? 'tv' : 'movie';
  const names = [];
  const add = (n) => { const v = String(n || '').trim(); if (v && !names.includes(v)) names.push(v); };
  try {
    const [pt, en] = await Promise.all([
      fetchText(`${base}/${kind}/${cleanId}?language=pt-BR&api_key=${encodeURIComponent(key)}`, 7000),
      fetchText(`${base}/${kind}/${cleanId}?language=en-US&api_key=${encodeURIComponent(key)}`, 7000)
    ]);
    if (pt.ok) { try { const j = JSON.parse(pt.text); add(j.title || j.name); add(j.original_title || j.original_name); } catch (e) {} }
    if (en.ok) { try { const j = JSON.parse(en.text); add(j.title || j.name); } catch (e) {} }
  } catch (err) { /* sem TMDB: segue com o que veio */ }
  return names;
}

/** "Coração Selvagem" -> "coracao-selvagem" (e variantes com/sem artigo e com/sem ano). */
function slugVariants(names, year) {
  const out = [];
  const push = (slug) => {
    const value = String(slug || '').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
    if (value && value.length >= 3 && !out.includes(value)) out.push(value);
  };

  for (const name of names) {
    const base = normTitle(name).replace(/\s+/g, '-');
    if (!base) continue;
    push(base);
    if (year) push(`${base}-${year}`);
    // sem artigo inicial ("a viagem de chihiro" -> "viagem-de-chihiro")
    push(base.replace(/^(a|o|as|os|the)-/, ''));
    if (year) push(`${base.replace(/^(a|o|as|os|the)-/, '')}-${year}`);
  }
  return out.slice(0, 8);
}

function normTitle(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\((?:19|20)\d{2}\)/g, ' ')
    .replace(/\b(dublado|legendado|online|completo|hd|filme|assistir)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleScore(wanted, found) {
  const w = normTitle(wanted);
  const f = normTitle(found);
  if (!w || !f) return 0;
  if (w === f) return 100;
  if (f.startsWith(w + ' ') || w.startsWith(f + ' ')) return 84;
  if (f.includes(w) || w.includes(f)) return 66;
  const tokens = w.split(' ');
  const pool = new Set(f.split(' '));
  if (tokens.length >= 2 && tokens.every((t) => pool.has(t))) return 58;
  return 0;
}

/** Lê a página do filme: título, ano, data-post e os servidores (nº). */
function parseFilmPage(html) {
  const text = String(html || '');
  const post = (/data-post=["'](\d+)["']/.exec(text) || [])[1] || '';
  const numes = [...text.matchAll(/data-nume=["'](\d+)["']/g)].map((x) => x[1]);
  const rawTitle = stripTags((text.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
  const year = Number((rawTitle.match(/\(((?:19|20)\d{2})\)/) || [])[1]) || 0;
  return { post, numes, title: rawTitle, year };
}

// Cache e ritmo: a API do site devolve 429 (Cloudflare 1015) se levar rajada.
const serversCache = new Map(); // filmUrl -> { servers, at }
const SERVERS_TTL_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Monta a lista de servidores chamando a API do tema Dooplay (devagar e com cache). */
async function serversOf(site, filmUrl, post, numes) {
  if (!post) return [];
  const hit = serversCache.get(filmUrl);
  if (hit && Date.now() - hit.at < SERVERS_TTL_MS) return hit.servers;

  const servers = [];
  const list = numes.slice(0, 6);
  for (let i = 0; i < list.length; i += 1) {
    if (i > 0) await sleep(250); // ritmo: evita o 429/1015
    const api = `${site.base}/wp-json/dooplayer/v1/${post}/movie/${list[i]}`;
    const r = await fetchText(api, 8000, { Referer: filmUrl, 'X-Requested-With': 'XMLHttpRequest' });
    if (r.status === 429 || /error code: 1015/i.test(r.text || '')) break; // limitou: fica com o que tem
    if (!r.ok) continue;
    try {
      const data = JSON.parse(r.text);
      if (data && data.embed_url) {
        servers.push({
          label: 'Servidor ' + list[i],
          url: String(data.embed_url),
          audio: /ds_lang=[^&]*pt|pob/i.test(String(data.embed_url)) ? 'dublado' : ''
        });
      }
    } catch (err) { /* servidor sem resposta */ }
  }
  if (servers.length) serversCache.set(filmUrl, { servers, at: Date.now() });
  return servers;
}

/**
 * Acha o filme SEM a busca do site (que é a única página barrada pelo Cloudflare).
 * O caminho /filme/<slug>/ responde de qualquer IP: adivinha-se o slug pelo título.
 */
async function findBySlug(site, names, year) {
  const candidates = slugVariants(names, year);
  const attempts = [];
  for (const slug of candidates) {
    const filmUrl = `${site.base}/filme/${slug}/`;
    const page = await fetchText(filmUrl, 9000, { Referer: site.base + '/' });
    attempts.push({ slug, status: page.status, ok: page.ok });
    if (!page.ok) continue;
    const info = parseFilmPage(page.text);
    // Slug errado (mesmo nome, outro ano): continua procurando a variante com ano.
    if (year && info.year && Math.abs(info.year - Number(year)) > 1) continue;
    return { slug, filmUrl, ...info, attempts };
  }
  return { attempts };
}

async function searchDooplay(site, titles, year) {
  const names = Array.isArray(titles) ? titles.filter(Boolean) : [titles].filter(Boolean);
  const title = names[0] || '';

  // 1) Slug (funciona de datacenter: /filme/ não é barrado)
  const bySlug = await findBySlug(site, names, year);
  if (bySlug.filmUrl) {
    const servers = await serversOf(site, bySlug.filmUrl, bySlug.post, bySlug.numes);
    return { site: site.key, ok: true, via: 'slug', status: 200, film: bySlug.filmUrl, title: bySlug.title, year: bySlug.year, servers, attempts: bySlug.attempts };
  }

  // 2) Busca do site (só funciona de IP residencial)
  const searchUrl = `${site.base}/search/${encodeURIComponent(title)}/`;
  const res = await fetchText(searchUrl, 10000, { Referer: site.base + '/' });
  if (!res.ok) return { site: site.key, ok: false, status: res.status, film: null, servers: [], attempts: bySlug.attempts };

  const links = [];
  const re = /href="(https?:\/\/[^"]*\/filme\/[^"#?]+\/?)"/g;
  let m;
  while ((m = re.exec(res.text))) {
    const url = m[1];
    if (!links.includes(url)) links.push(url);
  }
  const ranked = links
    .map((url) => {
      const slug = decodeURIComponent(url.split('/filme/')[1] || '').replace(/\/$/, '').replace(/-/g, ' ');
      let score = Math.max(...names.map((n) => titleScore(n, slug)));
      if (year && url.includes(String(year))) score += 6;
      return { url, score };
    })
    .filter((item) => item.score >= 58)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return { site: site.key, ok: true, via: 'busca', status: res.status, film: null, servers: [], found: links.length, attempts: bySlug.attempts };

  const filmUrl = ranked[0].url;
  const film = await fetchText(filmUrl, 10000, { Referer: searchUrl });
  if (!film.ok) return { site: site.key, ok: true, via: 'busca', status: res.status, film: filmUrl, servers: [], attempts: bySlug.attempts };
  const info = parseFilmPage(film.text);
  const servers = await serversOf(site, filmUrl, info.post, info.numes);
  return { site: site.key, ok: true, via: 'busca', status: res.status, film: filmUrl, title: info.title, year: info.year, servers, attempts: bySlug.attempts };
}

/* ------------------------------------------------------------------ */
/* Motor                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {{title: string, year?: number, type?: string, season?: number, episode?: number}} wants
 */
async function find({ title, year, type = 'movie', season = 1, episode = 1, id = '' }) {
  const cfg = config();
  if (!cfg.enabled) return { error: 'Busca na web desligada (WEBSEARCH_ENABLED=0).', results: [] };
  const queries = buildQueries({ title, year, type, season, episode });
  if (!queries.length) return { error: 'Sem título para procurar.', results: [] };

  // Nomes do TMDB (pt-BR/original/inglês) melhoram muito o acerto do slug.
  const tmdb = await tmdbNames(id, type);
  const titles = [...new Set([title, ...tmdb].filter(Boolean))];

  const searches = await Promise.all(queries.flatMap((query) =>
    ['ddg', 'bing'].map((engine) => searchOne(engine, query).then((r) => ({ ...r, query })))));

  // Junta tudo por URL, guardando quais buscas/motores acharam.
  const byUrl = new Map();
  for (const search of searches) {
    for (const item of search.results) {
      const url = item.url;
      if (!/^https?:/i.test(url)) continue;
      const existing = byUrl.get(url);
      if (existing) {
        existing.hits += 1;
        if (!existing.title && item.title) existing.title = item.title;
      } else {
        byUrl.set(url, { url, title: item.title, hits: 1, engines: [search.engine] });
      }
    }
  }

  // 1) Busca dentro dos sites conhecidos (é o que acha de verdade).
  const siteResults = await Promise.all(SITES.map((site) => searchDooplay(site, titles, year)));

  const ranked = [...byUrl.values()]
    .filter((item) => matchesTitle(item, title))
    .map((item) => ({ ...item, score: scoreResult(item, year) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.hits - a.hits)
    .slice(0, cfg.maxResults);

  const probed = await Promise.all(ranked.map(async (item) => {
    const page = await probePage(item.url);
    return { ...item, page };
  }));

  // Quem entrega algo para tocar vem primeiro (a busca bruta não sabe disso).
  probed.sort((a, b) => {
    const weight = (x) => {
      const p = x.page || {};
      return ((p.options || []).length ? 4 : 0) + ((p.streams || []).length ? 3 : 0) + ((p.iframes || []).length ? 2 : 0);
    };
    return weight(b) - weight(a) || b.score - a.score;
  });

  const usedRelay = searches.some((item) => item.viaRelay);
  return {
    title,
    year: year || 0,
    type,
    relay: relayStatus(),
    viaRelay: usedRelay,
    sites: siteResults,
    queries,
    engines: searches.reduce((acc, s) => {
      const key = s.engine;
      if (!acc[key]) acc[key] = { ok: 0, fail: 0 };
      acc[key][s.ok ? 'ok' : 'fail'] += 1;
      return acc;
    }, {}),
    total: byUrl.size,
    results: probed
  };
}

module.exports = {
  find,
  buildQueries,
  searchDooplay,
  parseDdg,
  parseBing,
  probeHtml,
  probePage,
  hostOf,
  scoreResult,
  matchesTitle,
  slugVariants,
  parseFilmPage
};
