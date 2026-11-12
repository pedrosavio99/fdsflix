'use strict';

require('dotenv').config({ quiet: true });

const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { getVidLinkStream, probeVideo } = require('./lib/streamExtractor');
const { getFallbackStream, getProviderList, getCineProReport } = require('./lib/fallbackCascade');
const { getAnimeReport } = require('./lib/animeFire');
const cineproRunner = require('./lib/cineproRunner');
const { normalizeCineProUrl } = require('./lib/cineproUrl');
const {
  startHlsSession,
  stopSession,
  getSession,
  touchSession,
  activeSessions,
  hasFfmpeg,
  shutdown
} = require('./lib/transcoder');
const { proxyVideo, USER_AGENT, TOKEN_TTL_MS } = require('./lib/proxy');
const { srtToVtt, shiftVtt, decodeSubtitle, stripSpamCues, analyzeVtt } = require('./lib/subtitles');
const { translateVtt } = require('./lib/translate');
const registry = require('./lib/registry');
const usageLedger = require('./lib/usageLedger');
const visitors = require('./lib/visitors');
const egress = require('./lib/egressMeter');
const poolKit = require('./lib/poolKit');
const liveTv = require('./lib/liveTv');
const liveEpg = require('./lib/liveEpg');
const { relayFetch, getRelayConfig } = require('./lib/relayFetch');
const { edgeEnabled, canUseEdge, edgeReachable, edgeUrl } = require('./lib/edgeMedia');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const TMDB_API_KEY = String(process.env.TMDB_API_KEY || '').trim();
const FFMPEG_OK = hasFfmpeg();
const TMDB_BASE = 'https://api.themoviedb.org/3';

// API pública (opcional): se API_KEY estiver definida, /api/search, /api/popular
// e /api/stream exigem o header x-api-key (ou ?key=). Sem ela, a API fica aberta.
const API_KEY = String(process.env.API_KEY || '').trim();
// URL pública do backend (ex.: https://fdsflix.onrender.com). Se vazia, é
// derivada do próprio request — necessário para devolver URLs absolutas.
const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  ''
).trim().replace(/\/+$/, '');
// Teto de resolução da transcodificação. Em hosts fracos (Render Free) use 360.
const MAX_TRANSCODE_HEIGHT = Math.max(
  240,
  Math.min(1080, Number(process.env.MAX_TRANSCODE_HEIGHT) || 720)
);

app.disable('x-powered-by');
// Necessário para req.protocol correto atrás de proxy (Render/Vercel).
app.set('trust proxy', true);
// Medidor de banda de saída (o que o Render Free conta). Vem ANTES da compressão para medir o que sai de fato.
app.use(egress.middleware);
// Comprime texto (html/js/json/css/wasm/vtt). Vídeo não entra: já é comprimido e passa por pipe.
app.use(compression({
  filter: (req, res) => {
    if (req.path === '/api/proxy' || req.path === '/api/hls-proxy' || req.path.startsWith('/hls/')) return false;
    return compression.filter(req, res);
  }
}));
app.use(express.json({ limit: '64kb' }));

// CORS: permite que o frontend hospedado na Vercel (outro domínio) consuma a API.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, x-api-key, x-stats-key');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Contador de acessos por IP (lib/visitors.js). Síncrono e barato; qualquer erro é ignorado.
visitors.init();
app.use((req, res, next) => {
  try { visitors.record(req); } catch (err) { /* estatística nunca derruba o site */ }
  next();
});

// Config do frontend gerada no Render quando ADSHIELD_BASE_URL está definido.
// Sem a variável, cai no public/config.js estático.
// API_ONLY=1: o Render deixa de servir o site (HTML/JS/wasm) e só responde a API. O site passa a vir de um
// host estático (Cloudflare Pages/Netlify/Vercel), então os ~1 MB por visita não saem mais da banda do Render.
// FRONTEND_URL (opcional): quem abrir a URL do Render é redirecionado para lá.
const API_ONLY = /^(1|true|yes)$/i.test(String(process.env.API_ONLY || ''));
const FRONTEND_URL = String(process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
if (API_ONLY) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/hls/')) return next();
    if (FRONTEND_URL && (req.method === 'GET' || req.method === 'HEAD')) return res.redirect(302, FRONTEND_URL + req.originalUrl);
    return res.status(404).json({ error: 'Este servidor só entrega a API (API_ONLY=1).' });
  });
}

app.get('/config.js', (req, res, next) => {
  const adshieldBase = String(process.env.ADSHIELD_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!adshieldBase) return next();
  res.type('application/javascript').send(
    'window.__FDSFLIX_CONFIG__ = ' +
      JSON.stringify({ apiBase: '', apiKey: '', embedProxyBase: adshieldBase }) +
      ';\n'
  );
});

// vendor/ quase não muda (7 dias) e cv/ é do app (1 dia): evita rebaixar ~1 MB (hls.js, wasm, mp4box) a cada
// visita e a cada deploy. O resto (index.html etc.) continua revalidando, então atualizações chegam.
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor'), { maxAge: '7d' }));
app.use('/cv', express.static(path.join(__dirname, 'public', 'cv'), { maxAge: '1d' }));
app.use(express.static(path.join(__dirname, 'public')));

const TMDB_LANG = 'pt-BR';

function publicBase(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  return `${req.protocol}://${req.get('host')}`;
}

/** Devolve URLs absolutas — essenciais para clientes externos usarem a API. */
function absoluteUrl(req, urlPath) {
  if (!urlPath) return urlPath;
  if (/^https?:\/\//i.test(urlPath)) return urlPath;
  return publicBase(req) + (urlPath.charAt(0) === '/' ? urlPath : '/' + urlPath);
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const provided = String(req.get('x-api-key') || req.query.key || '');
  if (provided && provided === API_KEY) return next();
  return res.status(401).json({
    error: 'API key inválida. Envie o header x-api-key ou o parâmetro ?key=.'
  });
}

const LANG_MAP = {
  'português': 'pt',
  'portugues': 'pt',
  'portuguese': 'pt',
  'english': 'en',
  'inglês': 'en',
  'ingles': 'en',
  'español': 'es',
  'espanhol': 'es',
  'spanish': 'es',
  'français': 'fr',
  'francês': 'fr',
  'frances': 'fr',
  'french': 'fr',
  'deutsch': 'de',
  'alemão': 'de',
  'italiano': 'it',
  'italian': 'it',
  '日本語': 'ja',
  '한국어': 'ko',
  '中文': 'zh',
  'русский': 'ru',
  'russian': 'ru',
  'हिन्दी': 'hi',
  'العربية': 'ar',
  'اَلْعَرَبِيَّةُ': 'ar',
  'türkçe': 'tr',
  'polski': 'pl',
  'nederlands': 'nl',
  'bahasa indonesia': 'id',
  'indonesian': 'id',
  'melayu': 'ms',
  'malay': 'ms',
  'filipino': 'fil',
  'tiếng việt': 'vi',
  'ไทย': 'th',
  'svenska': 'sv',
  'suomi': 'fi',
  'norsk': 'no',
  'dansk': 'da',
  'čeština': 'cs',
  'magyar': 'hu',
  'română': 'ro',
  'български': 'bg',
  'українська': 'uk',
  'עברית': 'he',
  'فارسی': 'fa',
  'eesti': 'et',
  'latviešu': 'lv',
  'lietuvių': 'lt'
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function normalizeLang(label) {
  const key = String(label || '').trim().toLowerCase();
  if (LANG_MAP[key]) return LANG_MAP[key];
  if (/^[a-z]{2}$/.test(key)) return key;
  return 'und';
}

/** A borda (Worker) pode entregar esse vídeo? Liga + URL pública + sonda de 1 byte passou. */
async function edgeDecision(url, extra = {}) {
  if (!edgeEnabled() || !canUseEdge(url)) return { use: false, reason: null };
  const probe = await edgeReachable({ url, ...extra });
  return probe.ok ? { use: true, reason: null } : { use: false, reason: probe.reason };
}

function pickQualityKey(qualities, preferred) {
  const available = Object.keys(qualities || {})
    .map((key) => ({ key, height: Number(key) }))
    .filter((item) => Number.isFinite(item.height) && item.height > 0)
    .sort((a, b) => b.height - a.height);

  if (!available.length) return null;
  if (preferred > 0) {
    const exact = available.find((item) => item.height === preferred);
    if (exact) return exact.key;
    const lower = available.find((item) => item.height < preferred);
    if (lower) return lower.key;
  }
  return available[0].key;
}

/**
 * Para transcodificar, escolhe a menor qualidade de ORIGEM suficiente para o
 * alvo — assim o ffmpeg decodifica menos e sobra CPU para converter em tempo real.
 */
function pickQualityKeyAtMost(qualities, limit) {
  const available = Object.keys(qualities || {})
    .map((key) => ({ key, height: Number(key) }))
    .filter((item) => Number.isFinite(item.height) && item.height > 0)
    .sort((a, b) => b.height - a.height);

  if (!available.length) return null;
  const lower = available.find((item) => item.height <= limit);
  if (lower) return lower.key;
  return available[available.length - 1].key;
}

// Idioma-base para traduzir quando a faixa não tem legenda em português: inglês primeiro
// (é a que as fontes mais têm e a que melhor traduz), depois idiomas próximos.
const TRANSLATE_SOURCE_ORDER = ['en', 'es', 'fr', 'it', 'de'];
const TRANSLATE_TARGET = 'pt';
const TRANSLATE_LABEL = 'Português (Brasil) · tradução automática';

function buildCaptions(rawCaptions, autoShift = 0) {
  const captions = (Array.isArray(rawCaptions) ? rawCaptions : []).map((caption) => {
    const lang = normalizeLang(caption.language);
    const token = registry.register('subtitle', { url: caption.url, autoShift, lang }, TOKEN_TTL_MS);
    return {
      label: caption.language || 'Legenda',
      srclang: lang,
      default: false,
      url: `/api/subtitle?t=${token}`
    };
  });

  // Tradução automática para PT-BR: o servidor baixa a legenda de origem e troca só o texto,
  // sem mexer nos tempos (continua sincronizada). Só é feita quando alguém abre a faixa.
  const hasPt = captions.some((caption) => caption.srclang === TRANSLATE_TARGET);
  const sources = (Array.isArray(rawCaptions) ? rawCaptions : []).filter((c) => c && c.url && normalizeLang(c.language) !== TRANSLATE_TARGET);
  if (sources.length) {
    const rank = (c) => {
      const i = TRANSLATE_SOURCE_ORDER.indexOf(normalizeLang(c.language));
      return i === -1 ? TRANSLATE_SOURCE_ORDER.length : i;
    };
    const source = sources.slice().sort((a, b) => rank(a) - rank(b))[0];
    const token = registry.register('subtitle', {
      url: source.url,
      autoShift,
      lang: normalizeLang(source.language),
      translateTo: TRANSLATE_TARGET
    }, TOKEN_TTL_MS);
    const translated = {
      label: TRANSLATE_LABEL,
      srclang: TRANSLATE_TARGET,
      translated: true,
      from: normalizeLang(source.language),
      default: false,
      url: `/api/subtitle?t=${token}`
    };
    // Sem PT nativo: a tradução vira a primeira opção (e o padrão). Com PT nativo: fica no fim,
    // como reserva caso o arquivo nativo venha quebrado/incompleto.
    if (hasPt) captions.push(translated); else captions.unshift(translated);
  }

  const preferred =
    captions.find((caption) => caption.srclang === 'pt') ||
    captions.find((caption) => caption.srclang === 'en') ||
    captions[0];

  if (preferred) preferred.default = true;
  return captions;
}

function makeRefresher({ id, type, season, episode, qualityKey, provider, title }) {
  return async () => {
    if (provider === 'VidLink Pro') {
      const fresh = await getVidLinkStream({ id, type, season, episode, force: true });
      if (!fresh) return null;
      if (qualityKey && fresh.qualities && fresh.qualities[qualityKey]) return fresh.qualities[qualityKey].url;
      return fresh.url;
    }
    const fresh = await getFallbackStream({ id, type, season, episode, title });
    if (!fresh) return null;
    if (qualityKey && fresh.qualities && fresh.qualities[qualityKey]) return fresh.qualities[qualityKey].url;
    return fresh.url;
  };
}

async function tmdbFetch(pathname, lang = TMDB_LANG) {
  if (!TMDB_API_KEY) return null;
  const url = `${TMDB_BASE}${pathname}${pathname.includes('?') ? '&' : '?'}api_key=${TMDB_API_KEY}&language=${lang}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.warn('[tmdb] erro:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function mapTmdbItem(item, fallbackType) {
  if (!item) return null;
  // /movie/popular e /tv/popular não trazem media_type: quem chama informa o tipo.
  const kind = item.media_type || fallbackType;
  const type = kind === 'tv' ? 'tv' : kind === 'movie' ? 'movie' : null;
  if (!type) return null;
  return {
    id: item.id,
    title: item.title || item.name || 'Sem título',
    year: String(item.release_date || item.first_air_date || '').slice(0, 4),
    type,
    poster: item.poster_path || '',
    overview: String(item.overview || '').slice(0, 220),
    rating: item.vote_average ? Math.round(item.vote_average * 10) / 10 : 0
  };
}

/* ------------------------------------------------------------------ */
/* TMDB                                                                */
/* ------------------------------------------------------------------ */

app.get('/api/search', requireApiKey, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Parâmetro q é obrigatório' });
  if (!TMDB_API_KEY) return res.status(503).json({ error: 'TMDB_API_KEY não configurada no .env' });

  const data = await tmdbFetch(`/search/multi?include_adult=false&query=${encodeURIComponent(query)}`);
  if (!data) return res.status(502).json({ error: 'Falha ao consultar o TMDB' });

  const results = (data.results || []).map(mapTmdbItem).filter(Boolean);
  res.json({ results });
});


// Detalhes de um título para o modal: sinopse, elenco, temporadas e RECOMENDADOS.
const detailsCache = new Map();
const DETAILS_TTL_MS = 30 * 60 * 1000;

function pickCertification(data, type) {
  try {
    if (type === 'movie') {
      const list = (data.release_dates && data.release_dates.results) || [];
      const region = list.find((r) => r.iso_3166_1 === 'BR') || list.find((r) => r.iso_3166_1 === 'US');
      const hit = region && region.release_dates.find((r) => r.certification);
      return hit ? hit.certification : '';
    }
    const list = (data.content_ratings && data.content_ratings.results) || [];
    const region = list.find((r) => r.iso_3166_1 === 'BR') || list.find((r) => r.iso_3166_1 === 'US');
    return region ? region.rating : '';
  } catch (err) {
    return '';
  }
}

app.get('/api/details', requireApiKey, async (req, res) => {
  const id = String(req.query.id || '');
  const type = String(req.query.type || '');
  if (!/^\d+$/.test(id) || (type !== 'movie' && type !== 'tv')) {
    return res.status(400).json({ error: 'id/type inválidos' });
  }
  if (!TMDB_API_KEY) return res.status(503).json({ error: 'TMDB_API_KEY não configurada' });

  const key = `${type}:${id}`;
  const cached = detailsCache.get(key);
  if (cached && cached.expires > Date.now()) return res.json(cached.value);

  const extras = type === 'movie' ? 'credits,recommendations,similar,release_dates'
    : 'credits,recommendations,similar,content_ratings';
  const data = await tmdbFetch(`/${type}/${id}?append_to_response=${extras}`);
  if (!data) return res.status(502).json({ error: 'Falha ao consultar o TMDB' });

  // Sem sinopse em português? Usa a em inglês em vez de deixar vazio.
  let overview = data.overview || '';
  if (!overview) {
    const en = await tmdbFetch(`/${type}/${id}`, 'en-US');
    overview = (en && en.overview) || '';
  }

  const seen = new Set([key]);
  const recommendations = [];
  for (const list of [data.recommendations, data.similar]) {
    for (const raw of (list && list.results) || []) {
      const mapped = mapTmdbItem(raw, type);
      if (!mapped || !mapped.poster) continue;
      const k = `${mapped.type}:${mapped.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      recommendations.push(mapped);
      if (recommendations.length >= 24) break;
    }
    if (recommendations.length >= 24) break;
  }

  const crew = (data.credits && data.credits.crew) || [];
  const value = {
    id: data.id,
    type,
    title: data.title || data.name || '',
    originalTitle: data.original_title || data.original_name || '',
    tagline: data.tagline || '',
    overview,
    year: String(data.release_date || data.first_air_date || '').slice(0, 4),
    runtime: type === 'movie' ? (data.runtime || 0) : ((data.episode_run_time && data.episode_run_time[0]) || 0),
    genres: (data.genres || []).map((g) => g.name),
    rating: data.vote_average ? Math.round(data.vote_average * 10) / 10 : 0,
    votes: data.vote_count || 0,
    backdrop: data.backdrop_path || '',
    poster: data.poster_path || '',
    certification: pickCertification(data, type),
    status: data.status || '',
    seasons: type === 'tv'
      ? (data.seasons || []).filter((s) => s.season_number > 0).map((s) => ({ n: s.season_number, name: s.name, episodes: s.episode_count }))
      : [],
    directors: type === 'movie'
      ? crew.filter((c) => c.job === 'Director').map((c) => c.name).slice(0, 3)
      : (data.created_by || []).map((c) => c.name).slice(0, 3),
    cast: ((data.credits && data.credits.cast) || []).slice(0, 12)
      .map((c) => ({ name: c.name, character: c.character || '', photo: c.profile_path || '' })),
    recommendations
  };

  detailsCache.set(key, { value, expires: Date.now() + DETAILS_TTL_MS });
  if (detailsCache.size > 300) detailsCache.delete(detailsCache.keys().next().value);
  res.json(value);
});

// Episódios de uma temporada (nome, sinopse curta, duração, imagem) para a lista do player.
const seasonCache = new Map();

app.get('/api/season', requireApiKey, async (req, res) => {
  const id = String(req.query.id || '');
  const n = Number(req.query.n);
  if (!/^\d+$/.test(id) || !Number.isInteger(n) || n < 0 || n > 200) {
    return res.status(400).json({ error: 'id/n inválidos' });
  }
  if (!TMDB_API_KEY) return res.status(503).json({ error: 'TMDB_API_KEY não configurada' });

  const key = `${id}:${n}`;
  const cached = seasonCache.get(key);
  if (cached && cached.expires > Date.now()) return res.json(cached.value);

  const data = await tmdbFetch(`/tv/${id}/season/${n}`);
  if (!data) return res.status(502).json({ error: 'Falha ao consultar o TMDB' });

  let list = data.episodes || [];
  // Sinopse/nome que faltam em português: completa com o inglês (melhor que vazio).
  if (list.some((ep) => !ep.overview || !ep.name)) {
    const en = await tmdbFetch(`/tv/${id}/season/${n}`, 'en-US');
    const byNumber = new Map(((en && en.episodes) || []).map((ep) => [ep.episode_number, ep]));
    list = list.map((ep) => {
      const fb = byNumber.get(ep.episode_number) || {};
      return { ...ep, name: ep.name || fb.name || '', overview: ep.overview || fb.overview || '' };
    });
  }

  const value = {
    n,
    name: data.name || '',
    episodes: list.map((ep) => ({
      e: ep.episode_number,
      name: ep.name || '',
      overview: String(ep.overview || '').slice(0, 280),
      runtime: ep.runtime || 0,
      still: ep.still_path || '',
      air: ep.air_date || ''
    }))
  };

  seasonCache.set(key, { value, expires: Date.now() + DETAILS_TTL_MS });
  if (seasonCache.size > 400) seasonCache.delete(seasonCache.keys().next().value);
  res.json(value);
});

let popularCache = { expires: 0, results: [] };

app.get('/api/popular', requireApiKey, async (req, res) => {
  if (!TMDB_API_KEY) return res.json({ results: [] });
  if (popularCache.results.length && popularCache.expires > Date.now()) {
    return res.json({ results: popularCache.results });
  }

  const [trending, popularMovies, popularTv] = await Promise.all([
    tmdbFetch('/trending/all/week'),
    tmdbFetch('/movie/popular'),
    tmdbFetch('/tv/popular')
  ]);

  const seen = new Set();
  const results = [];

  const datasets = [[trending, undefined], [popularMovies, 'movie'], [popularTv, 'tv']];
  for (const [dataset, fallbackType] of datasets) {
    for (const item of (dataset && dataset.results) || []) {
      const mapped = mapTmdbItem(item, fallbackType);
      if (!mapped || seen.has(`${mapped.type}:${mapped.id}`)) continue;
      seen.add(`${mapped.type}:${mapped.id}`);
      results.push(mapped);
      if (results.length >= 36) break;
    }
    if (results.length >= 36) break;
  }

  if (results.length) {
    popularCache = { results, expires: Date.now() + 30 * 60 * 1000 };
  }

  res.json({ results });
});

/* ------------------------------------------------------------------ */
/* Home estilo Netflix: destaque + fileiras que carregam sob demanda     */
/* ------------------------------------------------------------------ */

const GENRE_NAMES = {
  28: 'Ação', 12: 'Aventura', 16: 'Animação', 35: 'Comédia', 80: 'Crime', 99: 'Documentário', 18: 'Drama',
  10751: 'Família', 14: 'Fantasia', 36: 'História', 27: 'Terror', 10402: 'Música', 9648: 'Mistério',
  10749: 'Romance', 878: 'Ficção científica', 10770: 'Cinema TV', 53: 'Suspense', 10752: 'Guerra', 37: 'Faroeste',
  10759: 'Ação e aventura', 10762: 'Infantil', 10763: 'Notícias', 10764: 'Reality', 10765: 'Sci-Fi e fantasia',
  10766: 'Novela', 10767: 'Talk show', 10768: 'Guerra e política'
};

// id da fileira -> título + caminho no TMDB. As fileiras de gênero usam /discover.
const ROW_DEFS = [
  { id: 'trending', title: 'Em alta esta semana', path: '/trending/all/week' },
  { id: 'popular-movies', title: 'Filmes populares', path: '/movie/popular', type: 'movie' },
  { id: 'popular-tv', title: 'Séries populares', path: '/tv/popular', type: 'tv' },
  { id: 'top-movies', title: 'Filmes mais bem avaliados', path: '/movie/top_rated', type: 'movie' },
  { id: 'now-playing', title: 'Nos cinemas agora', path: '/movie/now_playing', type: 'movie' },
  { id: 'top-tv', title: 'Séries mais bem avaliadas', path: '/tv/top_rated', type: 'tv' },
  { id: 'g-action', title: 'Ação', path: '/discover/movie?with_genres=28&sort_by=popularity.desc&vote_count.gte=200', type: 'movie' },
  { id: 'g-comedy', title: 'Comédia', path: '/discover/movie?with_genres=35&sort_by=popularity.desc&vote_count.gte=200', type: 'movie' },
  { id: 'airing', title: 'Séries no ar', path: '/tv/on_the_air', type: 'tv' },
  { id: 'g-horror', title: 'Terror', path: '/discover/movie?with_genres=27&sort_by=popularity.desc&vote_count.gte=200', type: 'movie' },
  { id: 'g-scifi', title: 'Ficção científica', path: '/discover/movie?with_genres=878&sort_by=popularity.desc&vote_count.gte=200', type: 'movie' },
  { id: 'upcoming', title: 'Em breve', path: '/movie/upcoming', type: 'movie' },
  { id: 'g-animation', title: 'Animação', path: '/discover/movie?with_genres=16&sort_by=popularity.desc&vote_count.gte=200', type: 'movie' },
  { id: 'tv-drama', title: 'Séries de drama', path: '/discover/tv?with_genres=18&sort_by=popularity.desc&vote_count.gte=200', type: 'tv' },
  { id: 'g-romance', title: 'Romance', path: '/discover/movie?with_genres=10749&sort_by=popularity.desc&vote_count.gte=200', type: 'movie' },
  { id: 'g-thriller', title: 'Suspense', path: '/discover/movie?with_genres=53&sort_by=popularity.desc&vote_count.gte=200', type: 'movie' },
  { id: 'tv-comedy', title: 'Séries de comédia', path: '/discover/tv?with_genres=35&sort_by=popularity.desc&vote_count.gte=200', type: 'tv' },
  { id: 'g-crime', title: 'Crime', path: '/discover/movie?with_genres=80&sort_by=popularity.desc&vote_count.gte=200', type: 'movie' },
  { id: 'tv-anime', title: 'Animes', path: '/discover/tv?with_genres=16&with_original_language=ja&sort_by=popularity.desc', type: 'tv' },
  { id: 'g-adventure', title: 'Aventura', path: '/discover/movie?with_genres=12&sort_by=popularity.desc&vote_count.gte=200', type: 'movie' },
  { id: 'g-family', title: 'Para a família', path: '/discover/movie?with_genres=10751&sort_by=popularity.desc&vote_count.gte=200', type: 'movie' },
  { id: 'g-docs', title: 'Documentários', path: '/discover/movie?with_genres=99&sort_by=popularity.desc&vote_count.gte=100', type: 'movie' },
  // Grade infinita do fim da página (alterna filmes e séries); não aparece na lista de fileiras.
  { id: 'explore-movie', title: 'Explorar', path: '/discover/movie?sort_by=popularity.desc&vote_count.gte=300', type: 'movie', hidden: true },
  { id: 'explore-tv', title: 'Explorar', path: '/discover/tv?sort_by=popularity.desc&vote_count.gte=300', type: 'tv', hidden: true }
];
const ROW_BY_ID = new Map(ROW_DEFS.map((row) => [row.id, row]));

function mapRowItem(item, fallbackType) {
  const base = mapTmdbItem(item, fallbackType);
  if (!base) return null;
  return {
    ...base,
    backdrop: item.backdrop_path || '',
    genres: (item.genre_ids || []).map((id) => GENRE_NAMES[id]).filter(Boolean).slice(0, 3)
  };
}

const rowCache = new Map();
const ROW_TTL_MS = 30 * 60 * 1000;

async function fetchRow(path, fallbackType, page) {
  const key = `${path}|${page}`;
  const hit = rowCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const data = await tmdbFetch(`${path}${path.includes('?') ? '&' : '?'}page=${page}`);
  if (!data) return null;
  const seen = new Set();
  const results = [];
  for (const item of data.results || []) {
    const mapped = mapRowItem(item, fallbackType);
    if (!mapped || !mapped.poster || seen.has(`${mapped.type}:${mapped.id}`)) continue;
    seen.add(`${mapped.type}:${mapped.id}`);
    results.push(mapped);
  }
  const value = { results, page: data.page || page, totalPages: Math.min(Number(data.total_pages) || 1, 500) };
  if (results.length) {
    rowCache.set(key, { value, expires: Date.now() + ROW_TTL_MS });
    if (rowCache.size > 400) rowCache.delete(rowCache.keys().next().value);   // não cresce sem limite
  }
  return value;
}

// Destaque (banner) + a lista de fileiras. Os itens de cada fileira vêm de /api/row, só quando a
// pessoa rola até ela (a página abre rápido e o TMDB não é consultado à toa).
app.get('/api/home', requireApiKey, async (req, res) => {
  if (!TMDB_API_KEY) return res.json({ hero: [], rows: [] });

  const [trending, topMovies] = await Promise.all([
    fetchRow('/trending/all/week', undefined, 1),
    fetchRow('/movie/popular', 'movie', 1)
  ]);

  const pool = [...((trending && trending.results) || []), ...((topMovies && topMovies.results) || [])];
  const seen = new Set();
  const hero = [];
  for (const item of pool) {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key) || !item.backdrop || !item.overview) continue;
    seen.add(key);
    hero.push(item);
    if (hero.length >= 6) break;
  }

  res.json({ hero, rows: ROW_DEFS.filter((row) => !row.hidden).map((row) => ({ id: row.id, title: row.title })) });
});

// Uma fileira, paginada: /api/row?id=trending&page=2. "because:<tipo>:<id>" = recomendados de um título.
app.get('/api/row', requireApiKey, async (req, res) => {
  if (!TMDB_API_KEY) return res.json({ id: '', title: '', page: 1, totalPages: 1, results: [] });

  const id = String(req.query.id || '');
  const page = Math.max(1, Math.min(500, Math.floor(Number(req.query.page)) || 1));

  let def = ROW_BY_ID.get(id);
  if (!def) {
    const m = /^because:(movie|tv):(\d{1,9})$/.exec(id);
    if (!m) return res.status(400).json({ error: 'Fileira desconhecida' });
    def = { id, title: '', path: `/${m[1]}/${m[2]}/recommendations`, type: m[1] };
  }

  const row = await fetchRow(def.path, def.type, page);
  if (!row) return res.status(502).json({ error: 'Falha ao consultar o TMDB' });
  res.json({ id: def.id, title: def.title, ...row });
});

/* ------------------------------------------------------------------ */
/* Config / health                                                     */
/* ------------------------------------------------------------------ */

app.get('/api/config', (req, res) => {
  res.json({
    hasTmdbKey: Boolean(TMDB_API_KEY),
    ffmpeg: FFMPEG_OK,
    transcode: FFMPEG_OK,
    version: 2,
    fallbacks: getProviderList().map((p) => p.name)
  });
});

// Banda de saída por rota desde que o processo subiu (o que o Render Free conta).
app.get('/api/egress', requireStatsKey, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(egress.snapshot());
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ffmpeg: FFMPEG_OK,
    tmdb: Boolean(TMDB_API_KEY),
    sessions: activeSessions(),
    fallbacks: getProviderList().map((p) => p.name),
    cinepro: cineproRunner.getStatus()
  });
});

// Documentação viva da API (para usar em outros projetos).
app.get('/api', (req, res) => {
  const base = publicBase(req);
  res.json({
    name: 'fdsFlix API',
    version: 2,
    base,
    auth: API_KEY
      ? 'Envie o header x-api-key (ou ?key=) em /api/search, /api/popular e /api/stream.'
      : 'Aberta (sem chave).',
    endpoints: [
      {
        method: 'GET',
        path: '/api/popular',
        description: 'Títulos em alta (TMDB), com cache de 30 min.'
      },
      {
        method: 'GET',
        path: '/api/search?q=matrix',
        description: 'Busca filmes e séries no TMDB.'
      },
      {
        method: 'GET',
        path: '/api/stream?id=603&type=movie&res=480&hevc=0',
        description:
          'Resolve o vídeo. type=movie|tv; s/e para séries; res=360|480|720|1080; ' +
          'hevc=1 aproveita HEVC nativo, hevc=0 força H.264; start=N começa em N segundos; ' +
          'direct=1 (extensão fdsFlix Direct) devolve a URL original do CDN para tocar no navegador. ' +
          'Retorna mode "hls" ou "direct" e uma URL absoluta pronta para tocar.'
      },
      {
        method: 'GET',
        path: '/api/subtitle?t=TOKEN',
        description: 'Legenda convertida para WebVTT (a URL já vem pronta no /api/stream).'
      },
      {
        method: 'GET',
        path: '/hls/:session/index.m3u8',
        description: 'Playlist HLS gerada pelo ffmpeg (usada pelo player/hls.js).'
      },
      {
        method: 'GET',
        path: '/api/health',
        description: 'Status do servidor, do ffmpeg e das sessões ativas.'
      }
    ],
    examples: {
      search: `${base}/api/search?q=matrix`,
      stream: `${base}/api/stream?id=603&type=movie&res=480&hevc=0`,
      streamSeries: `${base}/api/stream?id=1396&type=tv&s=1&e=1&res=480&hevc=0`
    },
    notes: [
      'As URLs de mídia são absolutas e podem ser usadas direto em <video> ou no hls.js.',
      'O modo "hls" transcodifica HEVC -> H.264 e leva alguns segundos para começar.',
      'Sessões HLS ociosas são encerradas após 5 minutos.',
      'Backend no Render gratuito pode levar ~1 min para acordar no primeiro acesso.'
    ]
  });
});

// Teste ativo do Vidsrc em CADA Vercel da pool, disparado pelo botão do painel.
app.get('/api/diag/vidsrc', requireStatsKey, async (req, res) => {
  const pool = usageLedger.getPool();
  if (!pool.length) return res.json({ ok: false, error: 'Nenhuma Vercel configurada (VIDSRC_PROXY_URL / VIDSRC_PROXY_URLS).' });
  const tmdb = /^\d+$/.test(String(req.query.id || '')) ? String(req.query.id) : '603';
  const results = await Promise.all(pool.map(async (base) => {
    const started = Date.now();
    try {
      const r = await fetch(`${base}/vidsrc/probe?tmdb=${tmdb}`, { signal: AbortSignal.timeout(40000) });
      const body = await r.json().catch(() => ({}));
      delete body.master; // leva o token JWT: não devolve
      return { ok: r.ok, base, http: r.status, ms: Date.now() - started, probe: body };
    } catch (err) {
      return { ok: false, base, error: err.message, ms: Date.now() - started };
    }
  }));
  res.json({ ok: results.every((item) => item.ok), tmdb, results });
});

/* ------------------------------------------------------------------ */
/* Consumo das Vercels (barras do painel)                              */
/* ------------------------------------------------------------------ */

app.get('/api/usage', requireStatsKey, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(usageLedger.snapshot());
});

// O navegador informa quantos bytes/segundos de vídeo recebeu de cada Vercel.
app.post('/api/usage', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const items = Array.isArray(body.items) ? body.items.slice(0, 8) : [];
  let accepted = 0;
  for (const item of items) {
    if (item && usageLedger.record(item.base, item.bytes, item.seconds).ok) accepted += 1;
  }
  res.json({ ok: true, accepted });
});

// Histórico e médias (últimos N dias, só o medido). ?format=csv devolve planilha.
app.get('/api/usage/stats', requireStatsKey, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const days = Math.max(1, Math.min(120, Number(req.query.days) || 30));
  if (String(req.query.format || '') === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fdsflix-consumo-vercels.csv"');
    return res.send(usageLedger.toCsv(days));
  }
  res.json({ ...usageLedger.analytics(days), storage: usageLedger.storageStatus() });
});

// "Sincronizar agora": envia o que falta ao Supabase, relê o histórico e devolve o estado.
let lastUsageSync = 0;
app.post('/api/usage/sync', requireStatsKey, async (req, res) => {
  if (Date.now() - lastUsageSync < 5000) {
    return res.status(429).json({ ok: false, error: 'Espere alguns segundos.', storage: usageLedger.storageStatus() });
  }
  lastUsageSync = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  res.json(await usageLedger.syncNow());
});

// SQL das tabelas (para colar no SQL Editor do Supabase).
app.get('/api/usage/schema', requireStatsKey, (req, res) => {
  try {
    res.type('text/plain; charset=utf-8').send(
      fs.readFileSync(path.join(__dirname, 'supabase', 'usage-schema.sql'), 'utf8')
    );
  } catch (err) {
    res.status(404).type('text').send('supabase/usage-schema.sql não está neste servidor.');
  }
});

// Acerta o contador com o número do painel da Vercel. Exige a senha de administrador.
app.post('/api/usage/calibrate', requireStatsKey, (req, res) => {
  const out = usageLedger.calibrate(req.body && req.body.base, req.body && req.body.usedGb);
  res.status(out.ok ? 200 : 400).json(out.ok ? usageLedger.snapshot() : out);
});

/* ------------------------------------------------------------------ */
/* Acessos por IP (painel /visitors.html)                              */
/* ------------------------------------------------------------------ */

// Área do administrador (estatísticas, Configs, diagnóstico, acessos por IP/região).
// Senha embutida de propósito (pedido do dono, só para ter uma barreira mínima): vale 118111 a menos que
// STATS_KEY esteja definida no ambiente, e aí vale a do ambiente. Aceita header x-stats-key (o site),
// x-api-key ou ?key=. A checagem é SEMPRE no servidor; esconder botões no front é só cosmético.
const BUILTIN_STATS_KEY = '118111';

function sameSecret(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireStatsKey(req, res, next) {
  const key = String(process.env.STATS_KEY || BUILTIN_STATS_KEY).trim();
  const provided = String(req.get('x-stats-key') || req.get('x-api-key') || req.query.key || '');
  if (provided && sameSecret(provided, key)) return next();
  return res.status(401).json({ error: 'Área restrita: senha de administrador inválida.' });
}

// O site chama isto ao digitar a senha, só para saber se ela vale.
app.get('/api/admin/check', requireStatsKey, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});

app.get('/api/visitors', requireStatsKey, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json(await visitors.stats({ days: Number(req.query.days) || 7 }));
  } catch (err) {
    res.status(500).json({ error: 'Falha ao montar as estatísticas.' });
  }
});

// SQL da tabela (sem dados, pode ser aberto): para colar no SQL Editor do Supabase.
app.get('/api/visitors/schema', requireStatsKey, (req, res) => {
  try {
    res.type('text/plain; charset=utf-8').send(
      fs.readFileSync(path.join(__dirname, 'supabase', 'visitors-schema.sql'), 'utf8')
    );
  } catch (err) {
    res.status(404).type('text').send('supabase/visitors-schema.sql não está neste servidor.');
  }
});

/* ------------------------------------------------------------------ */
/* Kit "Vercel extra" (botão Configs): zip do adproxy                  */
/* ------------------------------------------------------------------ */

// GET -> .zip do adproxy pronto para subir noutra conta Vercel. Sem variáveis de ambiente:
// PROXY_SECRET e TARGET_ORIGIN vêm embutidos em adproxy/lib/config.js. Sem node_modules/.env.
app.get('/api/pool/kit', requireApiKey, requireStatsKey, (req, res) => {
  if (!poolKit.kitAvailable()) {
    return res.status(404).json({ error: 'A pasta adproxy/ não está neste servidor.' });
  }
  try {
    const kit = poolKit.buildKit();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${kit.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', kit.zip.length);
    res.end(kit.zip);
  } catch (err) {
    res.status(500).json({ error: `Não consegui montar o kit: ${err.message}` });
  }
});

// Para o modal Configs: o kit existe aqui? Quantas Vercels já estão no pool?
app.get('/api/pool/info', requireApiKey, requireStatsKey, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    kit: poolKit.kitAvailable(),
    poolSize: usageLedger.getPool().length
  });
});

/* ------------------------------------------------------------------ */
/* Stream                                                              */
/* ------------------------------------------------------------------ */

/** Estado do servidor para o painel de diagnóstico (sem segredos: só hosts e flags). */
function buildStreamDebug(trace, startedAt) {
  const hostOf = (value) => {
    try { return value ? new URL(value).origin : null; } catch (err) { return String(value || '') || null; }
  };
  return {
    build: String(process.env.RENDER_GIT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7),
    vidsrcProxy: hostOf(usageLedger.getPool()[0]),
    vidsrcPool: usageLedger.rankedPool(),
    adshield: hostOf(process.env.ADSHIELD_BASE_URL),
    relay: Boolean(process.env.VIDEO_RELAY_URL),
    fallbackOrder: process.env.FALLBACK_ORDER || '(padrão)',
    providers: getProviderList().map((p) => p.name),
    totalMs: Date.now() - startedAt,
    trace
  };
}

/* ------------------------------------------------------------------ */
/* Trava da banda do Render: o vídeo NÃO sai por aqui (5 GB/mês)       */
/* ------------------------------------------------------------------ */

// Por padrão o Render nunca entrega vídeo: se a única fonte disponível exigir passar os bytes por ele
// (/api/proxy, /api/hls-proxy, conversão ffmpeg em /hls), essa fonte é PULADA e a cascata segue para a próxima.
// Para voltar ao comportamento antigo (aceitar gastar a banda do Render): ALLOW_RENDER_VIDEO=1.
const ALLOW_RENDER_VIDEO = /^(1|true|yes)$/i.test(String(process.env.ALLOW_RENDER_VIDEO || ''));
const RENDER_VIDEO_MSG =
  'Todas as fontes disponíveis agora passariam o vídeo pelo servidor (Render), e isso está bloqueado para poupar a banda ' +
  'grátis de 5 GB/mês. Tente de novo em instantes (o Vidsrc costuma voltar) ou libere com ALLOW_RENDER_VIDEO=1 no Render.';

/**
 * Mensagem do 503 com o motivo REAL. A trava do Render só entra quando a fonte principal (Vidsrc pelas Vercels) não
 * respondeu e as outras só entregariam pelo Render; dizer só "bloqueado" escondia que o problema era a fonte principal.
 */
function outageMessage(trace) {
  const vp = (trace || []).find((t) => t.provider === 'Vidsrc Proxy');
  const resumo = vp && vp.notes.map((n) => String(n)).find((n) => n.startsWith('RESUMO:'));
  if (!resumo) return RENDER_VIDEO_MSG;
  const skipped = trace.filter((t) => t.outcome === 'PULADA').map((t) => t.provider);
  return `A fonte principal (Vidsrc, pelas Vercels) não respondeu agora (${resumo.slice(7).trim()}). ` +
    (skipped.length ? `As outras fontes (${skipped.join(', ')}) só entregariam pelo Render, bloqueado para poupar os 5 GB/mês. ` : '') +
    'Isso costuma passar em instantes: tente de novo em alguns segundos.';
}

/** true se entregar esta fonte ao navegador gastaria banda de saída do Render. */
async function renderBound(info, { hevcOk, direct }) {
  if (direct) return false; // extensão fdsFlix Direct: o navegador busca no CDN
  const isHls = info.provider !== 'VidLink Pro' && (info.isHls || /\.m3u8(\?|$)/i.test(info.url));
  if (isHls) {
    const profile = info.viaCinePro ? { kind: 'cinepro' } : (info.bridge || null);
    if (!profile) return false; // URL direta (ex.: Vercel): o navegador baixa de lá
    const edgeOk = profile.kind === 'domain' && !profile.allowLocal && edgeEnabled() && canUseEdge(info.url);
    if (!edgeOk) return true;
    const probe = await edgeReachable({ url: info.url, headers: profile.headers, root: profile.root });
    return !probe.ok;
  }
  let codec = String(info.codec || '').toLowerCase();
  if (!codec) {
    try { codec = String((await probeVideo(info.url)).codec || '').toLowerCase(); } catch (err) { codec = ''; }
  }
  if (/hevc|h265|hvc1|hev1/.test(codec) && !hevcOk) return true; // viraria ffmpeg no Render
  return !(await edgeDecision(info.url)).use;                   // arquivo direto: só a borda poupa o Render
}

// Rede de segurança: mesmo que alguma rota escape da checagem acima, o Render não serve vídeo a clientes
// externos. Só aceita chamadas do próprio servidor (o ffmpeg lê de 127.0.0.1).
function blockRenderVideo(req, res, next) {
  if (ALLOW_RENDER_VIDEO) return next();
  const addr = String((req.socket && req.socket.remoteAddress) || '');
  if (addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.')) return next();
  return res.status(403).json({ error: RENDER_VIDEO_MSG });
}

app.get('/api/stream', requireApiKey, async (req, res) => {
  const id = String(req.query.id || '');
  const type = String(req.query.type || '');

  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'id inválido' });
  if (type !== 'movie' && type !== 'tv') {
    return res.status(400).json({ error: 'type deve ser "movie" ou "tv"' });
  }

  const season = Math.max(1, Number(req.query.s) || 1);
  const episode = Math.max(1, Number(req.query.e) || 1);
  const hevcOk = String(req.query.hevc || '') === '1';
  const direct = String(req.query.direct || '') === '1';
  const preferred = Number(req.query.res) || 0;
  const startAt = Math.max(0, Math.min(6 * 3600, Math.floor(Number(req.query.start) || 0)));
  const title = String(req.query.title || '').trim();

  console.log(
    `[stream] id=${id} type=${type} s=${season} e=${episode} res=${preferred || 'auto'} hevc=${hevcOk ? 'sim' : 'não'} start=${startAt}s${title ? ` title="${title}"` : ''}`
  );

  // Diagnóstico mostrado no painel abaixo do player: caminho exato da cascata.
  const trace = [];
  const startedAt = Date.now();
  const jsonWithDebug = res.json.bind(res);
  res.json = (body) => jsonWithDebug(body && typeof body === 'object' && !Array.isArray(body)
    ? { ...body, debug: buildStreamDebug(trace, startedAt) }
    : body);

  try {
    let streamInfo = null;
    const skip = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      streamInfo = await getFallbackStream({ id, type, season, episode, title, trace, skip });
      if (!streamInfo || !streamInfo.url || ALLOW_RENDER_VIDEO) break;
      let bound = false;
      try { bound = await renderBound(streamInfo, { hevcOk, direct }); } catch (err) { bound = true; }
      if (!bound) break;
      console.log(`[stream] ${streamInfo.provider} passaria o vídeo pelo Render: pulada (ALLOW_RENDER_VIDEO desligado)`);
      const used = trace.filter((t) => t.provider === streamInfo.provider && t.outcome === 'USADO').pop();
      if (used) {
        used.outcome = 'PULADA';
        used.notes.push('Passaria o vídeo pelo Render e gastaria a banda de 5 GB/mês; seguindo para a próxima fonte.');
      }
      // Não repete quem já tentou e não achou nada: a próxima rodada começa depois do provedor pulado.
      for (const t of trace) if (t.outcome === 'sem resultado' || t.outcome === 'erro') skip.push(t.provider);
      skip.push(streamInfo.provider);
      streamInfo = null;
    }

    if (!streamInfo && skip.length) {
      console.log('[stream] nenhuma fonte sem gastar o Render: ' + skip.join(', '));
      return res.status(503).json({ error: outageMessage(trace), retryable: true });
    }

    if (!streamInfo || !streamInfo.url) {
      console.log('[stream] nenhuma fonte encontrou esse título');
      return res.status(404).json({
        error: 'Nenhuma fonte encontrou o stream para este título. Tente outro filme/episódio ou verifique os serviços locais.'
      });
    }

    // VidLink Pro mantém sempre o fluxo original (proxy + sonda de codec + transcodificação).
    // O atalho HLS direto é só para as fontes externas da cascata.
    const isHlsUrl =
      streamInfo.provider !== 'VidLink Pro' &&
      (streamInfo.isHls || /\.m3u8(\?|$)/i.test(streamInfo.url));

    if (isHlsUrl) {
      console.log(`[stream] modo HLS nativo (${streamInfo.provider})`);
      // Fontes que exigem servidor (CinePro em 127.0.0.1, CDN com Referer do site) saem
      // pela nossa ponte com token, nunca por proxy aberto.
      const bridgeProfile = streamInfo.viaCinePro ? { kind: 'cinepro' } : (streamInfo.bridge || null);
      if (streamInfo.viaCinePro) {
        probeVideo(streamInfo.url)
          .then((probe) => hlsEvent({ kind: 'sonda', codec: probe.codec, largura: probe.width, altura: probe.height, navegadorHevc: hevcOk }))
          .catch(() => {});
      }
      // Fonte de domínio público (ex.: AnimeFire): os bytes saem pelo Worker, não pelo Render.
      // CinePro fica no Render porque só existe em 127.0.0.1 (o Worker não alcança).
      let viaEdge =
        Boolean(bridgeProfile) &&
        bridgeProfile.kind === 'domain' &&
        !bridgeProfile.allowLocal &&
        edgeEnabled() &&
        canUseEdge(streamInfo.url);
      if (viaEdge) {
        const probe = await edgeReachable({ url: streamInfo.url, headers: bridgeProfile.headers, root: bridgeProfile.root });
        if (!probe.ok) {
          viaEdge = false;
          console.warn(`[stream] Worker não alcança o provedor (${probe.reason}); HLS sai pelo Render`);
        }
      }
      const hlsUrl = viaEdge
        ? edgeUrl({ url: streamInfo.url, headers: bridgeProfile.headers, root: bridgeProfile.root })
        : bridgeProfile
          ? absoluteUrl(req, `/api/hls-proxy?t=${registry.register('hls', { url: streamInfo.url, profile: bridgeProfile })}`)
          : absoluteUrl(req, streamInfo.url);
      if (viaEdge) console.log('[stream] HLS entregue pela borda (Worker)');
      const captions = buildCaptions(streamInfo.captions, 0).map((caption) => ({
        ...caption,
        url: absoluteUrl(req, caption.url)
      }));

      return res.json({
        mode: 'hls',
        via: viaEdge ? 'edge' : (bridgeProfile ? 'origin' : 'direct'),
        url: hlsUrl,
        quality: streamInfo.quality || 'auto',
        codec: streamInfo.codec || 'h264',
        sourceCodec: streamInfo.codec || 'h264',
        transcoded: false,
        provider: streamInfo.provider,
        captions,
        note: null
      });
    }

    let codec = String(streamInfo.codec || '').toLowerCase();
    if (!codec) {
      const probe = await probeVideo(streamInfo.url);
      codec = String(probe.codec || '').toLowerCase();
    }

    const isHevc = /hevc|h265|hvc1|hev1/.test(codec);
    const transcode = isHevc && !hevcOk;
    const target = Math.min(preferred > 0 ? preferred : 480, MAX_TRANSCODE_HEIGHT);

    let qualityKey;
    let outHeight = 0;

    if (transcode) {
      qualityKey = pickQualityKeyAtMost(streamInfo.qualities, target);
      const sourceHeight = Number(qualityKey) || (streamInfo.height ? Number(streamInfo.height) : 1080);
      outHeight = Math.max(240, Math.round(Math.min(target, sourceHeight) / 2) * 2);
    } else {
      qualityKey = pickQualityKey(streamInfo.qualities, preferred);
    }

    const qualityUrl = (qualityKey && streamInfo.qualities && streamInfo.qualities[qualityKey] && streamInfo.qualities[qualityKey].url) || streamInfo.url;

    const refresher = makeRefresher({ id, type, season, episode, qualityKey, provider: streamInfo.provider, title });
    const token = registry.register(
      'video',
      { url: qualityUrl, refresh: refresher, expiresAt: Date.now() + TOKEN_TTL_MS },
      TOKEN_TTL_MS
    );

    // No modo HLS o ffmpeg começa em `startAt` e o player rebobina a linha do
    // tempo para 0; então as legendas precisam voltar `startAt` segundos.
    // No modo direct o vídeo é o arquivo original (o cliente só faz seek),
    // logo a legenda já está alinhada.
    const captions = buildCaptions(streamInfo.captions, transcode ? -startAt : 0).map((caption) => ({
      ...caption,
      url: absoluteUrl(req, caption.url)
    }));

    if (!transcode) {
      // Modo direto no navegador: a extensão fdsFlix Direct troca o UA, remove
      // Referer/Origin e adiciona CORS via declarativeNetRequest. O vídeo vai do
      // CDN direto para o navegador; o Render só devolve este JSON (~1 KB).
      if (direct) {
        console.log(`[stream] modo direto no navegador ${qualityKey || 'auto'} (${streamInfo.provider})`);
        return res.json({
          mode: 'direct',
          via: 'browser',
          url: qualityUrl,
          quality: Number(qualityKey) || streamInfo.quality || 'auto',
          codec: codec || 'desconhecido',
          sourceCodec: codec || 'desconhecido',
          transcoded: false,
          provider: streamInfo.provider,
          captions,
          note: 'Reprodução direta no navegador pela extensão fdsFlix Direct — 0 bytes de vídeo no Render.'
        });
      }

      // Arquivo original sem recodificar: se der, o Worker entrega e o Render só assina o token.
      const edge = await edgeDecision(qualityUrl);
      const viaEdge = edge.use;
      const edgeNote = edge.reason;
      if (edgeNote) console.warn(`[stream] Worker não alcança o provedor (${edgeNote}); vídeo sai pelo Render`);
      console.log(
        `[stream] modo direto ${qualityKey || 'auto'} (${streamInfo.provider}, codec ${codec || '?'}) ` +
        (viaEdge ? 'via borda (Worker)' : 'via Render')
      );
      return res.json({
        mode: 'direct',
        via: viaEdge ? 'edge' : 'origin',
        url: viaEdge ? edgeUrl({ url: qualityUrl }) : absoluteUrl(req, `/api/proxy?t=${token}`),
        quality: Number(qualityKey) || streamInfo.quality || 'auto',
        codec: codec || 'desconhecido',
        sourceCodec: codec || 'desconhecido',
        transcoded: false,
        provider: streamInfo.provider,
        edgeSkipped: edgeNote,
        captions,
        note: null
      });
    }

    if (!FFMPEG_OK) {
      return res.status(503).json({
        error:
          'Seu navegador não reproduz HEVC e o ffmpeg não foi encontrado. ' +
          'Instale com "sudo apt install ffmpeg" (ou equivalente) e reinicie o servidor.'
      });
    }

    // A origem é HEVC: converte para H.264 em HLS (respeitando MAX_TRANSCODE_HEIGHT).
    const inputUrl = `http://127.0.0.1:${PORT}/api/proxy?t=${token}`;
    const session = await startHlsSession({ source: inputUrl, height: outHeight, startAt });

    console.log(`[stream] HLS ${session.id} ${outHeight}p (${streamInfo.provider}, origem ${codec} ${qualityKey || 'auto'})`);

    res.json({
      mode: 'hls',
      url: absoluteUrl(req, `/hls/${session.id}/index.m3u8`),
      sessionId: session.id,
      quality: outHeight,
      sourceQuality: Number(qualityKey) || streamInfo.quality || 'auto',
      codec: 'h264',
      sourceCodec: codec,
      transcoded: true,
      provider: streamInfo.provider,
      captions,
      note:
        `O provedor entrega HEVC e seu navegador não decodifica esse codec. ` +
        `Convertendo para H.264 em ${outHeight}p — pode levar alguns segundos para começar e usa CPU.`
    });
  } catch (err) {
    console.error('[stream] erro:', err);
    res.status(502).json({ error: 'Falha ao preparar o vídeo: ' + err.message });
  }
});

app.all('/api/stream/stop', (req, res) => {
  const sid = (req.body && req.body.sid) || req.query.sid;
  if (sid) stopSession(String(sid));
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* TV ao vivo (cascata própria; o vídeo NUNCA passa pelo Render)       */
/* ------------------------------------------------------------------ */

// Os nós (Vercel/Wasmer, os da Wasmer saem dos EUA) também servem para sondar fontes que só entregam para os EUA.
liveTv.setPoolProvider(() => {
  const ranked = usageLedger.rankedPool().filter((p) => !p.exhausted).map((p) => p.base);
  return ranked.length ? ranked : usageLedger.getPool();
});

app.get('/api/live/channels', requireApiKey, (req, res) => {
  liveTv.warmIfStale();
  res.setHeader('Cache-Control', 'no-store');
  res.json(liveTv.channelsSnapshot());
});

// Programação da TV (guia XMLTV baixado pelo servidor e guardado em memória; só JSON pequeno sai daqui).
//   /api/live/epg           -> o que passa agora e o próximo de cada canal
//   /api/live/epg?ch=<id>   -> grade das próximas ~24 h do canal
app.get('/api/live/epg', requireApiKey, (req, res) => {
  liveEpg.ensure();
  res.setHeader('Cache-Control', 'no-store');
  const ch = String(req.query.ch || '');
  if (ch) {
    if (!liveTv.CHANNELS.some((c) => c.id === ch)) return res.status(404).json({ ok: false, error: 'Canal desconhecido.' });
    return res.json({ ...liveEpg.status(), ok: true, ch, now: Date.now(), items: liveEpg.schedule(ch) });
  }
  res.json({ ...liveEpg.status(), ok: true, now: Date.now(), channels: liveEpg.nowNext() });
});

// Área nerd (administrador): estado interno da TV ao vivo. ?full=1 mostra as URLs inteiras (com credenciais);
// ?retest=<canal> força novo teste das fontes do canal antes de responder.
app.get('/api/live/diag', requireStatsKey, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const retest = String(req.query.retest || '');
    if (retest && liveTv.CHANNELS.some((c) => c.id === retest)) await liveTv.retest(retest);
    const out = liveTv.diagnostics({ full: /^(1|true)$/.test(String(req.query.full || '')) });
    out.pool = usageLedger.getPool();
    out.servidor = { node: process.version, uptimeMin: Math.round(process.uptime() / 60), memoriaMB: Math.round(process.memoryUsage().rss / 1048576) };
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Player de TV que a PRÓPRIA Vercel serve (via AdShield) para fontes HTTP sem CORS. Público de propósito: quem busca é o AdShield,
// sem cabeçalhos. Só gera ~5 KB de HTML com o token recebido; o vídeo não passa pelo Render.
app.get('/api/live/player', (req, res) => {
  try {
    const html = require('./lib/livePlayer').playerHtml(String(req.query.p || ''), String(req.query.k || 'hls'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (err) {
    res.status(400).type('text').send('Pedido inválido.');
  }
});

// Endereço público do Render (o AdShield da Vercel busca o player aqui). RENDER_EXTERNAL_URL é definido pelo próprio Render.
function publicOrigin(req) {
  const fixed = String(process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(fixed)) return fixed;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

app.get('/api/live/stream', requireApiKey, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.query.ch || '');
  const channel = liveTv.CHANNELS.find((c) => c.id === id);
  if (!channel) return res.status(404).json({ ok: false, error: 'Canal desconhecido.' });
  liveTv.touch();

  const sids = (value) => String(value || '').split(',').filter((v) => /^[0-9a-f]{10}$/.test(v)).slice(0, 40);
  // O navegador avisa quando uma fonte que parecia boa não tocou (geobloqueio, token preso ao IP...).
  const badWhy = ['direct', 'novideo'].includes(String(req.query.why)) ? String(req.query.why) : '';
  for (const bad of sids(req.query.bad)) liveTv.reportBad(id, bad, badWhy);
  const skip = sids(req.query.skip);

  try {
    const pool = usageLedger.rankedPool().filter((p) => !p.exhausted).map((p) => p.base);
    const fallbackPool = pool.length ? pool : usageLedger.getPool();
    let tried = 0;
    let lastReason = '';
    const skipped = []; // fontes que tocam, mas que não têm como chegar ao navegador sem gastar o Render
    for (let round = 0; round < 4; round += 1) {
      const found = await liveTv.resolveChannel(id, { skip });
      tried += found.tried;
      // Se já havia fonte boa e foi a ENTREGA que falhou, o motivo útil é o da entrega, não "nenhuma fonte respondeu".
      if (!found.ok) { if (!skipped.length) lastReason = found.error; break; }
      const plan = await liveTv.planDelivery(found.source, { pool: fallbackPool, verify: true, origin: publicOrigin(req) });
      if (plan.mode === 'none') {
        // Esta fonte não tem como chegar ao navegador sem gastar o Render; tenta a próxima.
        lastReason = plan.reason;
        liveTv.logEvent('entrega', `${channel.name}: fonte ${found.source.sid} pulada: ${plan.reason}`);
        skipped.push({ sid: found.source.sid, reason: plan.reason });
        skip.push(found.source.sid);
        continue;
      }
      liveTv.logEvent('entrega', `${channel.name}: ${plan.mode} via ${plan.via}${skipped.length ? ` (${skipped.length} fonte(s) puladas)` : ''}`);
      return res.json({
        ok: true,
        channel: { id: channel.id, name: channel.name, group: channel.group },
        sid: found.source.sid,
        mode: plan.mode,
        url: plan.url,
        kind: found.source.kind,
        via: plan.via,
        tried,
        origin: found.source.origin,
        skipped
      });
    }
    const why = skipped.length
      ? `Há fonte no ar, mas nenhuma conseguiu chegar ao navegador: ${lastReason}`
      : (lastReason || 'Nenhuma fonte deste canal respondeu agora.');
    return res.status(503).json({ ok: false, error: why, tried, skipped });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Falha ao achar o canal: ' + err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Proxy de vídeo / legendas                                           */
/* ------------------------------------------------------------------ */

app.get('/api/proxy', blockRenderVideo, (req, res) => {
  const entry = registry.resolve('video', String(req.query.t || ''));
  if (!entry) {
    return res.status(404).json({ error: 'Sessão de vídeo expirada. Recarregue o player.' });
  }
  proxyVideo(req, res, entry);
});


/* ------------------------------------------------------------------ */
/* Ponte HLS do CinePro (tokens próprios; nunca expõe o /v1/proxy)     */
/* ------------------------------------------------------------------ */

// O /v1/proxy do CinePro aceita um JSON {url, headers} SEM assinatura. Expô-lo
// direto seria um proxy aberto (SSRF). Aqui só buscamos URLs que apareceram em
// playlists que NÓS pedimos, e só dos hosts do "perfil" do token:
//   - { kind: 'cinepro' }                         -> a máquina/porta do CinePro embutido
//   - { kind: 'domain', root, headers, allowLocal } -> o domínio do CDN (ex.: AnimeFire), só https,
//                                                    sem IP literal nem localhost, com os cabeçalhos exigidos.
function allowByProfile(raw, relativeTo, profile) {
  if (!profile || profile.kind === 'cinepro') return normalizeCineProUrl(raw, relativeTo);
  if (profile.kind !== 'domain' || !profile.root) return null;

  let u;
  try {
    u = new URL(raw, relativeTo);
  } catch (err) {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (profile.allowLocal === true) {
    if (!/^https?:$/.test(u.protocol)) return null; // só testes locais
  } else {
    if (u.protocol !== 'https:') return null;
    if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null;
  }
  return host === profile.root || host.endsWith('.' + profile.root) ? u.toString() : null;
}

function profileHeaders(profile) {
  return profile && profile.kind === 'domain' ? profile.headers || {} : {};
}

/** Busca com redirecionamento manual: cada salto precisa passar pelo mesmo filtro de host. */
async function fetchBridged(url, headers, signal, profile) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const res = await relayFetch(current, { headers, signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (res.body) res.body.cancel().catch(() => {});
      const next = loc && allowByProfile(loc, current, profile);
      if (!next) return { blocked: true, status: res.status };
      current = next;
      continue;
    }
    return { res, finalUrl: current };
  }
  return { blocked: true, status: 310 };
}

function rewritePlaylist(text, upstreamUrl, req, profile) {
  const cache = new Map();

  const toBridge = (raw) => {
    const inside = allowByProfile(raw, upstreamUrl, profile);
    if (!inside) {
      // Fora do permitido: não tocamos (o navegador resolve por conta dele).
      try { return new URL(raw, upstreamUrl).toString(); } catch (err) { return raw; }
    }
    if (!cache.has(inside)) {
      cache.set(inside, absoluteUrl(req, `/api/hls-proxy?t=${registry.register('hls', { url: inside, profile })}`));
    }
    return cache.get(inside);
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${toBridge(uri)}"`);
      }
      return toBridge(line.trim());
    })
    .join('\n');
}

// Últimos eventos da ponte HLS (sem URLs nem tokens) para diagnóstico: GET /api/debug/hls
const hlsDebug = [];
function hlsEvent(event) {
  hlsDebug.push({ at: new Date().toISOString(), ...event });
  if (hlsDebug.length > 60) hlsDebug.shift();
}

app.get('/api/debug/hls', requireStatsKey, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ cinepro: cineproRunner.getStatus(), ultimaConsulta: getCineProReport(), ultimaConsultaAnime: getAnimeReport(), events: hlsDebug.slice(-40) });
});

let hlsBridgeLogged = 0;

app.get('/api/hls-proxy', blockRenderVideo, async (req, res) => {
  const entry = registry.resolve('hls', String(req.query.t || ''));
  if (!entry) return res.status(404).json({ error: 'Sessão de vídeo expirada. Recarregue o player.' });

  // Defesa extra: mesmo com token válido, só falamos com os hosts do perfil.
  const profile = entry.profile || { kind: 'cinepro' };
  const targetUrl = allowByProfile(entry.url, undefined, profile);
  if (!targetUrl) return res.status(403).json({ error: 'Origem não permitida' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  res.on('close', () => controller.abort());

  try {
    // identity: sem gzip, para o Content-Length repassado bater com o corpo.
    const headers = { 'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity', ...profileHeaders(profile) };
    if (req.headers.range) headers.Range = req.headers.range;

    const fetched = await fetchBridged(targetUrl, headers, controller.signal, profile);
    clearTimeout(timer);

    if (fetched.blocked) {
      console.warn(`[hls-proxy] redirecionamento ${fetched.status} bloqueado`);
      hlsEvent({ kind: 'erro', status: fetched.status, note: 'redirecionamento bloqueado' });
      return res.status(502).json({ error: 'Redirecionamento do provedor bloqueado.' });
    }
    const upstream = fetched.res;
    if (!upstream.ok && upstream.status !== 206) {
      console.warn(`[hls-proxy] provedor respondeu HTTP ${upstream.status}`);
      hlsEvent({ kind: 'erro', status: upstream.status, ct: upstream.headers.get('content-type'), note: 'upstream com erro' });
      return res.status(502).json({ error: `O provedor respondeu HTTP ${upstream.status}.` });
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    if (!upstream.body) return res.end();

    // Espia o início do corpo: playlist começa com #EXTM3U; qualquer outra coisa
    // (segmento, chave AES) segue como BYTES, sem passar por texto.
    const reader = upstream.body.getReader();
    const first = await reader.read();
    const head = first.value ? Buffer.from(first.value) : Buffer.alloc(0);
    const isPlaylist = /^(﻿)?\s*#EXTM3U/.test(head.subarray(0, 64).toString('utf8'));

    if (isPlaylist) {
      const chunks = [head];
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(Buffer.from(part.value));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const body = rewritePlaylist(text, fetched.finalUrl, req, profile);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      hlsEvent({
        kind: 'playlist',
        status: upstream.status,
        ct: upstream.headers.get('content-type'),
        itens: text.split('\n').filter((l) => l && !l.startsWith('#')).length,
        criptografada: /#EXT-X-KEY:(?!METHOD=NONE)/.test(text),
        fmp4: /#EXT-X-MAP/.test(text),
        variantes: (text.match(/#EXT-X-STREAM-INF/g) || []).length
      });
      if (hlsBridgeLogged < 20) {
        hlsBridgeLogged += 1;
        console.log(`[hls-proxy] playlist ${text.split('\n').filter((l) => l && !l.startsWith('#')).length} itens`);
      }
      return res.send(body);
    }

    res.status(upstream.status);
    for (const name of ['content-type', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    // Só repassa o tamanho se o corpo não veio codificado.
    if (!upstream.headers.get('content-encoding') && upstream.headers.get('content-length')) {
      res.setHeader('Content-Length', upstream.headers.get('content-length'));
    }
    if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/octet-stream');

    if (hlsBridgeLogged < 20) {
      hlsBridgeLogged += 1;
      console.log(`[hls-proxy] mídia ${upstream.status} ${upstream.headers.get('content-type') || '?'} ${upstream.headers.get('content-length') || '?'}b`);
    }

    const startedAt = Date.now();
    let sent = head.length;
    let finished = false;
    res.on('close', () => {
      reader.cancel().catch(() => {});
      if (!finished) hlsEvent({ kind: 'midia-interrompida', status: upstream.status, bytes: sent, ms: Date.now() - startedAt });
    });
    if (head.length && !res.write(head)) await new Promise((resolve) => res.once('drain', resolve));
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      sent += part.value.length;
      if (!res.write(Buffer.from(part.value))) await new Promise((resolve) => res.once('drain', resolve));
    }
    finished = true;
    hlsEvent({
      kind: 'midia',
      status: upstream.status,
      ct: upstream.headers.get('content-type'),
      bytes: sent,
      ms: Date.now() - startedAt,
      comeca: head.subarray(0, 4).toString('hex') // 47xxxxxx = MPEG-TS; 000000xx = fMP4
    });
    res.end();
  } catch (err) {
    clearTimeout(timer);
    console.warn('[hls-proxy] falha:', err.message);
    hlsEvent({ kind: 'erro', note: err.message });
    if (!res.headersSent) res.status(502).json({ error: 'Falha na ponte HLS: ' + err.message });
    else res.destroy();
  }
});

// Baixa, decodifica (UTF-8 ou página de código legada), limpa propaganda e converte para
// WebVTT uma vez; trocar o atraso depois não refaz o download. Guardado por URL de origem:
// a faixa original e a traduzida (e recarregar o player) compartilham o mesmo download.
const SOURCE_TTL_MS = 30 * 60 * 1000;
const SOURCE_MAX = 80;
const subtitleSources = new Map(); // url -> { promise, at }

function fetchSubtitleSource(url, lang) {
  const hit = subtitleSources.get(url);
  if (hit && Date.now() - hit.at < SOURCE_TTL_MS) return hit.promise;

  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT }
      });
      if (!response.ok) {
        const err = new Error(`Falha ao baixar legenda (HTTP ${response.status})`);
        err.status = 502;
        throw err;
      }
      const text = decodeSubtitle(Buffer.from(await response.arrayBuffer()), lang);
      const vtt = /^\s*\uFEFF?WEBVTT/.test(text) ? text : srtToVtt(text);
      const cleaned = stripSpamCues(vtt);
      return {
        vtt: cleaned.vtt,
        spamRemoved: cleaned.removed,
        info: { ...analyzeVtt(cleaned.vtt), spamRemoved: cleaned.removed }
      };
    } finally {
      clearTimeout(timer);
    }
  })();

  subtitleSources.set(url, { promise, at: Date.now() });
  promise.catch(() => { if (subtitleSources.get(url)?.promise === promise) subtitleSources.delete(url); });
  while (subtitleSources.size > SOURCE_MAX) subtitleSources.delete(subtitleSources.keys().next().value);
  return promise;
}

async function loadSubtitleVtt(entry) {
  if (entry.vtt) return entry;
  const source = await fetchSubtitleSource(entry.url, entry.lang);
  entry.vtt = source.vtt;
  entry.spamRemoved = source.spamRemoved;
  // Tradução não muda nº de falas nem tempos: o diagnóstico da origem vale para ela.
  entry.info = source.info;
  return entry;
}

// Tradução pronta (por conteúdo da legenda + idioma). Pedidos simultâneos da mesma legenda
// esperam a mesma tradução em vez de disparar outra. Só guarda se saiu completa.
const TRANSLATION_MAX = 60;
const translations = new Map(); // chave -> { vtt }
const translating = new Map();  // chave -> Promise

function translatedVtt(sourceVtt, to) {
  const key = to + ':' + crypto.createHash('sha1').update(sourceVtt).digest('hex');
  const ready = translations.get(key);
  if (ready) {
    translations.delete(key);
    translations.set(key, ready); // LRU
    return Promise.resolve({ vtt: ready.vtt, complete: true, cached: true });
  }
  if (translating.has(key)) return translating.get(key);

  const job = translateVtt(sourceVtt, { to })
    .then((result) => {
      if (result.complete) {
        translations.set(key, { vtt: result.vtt });
        while (translations.size > TRANSLATION_MAX) translations.delete(translations.keys().next().value);
      }
      console.log(`[legenda] traduzida para ${to}: ${result.translated}/${result.total} falas` + (result.failed ? ` (${result.failed} falharam)` : ''));
      return result;
    })
    .finally(() => translating.delete(key));
  translating.set(key, job);
  return job;
}

app.get('/api/subtitle', async (req, res) => {
  const entry = registry.resolve('subtitle', String(req.query.t || ''));
  if (!entry) return res.status(404).json({ error: 'Legenda expirada. Recarregue o player.' });

  try {
    await loadSubtitleVtt(entry);

    // Faixa de tradução automática: troca só o texto; os tempos seguem os da origem.
    let baseVtt = entry.vtt;
    let complete = true;
    if (entry.translateTo) {
      const tr = await translatedVtt(entry.vtt, entry.translateTo);
      baseVtt = tr.vtt;
      complete = tr.complete;
    }

    // autoShift compensa o "Início (min)"; shift é o ajuste manual do usuário;
    // scale corrige legenda de outro fps (escorrega ao longo do filme).
    const autoShift = Number(entry.autoShift) || 0;
    const manual = Math.max(-600, Math.min(600, Number(req.query.shift) || 0));
    const scale = Math.max(0.8, Math.min(1.25, Number(req.query.scale) || 1));
    const total = autoShift + manual;
    const body = Math.abs(total) > 0.001 || Math.abs(scale - 1) > 1e-6
      ? shiftVtt(baseVtt, total, scale)
      : baseVtt;

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Tradução incompleta (provedor limitado): não deixa o navegador guardar, para tentar de novo.
    res.setHeader('Cache-Control', complete ? 'public, max-age=3600' : 'no-store');
    if (entry.translateTo) res.setHeader('X-Subtitle-Translation', complete ? 'ok' : 'partial');
    res.send(body);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.status ? err.message : 'Falha ao baixar legenda: ' + err.message });
  }
});

// Resumo (nº de falas, onde termina, % de caracteres quebrados) para o player avisar
// de legenda incompleta/corrompida em vez de o usuário achar que "não está sincronizada".
app.get('/api/subtitle/info', async (req, res) => {
  const entry = registry.resolve('subtitle', String(req.query.t || ''));
  if (!entry) return res.status(404).json({ error: 'Legenda expirada. Recarregue o player.' });
  try {
    await loadSubtitleVtt(entry);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(entry.info);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* HLS (ffmpeg)                                                        */
/* ------------------------------------------------------------------ */

app.get('/hls/:id/:file', blockRenderVideo, (req, res) => {
  const { id, file } = req.params;

  if (!/^[a-f0-9]{16}$/.test(id)) return res.status(400).end('id inválido');
  if (!/^(index\.m3u8|seg_\d{5}\.ts)$/.test(file)) return res.status(400).end('arquivo inválido');

  const session = getSession(id);
  if (!session) return res.status(404).end('sessão expirada');

  touchSession(id);

  const filePath = path.join(session.dir, file);
  if (!fs.existsSync(filePath)) return res.status(404).end('ainda não gerado');

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (file.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
  } else {
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

/* ------------------------------------------------------------------ */
/* Start / shutdown                                                    */
/* ------------------------------------------------------------------ */

egress.startLogging();
liveTv.startWarmer();
liveEpg.ensure(); // já deixa a programação pronta antes do primeiro espectador

const server = app.listen(PORT, () => {
  console.log('');
  console.log('🎬 fdsFlix rodando em http://localhost:' + PORT);
  console.log('   TMDB API : ' + (TMDB_API_KEY ? 'configurada' : 'NÃO configurada'));
  console.log('   ffmpeg   : ' + (FFMPEG_OK ? 'disponível (transcodificação ativa)' : 'NÃO encontrado'));
  console.log('   Fallbacks: ' + getProviderList().map((p) => p.name).join(' → '));
  const relayCfg = getRelayConfig();
  console.log('   Relay CF : ' + (relayCfg.enabled ? 'ativo (' + relayCfg.url + ')' : 'desativado (requisições diretas)'));
  console.log('   Vídeo/Render: ' + (ALLOW_RENDER_VIDEO ? 'LIBERADO (ALLOW_RENDER_VIDEO=1): fontes que exigem o Render gastam a banda dele' : 'BLOQUEADO: o vídeo nunca sai pelo Render (fontes que exigiriam isso são puladas)'));
  console.log('   Borda    : ' + (edgeEnabled() ? 'vídeo entregue pelo Worker (não gasta banda do Render)' : 'desligada (vídeo passa pelo Render)'));
  console.log('   Serviços auxiliares (opcionais para catálogo expandido/novelas):');
  console.log('     - CinePro:    ' + (process.env.CINEPRO_API_BASE || 'http://localhost:3001'));
  console.log('     - CineWinx:   ' + (process.env.CINEWINX_API_BASE || 'http://localhost:3002'));
  console.log('     - Consumet:   ' + (process.env.CONSUMET_API_BASE || 'http://localhost:3003'));
  embeddedCinePro = cineproRunner.maybeStart({ tmdbKey: TMDB_API_KEY });
  const embedded = embeddedCinePro;
  console.log('   CinePro  : ' + (embedded.started ? 'embutido em ' + embedded.base : 'não iniciado — ' + embedded.reason));
  if (!FFMPEG_OK) {
    console.log('   ⚠️  Sem ffmpeg o player não consegue converter HEVC para H.264.');
  }
  console.log('');
});

let embeddedCinePro = null;

function gracefulExit() {
  if (embeddedCinePro) embeddedCinePro.stop();
  shutdown();
  // Envia os acessos que ainda não subiram ao Supabase antes de sair (o teto de 3 s continua valendo).
  const closing = () => server.close(() => process.exit(0));
  visitors.flush().then(closing, closing);
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);
