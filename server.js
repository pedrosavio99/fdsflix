'use strict';

require('dotenv').config({ quiet: true });

const express = require('express');
const path = require('path');
const fs = require('fs');

const { getVidLinkStream, probeVideo } = require('./lib/streamExtractor');
const { getFallbackStream, getProviderList } = require('./lib/fallbackCascade');
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
const { srtToVtt, shiftVtt } = require('./lib/subtitles');
const registry = require('./lib/registry');

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
app.use(express.json({ limit: '64kb' }));

// CORS: permite que o frontend hospedado na Vercel (outro domínio) consuma a API.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, x-api-key');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

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

function buildCaptions(rawCaptions, autoShift = 0) {
  const captions = (Array.isArray(rawCaptions) ? rawCaptions : []).map((caption) => {
    const token = registry.register('subtitle', { url: caption.url, autoShift }, TOKEN_TTL_MS);
    return {
      label: caption.language || 'Legenda',
      srclang: normalizeLang(caption.language),
      default: false,
      url: `/api/subtitle?t=${token}`
    };
  });

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

async function tmdbFetch(pathname) {
  if (!TMDB_API_KEY) return null;
  const url = `${TMDB_BASE}${pathname}${pathname.includes('?') ? '&' : '?'}api_key=${TMDB_API_KEY}&language=${TMDB_LANG}`;
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

function mapTmdbItem(item) {
  if (!item) return null;
  const type = item.media_type === 'tv' ? 'tv' : item.media_type === 'movie' ? 'movie' : null;
  if (!type) return null;
  return {
    id: item.id,
    title: item.title || item.name || 'Sem título',
    year: String(item.release_date || item.first_air_date || '').slice(0, 4),
    type,
    poster: item.poster_path || '',
    overview: item.overview || ''
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

  for (const dataset of [trending, popularMovies, popularTv]) {
    for (const item of (dataset && dataset.results) || []) {
      const mapped = mapTmdbItem(item);
      if (!mapped || seen.has(`${mapped.type}:${mapped.id}`)) continue;
      seen.add(`${mapped.type}:${mapped.id}`);
      results.push(mapped);
      if (results.length >= 24) break;
    }
    if (results.length >= 24) break;
  }

  if (results.length) {
    popularCache = { results, expires: Date.now() + 30 * 60 * 1000 };
  }

  res.json({ results });
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

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ffmpeg: FFMPEG_OK,
    tmdb: Boolean(TMDB_API_KEY),
    sessions: activeSessions(),
    fallbacks: getProviderList().map((p) => p.name)
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
          'hevc=1 aproveita HEVC nativo, hevc=0 força H.264; start=N começa em N segundos. ' +
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

/* ------------------------------------------------------------------ */
/* Stream                                                              */
/* ------------------------------------------------------------------ */

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
  const preferred = Number(req.query.res) || 0;
  const startAt = Math.max(0, Math.min(6 * 3600, Math.floor(Number(req.query.start) || 0)));
  const title = String(req.query.title || '').trim();

  console.log(
    `[stream] id=${id} type=${type} s=${season} e=${episode} res=${preferred || 'auto'} hevc=${hevcOk ? 'sim' : 'não'} start=${startAt}s${title ? ` title="${title}"` : ''}`
  );

  try {
    const streamInfo = await getFallbackStream({ id, type, season, episode, title });

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
      const captions = buildCaptions(streamInfo.captions, 0).map((caption) => ({
        ...caption,
        url: absoluteUrl(req, caption.url)
      }));

      return res.json({
        mode: 'hls',
        url: absoluteUrl(req, streamInfo.url),
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
      console.log(`[stream] modo direto ${qualityKey || 'auto'} (${streamInfo.provider}, codec ${codec || '?'})`);
      return res.json({
        mode: 'direct',
        url: absoluteUrl(req, `/api/proxy?t=${token}`),
        quality: Number(qualityKey) || streamInfo.quality || 'auto',
        codec: codec || 'desconhecido',
        sourceCodec: codec || 'desconhecido',
        transcoded: false,
        provider: streamInfo.provider,
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
/* Proxy de vídeo / legendas                                           */
/* ------------------------------------------------------------------ */

app.get('/api/proxy', (req, res) => {
  const entry = registry.resolve('video', String(req.query.t || ''));
  if (!entry) {
    return res.status(404).json({ error: 'Sessão de vídeo expirada. Recarregue o player.' });
  }
  proxyVideo(req, res, entry);
});

app.get('/api/subtitle', async (req, res) => {
  const entry = registry.resolve('subtitle', String(req.query.t || ''));
  if (!entry) return res.status(404).json({ error: 'Legenda expirada. Recarregue o player.' });

  try {
    // Baixa/converte uma vez e reaproveita: trocar o atraso não refaz o download.
    if (!entry.vtt) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(entry.url, {
          signal: controller.signal,
          headers: { 'User-Agent': USER_AGENT }
        });

        if (!response.ok) {
          return res.status(502).json({ error: `Falha ao baixar legenda (HTTP ${response.status})` });
        }

        const text = await response.text();
        entry.vtt = /^\s*\uFEFF?WEBVTT/.test(text) ? text : srtToVtt(text);
      } finally {
        clearTimeout(timer);
      }
    }

    // autoShift compensa o "Início (min)"; shift é o ajuste manual do usuário.
    const autoShift = Number(entry.autoShift) || 0;
    const manual = Math.max(-600, Math.min(600, Number(req.query.shift) || 0));
    const total = autoShift + manual;
    const body = Math.abs(total) > 0.001 ? shiftVtt(entry.vtt, total) : entry.vtt;

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao baixar legenda: ' + err.message });
  }
});

/* ------------------------------------------------------------------ */
/* HLS (ffmpeg)                                                        */
/* ------------------------------------------------------------------ */

app.get('/hls/:id/:file', (req, res) => {
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

const server = app.listen(PORT, () => {
  console.log('');
  console.log('🎬 fdsFlix rodando em http://localhost:' + PORT);
  console.log('   TMDB API : ' + (TMDB_API_KEY ? 'configurada' : 'NÃO configurada'));
  console.log('   ffmpeg   : ' + (FFMPEG_OK ? 'disponível (transcodificação ativa)' : 'NÃO encontrado'));
  console.log('   Fallbacks: ' + getProviderList().map((p) => p.name).join(' → '));
  console.log('   Serviços auxiliares (opcionais para catálogo expandido/novelas):');
  console.log('     - CinePro:    ' + (process.env.CINEPRO_API_BASE || 'http://localhost:3001'));
  console.log('     - CineWinx:   ' + (process.env.CINEWINX_API_BASE || 'http://localhost:3002'));
  console.log('     - Consumet:   ' + (process.env.CONSUMET_API_BASE || 'http://localhost:3003'));
  if (!FFMPEG_OK) {
    console.log('   ⚠️  Sem ffmpeg o player não consegue converter HEVC para H.264.');
  }
  console.log('');
});

function gracefulExit() {
  shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);
