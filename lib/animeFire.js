'use strict';

/**
 * Fonte de ANIME: AnimeFire (catálogo brasileiro, com dublado em português).
 *
 * O contrato da API foi mapeado a partir do GoAnime (MIT, © Krone,
 * https://github.com/alvarorichard/GoAnime — internal/scraper/providers/animefire).
 * Este arquivo é uma implementação própria em Node; nenhum código Go foi copiado.
 *
 *   GET {api}/animes/pesquisar?q=<busca>&v=3   -> data[] {id, titles{BR,US,JP}, audio, published_at}
 *   GET {api}/anime/<id>?v=3                    -> data.seasons[] / data.episodes[] {id, season, number}
 *   GET {api}/episode/<id>?v=3                  -> data.streams[] {audio, is_offline, url}
 *
 * A URL do stream parece uma imagem (…/h.jpg) mas é um master HLS. O CDN recusa
 * quem não manda User-Agent e Referer do site, por isso o vídeo sai pela ponte
 * /api/hls-proxy do nosso servidor (veja server.js), restrita ao domínio do CDN.
 *
 * Observação honesta: o AnimeFire lista títulos que não tem arquivos. Quando isso
 * acontece, o episódio vem "offline" e a cascata segue para a próxima fonte.
 *
 * Variáveis: ANIMEFIRE_ENABLED=0 desliga; ANIMEFIRE_API_BASE / ANIMEFIRE_SITE
 * redirecionam se o site mudar de endereço.
 */

const { validateSource } = require('./cineproValidate');

const API_VERSION = '3';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0';
const ACCEPT_LANGUAGE = 'pt-BR,pt;q=0.8,en-US;q=0.5,en;q=0.3';

const cache = new Map(); // chave -> { value, expires }
function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  return loader().then((value) => {
    if (value != null) cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  });
}

function config() {
  const strip = (v) => String(v || '').replace(/\/+$/, '');
  return {
    enabled: process.env.ANIMEFIRE_ENABLED !== '0',
    api: strip(process.env.ANIMEFIRE_API_BASE) || 'https://api.animefire.one',
    site: strip(process.env.ANIMEFIRE_SITE) || 'https://animefire.one',
    tmdbBase: strip(process.env.TMDB_API_BASE) || 'https://api.themoviedb.org/3',
    // Só para teste local (http/127.0.0.1): nunca ligado em produção.
    allowLocal: Boolean(process.env.ANIMEFIRE_API_BASE) && process.env.NODE_ENV !== 'production'
  };
}

async function fetchJson(url, headers, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch (err) {
      // HTML no lugar de JSON: a API mudou de lugar.
      return { ok: false, status: res.status, notJson: true };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function apiHeaders(cfg) {
  return {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json',
    'Accept-Language': ACCEPT_LANGUAGE,
    // A API é de outra origem que o site/app; ela espera os cabeçalhos de CORS do app.
    Origin: cfg.site,
    Referer: cfg.site + '/'
  };
}

/* ------------------------------------------------------------------ */
/* Nomes e comparação de títulos                                        */
/* ------------------------------------------------------------------ */

function normTitle(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(dublado|legendado|dub|sub|todos os episodios|completo|hd)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleScore(wanted, found) {
  const w = normTitle(wanted);
  const f = normTitle(found);
  if (!w || !f) return 0;
  if (w === f) return 100;
  const diff = Math.abs(w.length - f.length);
  if (f.startsWith(w + ' ') || w.startsWith(f + ' ')) return 70 - Math.min(diff, 30);
  if (f.includes(w) || w.includes(f)) return 50 - Math.min(diff, 30);
  return 0;
}

function resultTitles(anime) {
  return Object.values((anime && anime.titles) || {}).filter(Boolean);
}

function bestMatch(results, wantedNames, minScore = 55) {
  let best = null;
  for (const anime of results) {
    let score = 0;
    for (const found of resultTitles(anime)) {
      for (const wanted of wantedNames) score = Math.max(score, titleScore(wanted, found));
    }
    const hasDub = /dublado/i.test(String(anime.audio || ''));
    const total = score + (hasDub ? 2 : 0); // empate: prefere o que tem dublado
    if (score >= minScore && (!best || total > best.total)) best = { anime, score, total };
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* TMDB (só para saber se é anime e quais nomes procurar)               */
/* ------------------------------------------------------------------ */

async function tmdbJson(cfg, path) {
  const key = process.env.TMDB_API_KEY;
  if (!key) return null;
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetchJson(`${cfg.tmdbBase}${path}${sep}api_key=${encodeURIComponent(key)}`, { Accept: 'application/json' }, 8000);
  return r.ok ? r.data : null;
}

/** @returns {Promise<{isAnime: boolean, names: string[], seasons: {n:number,count:number}[]}|null>} */
function loadTmdbInfo(cfg, id, type) {
  return cached(`tmdb:${type}:${id}`, 60 * 60 * 1000, async () => {
    const kind = type === 'movie' ? 'movie' : 'tv';
    const [en, pt, alt] = await Promise.all([
      tmdbJson(cfg, `/${kind}/${id}?language=en-US`),
      tmdbJson(cfg, `/${kind}/${id}?language=pt-BR`),
      tmdbJson(cfg, `/${kind}/${id}/alternative_titles`)
    ]);
    const base = en || pt;
    if (!base) return null;

    const genres = (base.genres || []).map((g) => g.id);
    const japanese = (base.origin_country || []).includes('JP') || base.original_language === 'ja';
    const isAnime = genres.includes(16) && japanese;

    const names = [];
    const add = (n) => { if (n && !names.includes(n)) names.push(n); };
    add(pt && (pt.name || pt.title));
    add(en && (en.name || en.title));
    add(base.original_name || base.original_title);
    for (const t of ((alt && (alt.results || alt.titles)) || []).slice(0, 12)) add(t.title);

    const seasons = (base.seasons || [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({ n: s.season_number, count: s.episode_count || 0 }));

    return { isAnime, names, seasons };
  });
}

/* ------------------------------------------------------------------ */
/* AnimeFire                                                            */
/* ------------------------------------------------------------------ */

async function searchAnime(cfg, query) {
  const r = await fetchJson(`${cfg.api}/animes/pesquisar?q=${encodeURIComponent(query)}&v=${API_VERSION}`, apiHeaders(cfg));
  return r.ok && r.data && Array.isArray(r.data.data) ? r.data.data : [];
}

/** Numera os episódios no total da série (a API reinicia a numeração a cada temporada). */
function numberAcrossSeasons(episodes, seasons) {
  const first = new Map();
  for (const s of seasons || []) if (s.first_episode_number > 0) first.set(Number(s.number), s.first_episode_number);

  const out = episodes.map((e) => ({
    id: e.id,
    season: Number(e.season) || 1,
    local: Number(e.number) || 0,
    num: first.has(Number(e.season)) ? first.get(Number(e.season)) + (Number(e.number) || 1) - 1 : Number(e.number) || 0
  }));

  const seen = new Set();
  let unique = true;
  for (const e of out) {
    if (seen.has(e.num)) unique = false;
    seen.add(e.num);
  }
  if (!unique) out.forEach((e, i) => { e.num = i + 1; });
  return out;
}

async function loadEpisodes(cfg, animeId) {
  return cached(`eps:${animeId}`, 30 * 60 * 1000, async () => {
    const r = await fetchJson(`${cfg.api}/anime/${encodeURIComponent(animeId)}?v=${API_VERSION}`, apiHeaders(cfg), 12000);
    if (!r.ok || !r.data || !r.data.data) return null;
    const data = r.data.data;
    const episodes = (data.episodes || []).filter((e) => e && e.id);
    return numberAcrossSeasons(episodes, data.seasons || []);
  });
}

function pickEpisode(episodes, tmdbSeasons, season, episode, isMovie) {
  if (!episodes || !episodes.length) return null;
  if (isMovie) return episodes.length === 1 ? episodes[0] : null;

  // 1) número absoluto: soma das temporadas anteriores do TMDB + episódio
  let absolute = episode;
  for (const s of tmdbSeasons) if (s.n < season) absolute += s.count;
  const byAbs = episodes.find((e) => e.num === absolute);
  if (byAbs) return byAbs;

  // 2) temporada/episódio como o AnimeFire os numera
  return episodes.find((e) => e.season === season && e.local === episode) || null;
}

/** Faixas que valem tentar, dublado primeiro (público brasileiro). */
function orderStreams(streams) {
  const ok = (Array.isArray(streams) ? streams : []).filter((s) => s && !s.is_offline && String(s.url || '').trim());
  const dubbed = ok.filter((s) => /^dublado$/i.test(String(s.audio || '').trim()));
  const others = ok.filter((s) => !dubbed.includes(s));
  return [...dubbed, ...others];
}

function cdnProfile(cfg, streamUrl) {
  const host = new URL(streamUrl).hostname.toLowerCase();
  const root = host.split('.').slice(-2).join('.');
  return {
    kind: 'domain',
    root,
    allowLocal: cfg.allowLocal,
    headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', Origin: cfg.site, Referer: cfg.site + '/' }
  };
}

function allowedByProfile(profile) {
  return (raw, relativeTo) => {
    let u;
    try {
      u = new URL(raw, relativeTo);
    } catch (err) {
      return null;
    }
    const host = u.hostname.toLowerCase();
    if (!profile.allowLocal) {
      if (u.protocol !== 'https:') return null;
      if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null;
    } else if (!/^https?:$/.test(u.protocol)) {
      return null;
    }
    return host === profile.root || host.endsWith('.' + profile.root) ? u.toString() : null;
  };
}

/**
 * @returns {Promise<object|null>} resultado no formato da cascata
 */
async function findAnimeStream({ id, type, season, episode, title }) {
  const cfg = config();
  if (!cfg.enabled) return null;

  const info = await loadTmdbInfo(cfg, id, type);
  if (!info || !info.isAnime) return null; // só tenta animação japonesa: não custa nada aos outros títulos

  const names = [title, ...info.names].filter(Boolean);
  const queries = [...new Set(names.map(normTitle).filter(Boolean))].slice(0, 4);

  let match = null;
  for (const q of queries) {
    const results = await searchAnime(cfg, q);
    match = bestMatch(results, names);
    if (match && match.score >= 100) break; // título idêntico: não precisa buscar mais
    if (match) break;
  }
  if (!match) return null;

  const episodes = await loadEpisodes(cfg, match.anime.id);
  const ep = pickEpisode(episodes, info.seasons, season, episode, type === 'movie');
  if (!ep) return null;

  const epRes = await fetchJson(`${cfg.api}/episode/${encodeURIComponent(ep.id)}?v=${API_VERSION}`, apiHeaders(cfg));
  if (!epRes.ok || !epRes.data || !epRes.data.data) return null;

  for (const stream of orderStreams(epRes.data.data.streams)) {
    let profile;
    try {
      profile = cdnProfile(cfg, stream.url);
    } catch (err) {
      continue;
    }
    const allow = allowedByProfile(profile);
    if (!allow(stream.url)) continue;

    // Confere de verdade (playlist -> variante -> 1º segmento) antes de entregar.
    const check = await validateSource(
      { url: stream.url, type: 'hls' },
      { normalize: allow, headers: profile.headers, timeoutMs: 10000 }
    );
    lastReport = {
      at: new Date().toISOString(),
      anime: resultTitles(match.anime)[0] || '?',
      score: match.score,
      episodio: ep.num,
      audio: stream.audio || '?',
      ok: check.ok,
      motivo: check.ok ? null : check.reason
    };
    if (!check.ok) continue;

    return {
      url: stream.url,
      provider: 'AnimeFire' + (stream.audio ? ' · ' + stream.audio : ''),
      quality: 'auto',
      isHls: true,
      bridge: profile,
      captions: []
    };
  }
  return null;
}

let lastReport = null;
function getAnimeReport() {
  return lastReport;
}

module.exports = {
  findAnimeStream,
  getAnimeReport,
  // exportados para teste
  normTitle,
  titleScore,
  bestMatch,
  pickEpisode,
  numberAcrossSeasons,
  orderStreams
};
