'use strict';

/**
 * fdsFlix - Cascata de Fallbacks Multi-Fonte
 *
 * Tenta múltiplos provedores em cascata para cobrir lançamentos,
 * clássicos antigos, cults e novelas brasileiras:
 *
 * 0. Vidsrc Proxy    (opcional: só com VIDSRC_PROXY_URL; Vidsrc sem anúncio via Vercel)
 * 1. VidLink Pro      (Nativo fdsFlix com XSalsa20 e qualidades múltiplas)
 * 2. CinePro Core     (50+ provedores agregados, OMSS)
 * 3. CineWinx API     (Telegram stream - filmes antigos & novelas)
 * 4. Stream-Winx API  (FastAPI / Telethon)
 * 5. Consumet API     (FlixHQ, DramaCool / novelas & dramas asiáticos)
 * 6. Vidsrc Scraper   (@definisi/vidsrc-scraper)
 * 7. Embed.su         (Vidsrc-Bypass)
 * 8. MegaMoviesLibre  (Fork do Libreflix / filmes nacionais livres)
 * 9. API5             (simo854 API5)
 * 10. KekikStream     (KekikStream FastAPI / plugins internacionais)
 */

const { getVidLinkStream } = require('./streamExtractor');
const { normalizeCineProUrl, cleanQuality } = require('./cineproUrl');
const { validateSource } = require('./cineproValidate');
const { findAnimeStream } = require('./animeFire');
const { relayFetch } = require('./relayFetch');
const usage = require('./usageLedger');

const DEFAULT_TIMEOUT_MS = 6000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await relayFetch(url, {
      ...options,
      signal: controller.signal
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function formatCaptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === 'string') {
        return {
          url: item,
          language: 'Legenda',
          type: item.includes('.vtt') ? 'vtt' : 'srt'
        };
      }
      if (item && item.url) {
        return {
          url: item.url,
          language: item.language || item.lang || item.label || 'Legenda',
          type: String(item.type || (item.url.includes('.vtt') ? 'vtt' : 'srt')).toLowerCase()
        };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * CinePro Core (50+ provedores agregados) — contrato OMSS:
 *   GET /v1/movies/:tmdbId
 *   GET /v1/tv/:tmdbId/seasons/:s/episodes/:e
 * Resposta: { sources: [{ url, type, quality, provider:{id,name} }], subtitles: [{ url, label, format }] }
 * As URLs vêm relativas ao proxy do próprio CinePro ("/v1/proxy?data=...").
 * Base padrão: process.env.CINEPRO_API_BASE (o cineproRunner define a instância local).
 */
const CINEPRO_TYPE_RANK = { hls: 0, mp4: 1, http: 2, mkv: 3, webm: 4 };
const CINEPRO_TIMEOUT_MS = 30000; // ele consulta vários provedores em paralelo

function rankCineProSources(sources) {
  const playable = (Array.isArray(sources) ? sources : [])
    .filter((src) => src && src.url && Object.prototype.hasOwnProperty.call(CINEPRO_TYPE_RANK, String(src.type || '').toLowerCase()));

  const height = (src) => Number(String(src.quality || '').replace(/[^0-9]/g, '')) || 0;
  return playable.sort((a, b) => {
    const rank = CINEPRO_TYPE_RANK[String(a.type).toLowerCase()] - CINEPRO_TYPE_RANK[String(b.type).toLowerCase()];
    return rank || height(b) - height(a);
  });
}

// Resumo (sem URLs) da última consulta ao CinePro, para /api/debug/hls.
let lastCineProReport = null;
function getCineProReport() {
  return lastCineProReport;
}

const CINEPRO_MAX_CANDIDATES = 6;

async function tryCinePro(id, type, s, e, title) {
  const base = (process.env.CINEPRO_API_BASE || 'http://localhost:3001').replace(/\/+$/, '');
  try {
    const endpoint = type === 'movie'
      ? `${base}/v1/movies/${encodeURIComponent(id)}`
      : `${base}/v1/tv/${encodeURIComponent(id)}/seasons/${s}/episodes/${e}`;

    const res = await fetchWithTimeout(endpoint, {
      headers: { Accept: 'application/json' }
    }, CINEPRO_TIMEOUT_MS);

    if (!res || !res.ok) return null;
    const data = await res.json();

    // Tudo que o CinePro devolve precisa apontar para ELE (localhost/127.0.0.1 são equivalentes).
    const absolute = (u) => normalizeCineProUrl(u, base + '/');

    const candidates = rankCineProSources(data.sources)
      .map((src) => ({ src, url: absolute(src.url) }))
      .filter((c) => c.url)
      .slice(0, CINEPRO_MAX_CANDIDATES);
    // Por que os outros provedores do CinePro não trouxeram nada (sem URLs).
    const providerNotes = (Array.isArray(data.diagnostics) ? data.diagnostics : [])
      .filter((d) => d && d.message)
      .slice(0, 30)
      .map((d) => String(d.message).replace(/https?:\/\/\S+/g, '[url]').slice(0, 120));

    if (!candidates.length) {
      lastCineProReport = { at: new Date().toISOString(), title: String(id), sources: [], provedoresSemResultado: providerNotes };
      console.log(`[cinepro] nenhuma fonte reproduzível (${providerNotes.length} avisos de provedores)`);
      return null;
    }

    // Valida em paralelo (a playlist pode carregar e os segmentos serem recusados pela
    // origem). Escolhe a primeira APROVADA na ordem de preferência.
    const checks = await Promise.all(
      candidates.map((c) => validateSource({ url: c.url, type: c.src.type }))
    );

    lastCineProReport = {
      at: new Date().toISOString(),
      title: String(id),
      provedoresSemResultado: providerNotes,
      sources: candidates.map((c, i) => ({
        provider: (c.src.provider && c.src.provider.name) || '?',
        type: String(c.src.type).toLowerCase(),
        quality: cleanQuality(c.src.quality),
        ok: checks[i].ok,
        motivo: checks[i].ok ? null : checks[i].reason,
        ms: checks[i].ms
      }))
    };
    const rejected = lastCineProReport.sources.filter((x) => !x.ok).length;
    console.log(`[cinepro] ${candidates.length - rejected}/${candidates.length} fontes válidas`);

    const winner = candidates.find((c, i) => checks[i].ok);
    if (!winner) return null;

    const best = winner.src;
    const kind = String(best.type).toLowerCase();

    return {
      url: winner.url,
      provider: 'CinePro Core' + (best.provider && best.provider.name ? ' · ' + best.provider.name : ''),
      quality: cleanQuality(best.quality),
      isHls: kind === 'hls',
      viaCinePro: true,
      captions: (Array.isArray(data.subtitles) ? data.subtitles : [])
        .filter((sub) => sub && sub.url && absolute(sub.url))
        .map((sub) => ({
          url: absolute(sub.url),
          language: sub.label || 'Legenda',
          type: String(sub.format || 'vtt').toLowerCase()
        }))
    };
  } catch (err) {
    // Silencia erros esperados (ex: serviço local desligado)
  }
  return null;
}

/**
 * AnimeFire (anime com dublado em português). Só age em animação japonesa do TMDB.
 * Veja lib/animeFire.js.
 */
async function tryAnimeFire(id, type, s, e, title) {
  try {
    return await findAnimeStream({ id, type, season: s, episode: e, title });
  } catch (err) {
    console.warn('[animefire] falhou:', err.message);
    return null;
  }
}

/**
 * 2. CineWinx API (Stream via Telegram - novelas antigas e clássicos)
 * URL padrão: process.env.CINEWINX_API_BASE || 'http://localhost:3002'
 */
async function tryCineWinx(id, type, s, e, title) {
  const base = (process.env.CINEWINX_API_BASE || 'http://localhost:3002').replace(/\/+$/, '');
  const endpoints = [
    type === 'movie'
      ? `${base}/movies/${id}`
      : `${base}/series/${id}/seasons/${s}/episodes/${e}`,
    `${base}/stream?id=${id}&type=${type}&s=${s}&e=${e}`
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetchWithTimeout(endpoint, {
        headers: { Accept: 'application/json' }
      });
      if (!res || !res.ok) continue;

      const data = await res.json();
      const url = data.streamUrl || data.url;
      if (url) {
        return {
          url,
          provider: 'CineWinx (Telegram)',
          quality: data.quality || 'auto',
          isHls: url.includes('.m3u8'),
          captions: formatCaptions(data.subtitles || data.captions)
        };
      }
    } catch (err) {
      // continua para o próximo endpoint
    }
  }
  return null;
}

/**
 * 3. Stream-Winx API (FastAPI / Telethon)
 * URL padrão: process.env.STREAM_WINX_API_BASE || 'http://localhost:3004'
 */
async function tryStreamWinx(id, type, s, e, title) {
  const base = (process.env.STREAM_WINX_API_BASE || 'http://localhost:3004').replace(/\/+$/, '');
  const endpoints = [
    type === 'movie'
      ? `${base}/stream/movie/${id}`
      : `${base}/stream/tv/${id}/${s}/${e}`,
    type === 'movie'
      ? `${base}/movies/${id}`
      : `${base}/series/${id}/seasons/${s}/episodes/${e}`
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetchWithTimeout(endpoint, {
        headers: { Accept: 'application/json' }
      });
      if (!res || !res.ok) continue;

      const data = await res.json();
      const url = data.streamUrl || data.url;
      if (url) {
        return {
          url,
          provider: 'Stream-Winx',
          quality: data.quality || 'auto',
          isHls: url.includes('.m3u8'),
          captions: formatCaptions(data.subtitles || data.captions)
        };
      }
    } catch (err) {
      // continua
    }
  }
  return null;
}

/**
 * 4. Consumet API (FlixHQ, DramaCool, TMDB)
 * URL padrão: process.env.CONSUMET_API_BASE || 'http://localhost:3003'
 */
async function tryConsumet(id, type, s, e, title) {
  const base = (process.env.CONSUMET_API_BASE || 'http://localhost:3003').replace(/\/+$/, '');
  const headers = { Accept: 'application/json' };

  const pickResult = (data) => {
    const sources = Array.isArray(data && data.sources) ? data.sources : [];
    const best = sources.find((src) => src && src.url && (src.url.includes('.m3u8') || src.url.includes('.mp4'))) || sources[0];
    if (!best || !best.url) return null;
    return {
      url: best.url,
      provider: 'Consumet (' + (data.provider || 'TMDB') + ')',
      quality: best.quality || 'auto',
      isHls: best.url.includes('.m3u8') || Boolean(best.isM3U8),
      captions: formatCaptions(data.subtitles)
    };
  };

  // Fluxo real da API: /meta/tmdb/info/:id descobre o episodeId,
  // /meta/tmdb/watch/:episodeId?id=:id devolve as fontes.
  try {
    const infoRes = await fetchWithTimeout(`${base}/meta/tmdb/info/${id}?type=${type}`, { headers }, 8000);
    if (infoRes && infoRes.ok) {
      const info = await infoRes.json();
      let episodeId = null;
      if (type === 'movie') {
        episodeId = info.episodeId || (Array.isArray(info.episodes) && info.episodes[0] && info.episodes[0].id);
      } else if (Array.isArray(info.episodes)) {
        const ep = info.episodes.find((x) => Number(x.season) === s && Number(x.number || x.episode) === e);
        episodeId = ep && ep.id;
      }
      if (episodeId) {
        const watchRes = await fetchWithTimeout(
          `${base}/meta/tmdb/watch/${encodeURIComponent(episodeId)}?id=${encodeURIComponent(info.id || id)}`,
          { headers },
          10000
        );
        if (watchRes && watchRes.ok) {
          const result = pickResult(await watchRes.json());
          if (result) return result;
        }
      }
    }
  } catch (err) {
    // continua para os endpoints legados
  }

  const legacy = [
    type === 'movie'
      ? `${base}/movies/flixhq/watch?tmdbId=${id}`
      : `${base}/tv/flixhq/watch?tmdbId=${id}&season=${s}&episode=${e}`
  ];
  for (const endpoint of legacy) {
    try {
      const res = await fetchWithTimeout(endpoint, { headers });
      if (!res || !res.ok) continue;
      const result = pickResult(await res.json());
      if (result) return result;
    } catch (err) {
      // continua
    }
  }
  return null;
}

/**
 * 5. VidLink Pro (Nativo do fdsFlix - XSalsa20 + qualidades múltiplas)
 */
async function tryVidLink(id, type, s, e, title) {
  try {
    const parsed = await getVidLinkStream({ id, type, season: s, episode: e });
    if (parsed && parsed.url) {
      return {
        ...parsed,
        provider: 'VidLink Pro',
        isHls: (parsed.url || '').includes('.m3u8')
      };
    }
  } catch (err) {
    // continua
  }
  return null;
}

/**
 * 6. Vidsrc Scraper (@definisi/vidsrc-scraper)
 */
async function tryVidsrc(id, type, s, e, title) {
  try {
    const { scrapeVidsrc } = await import('@definisi/vidsrc-scraper');
    const result = await scrapeVidsrc(id, type, s || null, e || null, { timeout: 8000 });
    if (result && result.success && result.hlsUrl) {
      return {
        url: result.hlsUrl,
        provider: 'Vidsrc (definisi)',
        quality: 'auto',
        isHls: true,
        captions: (result.subtitles || []).map((sub) => ({
          url: sub,
          language: 'Legenda'
        }))
      };
    }
  } catch (err) {
    // continua
  }
  return null;
}

/**
 * 7. Embed.su (vidsrc-bypass)
 */
async function tryEmbedSu(id, type, s, e, title) {
  try {
    const embedUrl = type === 'tv'
      ? `https://embed.su/embed/tv/${id}/${s}/${e}`
      : `https://embed.su/embed/movie/${id}`;

    const res = await fetchWithTimeout(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://embed.su/'
      }
    }, 6000);

    if (!res || !res.ok) return null;
    const html = await res.text();
    const match = html.match(/window\.vConfig\s*=\s*JSON\.parse\(atob\(`(.+?)`\)\)/);
    if (match && match[1]) {
      const decodedData = JSON.parse(Buffer.from(match[1], 'base64').toString());
      if (decodedData.hash) {
        const firstDecode = Buffer.from(decodedData.hash, 'base64').toString().split('.').map((i) => i.split('').reverse().join(''));
        const secondDecode = JSON.parse(Buffer.from(firstDecode.join('').split('').reverse().join(''), 'base64').toString());
        if (Array.isArray(secondDecode) && secondDecode[0] && secondDecode[0].hash) {
          const apiRes = await fetchWithTimeout(`https://embed.su/api/e/${secondDecode[0].hash}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              Referer: 'https://embed.su/'
            }
          }, 6000);
          if (apiRes && apiRes.ok) {
            const streamData = await apiRes.json();
            if (streamData.source) {
              return {
                url: streamData.source,
                provider: 'Embed.su',
                quality: 'auto',
                isHls: streamData.source.includes('.m3u8'),
                captions: formatCaptions(streamData.subtitles)
              };
            }
          }
        }
      }
    }
  } catch (err) {
    // continua
  }
  return null;
}

/**
 * 8. MegaMoviesLibre (Fork do Libreflix para filmes nacionais e clássicos)
 * URL padrão: process.env.MEGAMOVIES_API_BASE || 'http://localhost:3005'
 */
async function tryMegaMoviesLibre(id, type, s, e, title) {
  const base = (process.env.MEGAMOVIES_API_BASE || '').replace(/\/+$/, '');
  if (!base) return null;

  try {
    const endpoint = title
      ? `${base}/search?q=${encodeURIComponent(title)}`
      : `${base}/item/${id}`;

    const res = await fetchWithTimeout(endpoint, {
      headers: { Accept: 'application/json' }
    }, 5000);
    if (!res || !res.ok) return null;

    const data = await res.json();
    const item = Array.isArray(data) ? data[0] : (data.item || data);
    const url = item && (item.videoUrl || item.streamUrl || item.url);

    if (url) {
      return {
        url,
        provider: 'MegaMoviesLibre',
        quality: item.quality || 'auto',
        isHls: url.includes('.m3u8'),
        captions: formatCaptions(item.subtitles || item.captions)
      };
    }
  } catch (err) {
    // continua
  }
  return null;
}

/**
 * 9. API5 (simo854/api5)
 * URL padrão: process.env.API5_API_BASE
 */
async function tryApi5(id, type, s, e, title) {
  const base = (process.env.API5_API_BASE || '').replace(/\/+$/, '');
  if (!base) return null;

  try {
    const endpoint = type === 'movie'
      ? `${base}/api/movie/${id}`
      : `${base}/api/tv/${id}/${s}/${e}`;

    const res = await fetchWithTimeout(endpoint, {
      headers: { Accept: 'application/json' }
    }, 5000);
    if (!res || !res.ok) return null;

    const data = await res.json();
    const url = data.streamUrl || data.url || (Array.isArray(data.sources) && data.sources[0]?.url);
    if (url) {
      return {
        url,
        provider: 'API5',
        quality: data.quality || 'auto',
        isHls: url.includes('.m3u8'),
        captions: formatCaptions(data.subtitles)
      };
    }
  } catch (err) {
    // continua
  }
  return null;
}

/**
 * 10. KekikStream (FastAPI / plugins turcos e internacionais)
 * URL padrão: process.env.KEKIKSTREAM_API_BASE
 */
async function tryKekikStream(id, type, s, e, title) {
  const base = (process.env.KEKIKSTREAM_API_BASE || '').replace(/\/+$/, '');
  if (!base) return null;

  try {
    const endpoint = type === 'movie'
      ? `${base}/stream?id=${id}&type=movie`
      : `${base}/stream?id=${id}&type=tv&s=${s}&e=${e}`;

    const res = await fetchWithTimeout(endpoint, {
      headers: { Accept: 'application/json' }
    }, 5000);
    if (!res || !res.ok) return null;

    const data = await res.json();
    const url = data.streamUrl || data.url;
    if (url) {
      return {
        url,
        provider: 'KekikStream',
        quality: data.quality || 'auto',
        isHls: url.includes('.m3u8'),
        captions: formatCaptions(data.subtitles)
      };
    }
  } catch (err) {
    // continua
  }
  return null;
}

/**
 * 11. Dublado PT (opcional) — filmes/séries/novelas com áudio em português.
 *
 * Não há uma API pública "oficial" disso; o que existe são serviços comunitários (SuperFlixAPI e
 * afins) com formatos parecidos. Em vez de fixar um, este provedor lê `PT_DUB_API_BASE` e tenta os
 * caminhos mais comuns (`/api/filmes/{id}`, `/api/series/{id}/{s}/{e}`, `/api/novelas/...`),
 * aceitando as chaves de URL que esses serviços usam. Sem a variável ele NEM APARECE na cascata —
 * nada muda para quem já funciona.
 *
 * Exemplo: PT_DUB_API_BASE=https://sua-api-dublada.exemplo.com
 */
function pickDubUrl(data) {
  if (!data || typeof data !== 'object') return '';
  const candidates = [
    data.stream_url, data.streamUrl, data.url, data.player, data.embed, data.link,
    data.data && data.data.stream_url, data.data && data.data.url,
    data.result && data.result.url, data.result && data.result.stream_url,
    Array.isArray(data.sources) && data.sources[0] && data.sources[0].url,
    Array.isArray(data.sources) && data.sources[0] && data.sources[0].file,
    Array.isArray(data.links) && data.links[0] && (data.links[0].url || data.links[0].link)
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  }
  return '';
}

async function tryPortugues(id, type, s, e, title) {
  const base = String(process.env.PT_DUB_API_BASE || '').trim().replace(/\/+$/, '');
  if (!base) return null;

  const paths = type === 'movie'
    ? [`/api/filmes/${encodeURIComponent(id)}`, `/api/movies/${id}`, `/filmes/${id}`, `/api/movie/${id}`]
    : [
        `/api/series/${encodeURIComponent(id)}/${s}/${e}`,
        `/api/novelas/${encodeURIComponent(id)}/${s}/${e}`,
        `/api/tv/${encodeURIComponent(id)}/${s}/${e}`,
        `/api/series/${encodeURIComponent(id)}/temporada/${s}/episodio/${e}`
      ];

  for (const path of paths) {
    try {
      const res = await fetchWithTimeout(base + path, {
        headers: { Accept: 'application/json', ...(process.env.PT_DUB_API_KEY ? { 'x-api-key': process.env.PT_DUB_API_KEY } : {}) }
      }, 8000);
      if (!res || !res.ok) continue;
      const data = await res.json();
      const url = pickDubUrl(data);
      if (!url) continue;
      const rawSubs = (data.subtitles || data.legendas || data.captions || (data.data && data.data.subtitles) || []);
      return {
        url,
        provider: 'Dublado PT' + (data.provider ? ' · ' + data.provider : ''),
        quality: data.quality || data.qualidade || 'auto',
        isHls: /\.m3u8(?:$|\?)/i.test(url),
        captions: formatCaptions(rawSubs),
        audio: 'pt-BR'
      };
    } catch (error) {
      /* tenta o próximo caminho */
    }
  }
  return null;
}

/**
 * 0. Vidsrc Proxy (opcional) — Vidsrc direto, sem iframe e sem anúncio.
 *
 * O CDN do Vidsrc amarra o token ao IP de quem o gerou, então o HLS não toca
 * direto no navegador. O serviço `adproxy` (Vercel) extrai o HLS e entrega
 * playlist + segmentos com o IP dele; o Render só devolve ~1 KB de JSON.
 *
 * LIGAR:    VIDSRC_PROXY_URL=https://seu-adshield.vercel.app
 * DESLIGAR: apague a variável (o fluxo volta exatamente ao que era antes).
 */
async function directFetch(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  // fetch nativo (sem o relay da Cloudflare): o adproxy já é um serviço público.
  const { signal: outer, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Legendas para acompanhar o vídeo do Vidsrc: o Vidsrc quase nunca manda
 * (default_subs vem vazio), então pegamos só as legendas do VidLink Pro, que o
 * fdsFlix já usa. Não baixa vídeo nenhum; falha em silêncio.
 */
async function companionCaptions(id, type, s, e) {
  try {
    const result = await Promise.race([
      getVidLinkStream({ id, type, season: s, episode: e }),
      new Promise((resolve) => setTimeout(() => resolve(null), 7000))
    ]);
    return result && Array.isArray(result.captions) ? result.captions : [];
  } catch (err) {
    return [];
  }
}

/* ------------------------------------------------------------------------------------------------
 * Vidsrc pelas Vercels do pool.
 *
 * Este é o caminho que entrega o filme SEM gastar a banda do Render, então precisa aguentar o dia ruim:
 *  - o primeiro nó é tentado sozinho, como sempre. SÓ se ele falhar entram os outros (até 6), e aí em corrida escalonada:
 *    se o nó da vez demora, o próximo parte em paralelo;
 *  - nó que falhou por motivo de infraestrutura (tempo, rede, 429, 502-504) fica no fim da fila por um tempo;
 *  - se TODOS falharem, reaproveita a última extração boa do mesmo título (confere a master antes).
 * ---------------------------------------------------------------------------------------------- */
const NODE_COOLDOWN_MS = 90 * 1000;
const HEDGE_AFTER_MS = 3500;
const MAX_NODES = 6;
const MAX_PARALLEL = 3;
const VIDSRC_DEADLINE_MS = 28 * 1000;
const LAST_GOOD_TTL_MS = 3 * 60 * 60 * 1000;
const LAST_GOOD_MAX = 200;
const nodeHealth = new Map(); // base -> { at, why }
const lastGood = new Map();   // "tipo:id:s:e" -> { result, at }

const FAMILY_COOLDOWN_MS = 60 * 1000;
const familyHealth = new Map(); // família (wasmer.app, vercel.app…) -> { at, why }

/* ---- Disjuntor do Vidsrc ----
 * Quando VÁRIOS nós falham com o MESMO erro sistêmico (ex.: "CONFIG/apiToken ausente"), insistir
 * custa ~4 s por nó e ainda martela a origem. O disjuntor abre por alguns minutos e o Vidsrc é
 * pulado na hora: a cascata cai direto no AdFallback (1-2 s em vez de 23 s). Fecha sozinho, e
 * qualquer sucesso fecha na hora. */
const BREAKER_MINUTES = Math.max(1, Math.min(60, Number(process.env.VIDSRC_BREAKER_MINUTES) || 5));
const SYSTEMIC_FAILURE = /CONFIG\/apiToken|CFG\/playerUrl|data-api não encontrado|vs_src HTTP (403|429)|embed HTTP (403|429|5\d\d)|fetch failed|tempo esgotado|nenhuma playlist|stream API sem stream_urls/i;
let breaker = { until: 0, reason: '', failures: 0, openedAt: 0, windowMinutes: 0 };

function breakerOpen(now = Date.now()) {
  return now < breaker.until;
}

function breakerState(now = Date.now()) {
  return {
    open: breakerOpen(now),
    until: breaker.until > now ? new Date(breaker.until).toISOString() : null,
    minutes: BREAKER_MINUTES,
    reason: breaker.reason || null,
    failures: breaker.failures,
    windowMinutes: breaker.windowMinutes || BREAKER_MINUTES,
    openedAt: breaker.openedAt || null
  };
}

function openBreaker(reason, now = Date.now()) {
  if (!SYSTEMIC_FAILURE.test(String(reason || ''))) return;
  // Backoff: a primeira janela é a do env; se reabrir sem nenhum sucesso no meio (apagão longo),
  // dobra até 30 min. Assim não pagamos os ~17 s de detecção a cada 5 min para sempre.
  const windowMinutes = Math.min(30, BREAKER_MINUTES * 2 ** Math.max(0, breaker.failures));
  breaker = {
    until: now + windowMinutes * 60000,
    reason: String(reason).slice(0, 120),
    failures: breaker.failures + 1,
    openedAt: now,
    windowMinutes
  };
  console.warn(`[vidsrc] disjuntor ABERTO por ${windowMinutes} min: ${reason}`);
  scheduleProbe(now);
}

function closeBreaker() {
  if (breaker.until) console.log('[vidsrc] disjuntor fechado (a origem voltou a entregar)');
  breaker = { until: 0, reason: '', failures: 0, openedAt: 0, windowMinutes: 0 };
  if (probeTimer) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
}

/* ---- Sonda de recuperação ----
 * Com o disjuntor aberto, quem paga a detecção é o primeiro usuário depois da janela (~15 s). Esta
 * sonda testa a pool em SEGUNDO PLANO quando a janela vence: se o Vidsrc voltou, o disjuntor fecha
 * antes de alguém pedir; se não voltou, reabre com backoff e reagenda. O usuário nunca espera. */
let probeTimer = null;

function scheduleProbe(now = Date.now()) {
  if (probeTimer || !breakerOpen(now)) return;
  const wait = Math.max(2000, breaker.until - now + 500);
  probeTimer = setTimeout(async () => {
    probeTimer = null;
    if (!breakerOpen()) return;
    try {
      const result = await tryVidsrcProxy('603', 'movie', 1, 1, 'sonda', {
        note: () => {},
        errors: [],
        captionsPromise: Promise.resolve([]),
        probe: true
      });
      if (result) {
        closeBreaker();
        console.log('[vidsrc] sonda de recuperação: a pool voltou a entregar');
        return;
      }
    } catch (error) {
      /* sonda nunca derruba nada */
    }
    if (breakerOpen()) scheduleProbe();
  }, wait);
  if (probeTimer.unref) probeTimer.unref();
}

/* ---- Saúde por nó (para o painel) ---- */
const nodeStats = new Map(); // base -> { attempts, ok, fail, lastError, lastAt, lastOkAt }

function statsOf(base) {
  if (!nodeStats.has(base)) {
    nodeStats.set(base, { attempts: 0, ok: 0, fail: 0, streak: 0, lastError: null, lastAt: 0, lastOkAt: 0 });
  }
  return nodeStats.get(base);
}

function noteSuccess(base) {
  const stats = statsOf(base);
  stats.attempts += 1;
  stats.ok += 1;
  stats.streak = 0;
  stats.lastOkAt = Date.now();
  stats.lastAt = Date.now();
  stats.lastError = null;
}

function noteFailure(base, why) {
  const stats = statsOf(base);
  stats.attempts += 1;
  stats.fail += 1;
  stats.streak += 1;
  stats.lastError = String(why).slice(0, 120);
  stats.lastAt = Date.now();
}

/** Retrato para o painel: pool do Vidsrc + disjuntor + sucessos/falhas de cada nó. */
function vidsrcHealth(now = Date.now()) {
  const pool = usage.rankedPool();
  return {
    breaker: breakerState(now),
    nodes: pool.map((node) => {
      const stats = statsOf(node.base);
      return {
        base: node.base,
        host: (() => { try { return new URL(node.base).hostname; } catch (error) { return node.base; } })(),
        usedPct: node.usedPct,
        exhausted: Boolean(node.exhausted),
        cooling: nodeCooling(node.base, now),
        familyCooling: familyCooling(familyOf(node.base), now),
        callsLastMinute: callsInWindow(node.base, now),
        attempts: stats.attempts,
        ok: stats.ok,
        fail: stats.fail,
        consecutiveFailures: stats.streak,
        lastError: stats.lastError,
        lastAt: stats.lastAt || null,
        lastOkAt: stats.lastOkAt || null
      };
    })
  };
}

// Título -> nó que o entregou há pouco. O nó guarda a resolução por 10 min (resolveVidsrcCached);
// reusar o mesmo nó para o MESMO título não gasta chamada nova no Vidsrc. Só títulos novos rotacionam.
const titleNode = new Map();
const TITLE_NODE_TTL_MS = 8 * 60 * 1000;

/* ---- Mediador de chamadas ----
 * O Vidsrc bloqueia/limita por IP. A pool tem N IPs, mas antes a escolha era só por folga de banda:
 * o nó mais vazio levava quase todas as extrações e, com o tempo, era justamente ele que apanhava.
 * Aqui a escolha olha QUANTAS chamadas cada nó fez no último minuto e QUANDO foi a última; quem foi
 * chamado há mais tempo vai na frente. É o rodízio de chamadas — mesmo pool, mesma arquitetura. */
const CALL_WINDOW_MS = 60 * 1000;
const callLog = new Map(); // base -> [timestamps das chamadas no último minuto]

function callsInWindow(base, now = Date.now()) {
  const list = (callLog.get(base) || []).filter((at) => now - at < CALL_WINDOW_MS);
  if (list.length) callLog.set(base, list);
  else callLog.delete(base);
  return list.length;
}

function lastCallAt(base) {
  const list = callLog.get(base);
  return list && list.length ? list[list.length - 1] : 0;
}

/** Registra que este nó vai falar com o Vidsrc agora (chamado no disparo, não no resultado). */
function markNodeCall(base, now = Date.now()) {
  const list = (callLog.get(base) || []).filter((at) => now - at < CALL_WINDOW_MS);
  list.push(now);
  callLog.set(base, list);
}

/** Menos chamadas no último minuto, depois quem foi chamado há mais tempo, depois mais folga de cota. */
function compareByCalls(a, b, now) {
  const callsA = callsInWindow(a.base, now);
  const callsB = callsInWindow(b.base, now);
  if (callsA !== callsB) return callsA - callsB;
  const lastA = lastCallAt(a.base);
  const lastB = lastCallAt(b.base);
  if (lastA !== lastB) return lastA - lastB;
  return (Number(a.usedPct) || 0) - (Number(b.usedPct) || 0);
}

function nodeCooling(base, now = Date.now()) {
  const h = nodeHealth.get(base);
  return Boolean(h && now - h.at < NODE_COOLDOWN_MS);
}

/** "wasmer.app", "vercel.app"… Duas contas do mesmo provedor quase sempre dividem a mesma faixa de IP. */
function familyOf(base) {
  try {
    const parts = new URL(base).hostname.toLowerCase().split('.');
    return parts.slice(-2).join('.');
  } catch (error) {
    return 'desconhecido';
  }
}

function familyCooling(family, now = Date.now()) {
  const hit = familyHealth.get(family);
  return Boolean(hit && now - hit.at < FAMILY_COOLDOWN_MS);
}

/**
 * Desempilha as famílias em vez de esgotar uma antes da outra: com 11 Wasmers e 4 Vercels, os 6
 * primeiros nós seriam todos Wasmer. Se aquela faixa de IP estiver bloqueada, a requisição morria
 * sem nem tentar a Vercel. Agora a ordem é W1, V1, W2, V2… preservando a folga de cota dentro de cada.
 */
function interleaveFamilies(list) {
  const groups = new Map();
  for (const item of list) {
    const family = familyOf(item.base);
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(item);
  }
  const out = [];
  for (;;) {
    let progressed = false;
    for (const queue of groups.values()) {
      if (queue.length) {
        out.push(queue.shift());
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

/**
 * Ordem do rodízio: folga de cota, famílias alternadas, nó que falhou no fim e família que falhou
 * há pouco (provável bloqueio de faixa de IP) depois das outras.
 */
function orderNodes(pool, now = Date.now()) {
  const ok = pool.filter((p) => !nodeCooling(p.base, now)).sort((a, b) => compareByCalls(a, b, now));
  const cooling = pool.filter((p) => nodeCooling(p.base, now));
  const fresh = ok.filter((p) => !familyCooling(familyOf(p.base), now));
  const familyCold = ok.filter((p) => familyCooling(familyOf(p.base), now));
  return [...interleaveFamilies(fresh), ...interleaveFamilies(familyCold), ...interleaveFamilies(cooling)].map((p) => p.base);
}

/** Erro de infraestrutura (vale castigar o nó) ou da resposta daquele título (não vale). */
function infraFailure(why) {
  return /tempo esgotado|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|HTTP (429|502|503|504)\b|vs_src HTTP 429/i.test(String(why));
}

function lastGoodKey(type, id, s, e) { return `${type}:${id}:${type === 'tv' ? s : 0}:${type === 'tv' ? e : 0}`; }

function rememberGood(key, result) {
  lastGood.set(key, { result, at: Date.now() });
  while (lastGood.size > LAST_GOOD_MAX) lastGood.delete(lastGood.keys().next().value);
}

/** Uma tentativa num nó: devolve o stream ou null (e anota por quê). Nunca lança. */
async function attemptVidsrcNode(base, query, ctx) {
  const note = (msg) => { if (ctx && ctx.note) ctx.note(msg); };
  const host = new URL(base).hostname;
  const signal = ctx && ctx.signal;
  const fail = (why) => {
    if (signal && signal.aborted) return null; // perdeu a corrida: não é falha do nó
    noteFailure(base, why);
    if (infraFailure(why)) {
      const at = Date.now();
      const entry = { at, why: String(why).slice(0, 80) };
      nodeHealth.set(base, entry);
      // Marca a família: bloqueio de faixa de IP costuma derrubar todas as contas do mesmo provedor.
      familyHealth.set(familyOf(base), entry);
    }
    ctx.errors.push(String(why));
    return null;
  };
  try {
    const t0 = Date.now();
    const res = await directFetch(`${base}/vidsrc/stream?${query}`, { headers: { Accept: 'application/json' }, signal }, 12000);
    note(`[${host}] GET /vidsrc/stream → HTTP ${res ? res.status : '?'} em ${Date.now() - t0} ms`);
    if (!res || !res.ok) {
      const body = res ? String(await res.text().catch(() => '')).slice(0, 200) : '';
      if (res) note(`[${host}] corpo: ${body}`);
      // O motivo real vem no corpo (ex.: CONFIG/apiToken ausente). Guardar junto com o HTTP é o que
      // permite agrupar a falha e abrir o disjuntor quando é sistêmica.
      let detail = '';
      try {
        const parsed = JSON.parse(body);
        if (parsed && parsed.error) detail = `: ${String(parsed.error).slice(0, 80)}`;
      } catch (error) { /* corpo não é JSON */ }
      return fail(`HTTP ${res ? res.status : '?'}${detail}${/vs_src HTTP 429/.test(body) ? ' (vs_src 429)' : ''}`);
    }
    const data = await res.json();
    if (!data || !data.ok || !data.url) {
      note(`[${host}] resposta sem stream: ${JSON.stringify(data).slice(0, 160)}`);
      return fail('sem stream');
    }
    note(`[${host}] extraído: "${data.title || '?'}" · ${(data.sources || []).length} espelho(s)`);

    // Confere se a master toca de verdade (também "aquece" o token da instância).
    const candidates = [data.url, ...(Array.isArray(data.sources) ? data.sources.map((x) => x.url) : [])]
      .filter((url, index, list) => url && list.indexOf(url) === index)
      .slice(0, 3);
    for (let i = 0; i < candidates.length; i += 1) {
      try {
        const t1 = Date.now();
        const probe = await directFetch(candidates[i], { headers: { Accept: '*/*' }, signal }, 10000);
        const text = probe && probe.ok ? await probe.text() : '';
        const good = text.trimStart().startsWith('#EXTM3U');
        note(`[${host}] espelho ${i + 1}: master HTTP ${probe ? probe.status : '?'} em ${Date.now() - t1} ms · ${good ? 'playlist HLS válida' : 'NÃO é playlist'}`);
        if (!good) continue;
        let captions = formatCaptions(data.subtitles);
        let captionSource = 'Vidsrc';
        if (!captions.length) {
          captions = formatCaptions(await ctx.captionsPromise);
          captionSource = 'VidLink';
        }
        note(`legendas: ${captions.length}${captions.length ? ` (de ${captionSource})` : ' (nenhuma fonte tem para este título)'}`);
        noteSuccess(base);
        return { url: candidates[i], provider: 'Vidsrc', quality: 'auto', isHls: true, proxyBase: base, captions };
      } catch (err) {
        note(`[${host}] espelho ${i + 1}: falhou (${err.message})`);
      }
    }
    return fail('nenhum espelho tocou');
  } catch (err) {
    const why = err.name === 'AbortError' ? 'tempo esgotado' : err.message;
    if (!(signal && signal.aborted)) note(`[${host}] erro: ${why}`);
    return fail(why);
  }
}

/**
 * O primeiro nó corre sozinho (sem pressa, como antes). Depois da primeira falha, parte o próximo nó assim que o atual falha
 * ou demora (hedgeMs); o primeiro que entrega vence e cancela os outros.
 */
function raceNodes(nodes, run, { hedgeMs = HEDGE_AFTER_MS, maxNodes = MAX_NODES, maxParallel = MAX_PARALLEL, deadlineMs = VIDSRC_DEADLINE_MS } = {}) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const limit = Math.min(maxNodes, nodes.length);
    let launched = 0;
    let running = 0;
    let done = false;
    let hedge = null;
    let failures = 0;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(hedge);
      clearTimeout(deadline);
      controller.abort();
      resolve(value);
    };
    const deadline = setTimeout(() => finish(null), deadlineMs);
    const launch = () => {
      if (done) return;
      if (launched >= limit) { if (!running) finish(null); return; }
      const base = nodes[launched];
      launched += 1;
      running += 1;
      clearTimeout(hedge);
      if (failures > 0) hedge = setTimeout(() => { if (running < maxParallel) launch(); }, hedgeMs);
      run(base, controller.signal).then(
        (result) => { running -= 1; if (result) finish(result); else { failures += 1; launch(); } },
        () => { running -= 1; failures += 1; launch(); }
      );
    };
    if (!limit) return finish(null);
    launch();
  });
}

async function tryVidsrcProxy(id, type, s, e, title, ctx) {
  const note = (msg) => { if (ctx && ctx.note) ctx.note(msg); };
  const isProbe = Boolean(ctx && ctx.probe);
  if (!isProbe && breakerOpen()) {
    // Sem horário em UTC aqui: o painel mostra a hora local. Dizer "por ~N min" evita a confusão
    // de ver 14:00 numa linha e 11:00 na outra.
    note(`DISJUNTOR ABERTO: ${breaker.reason} — Vidsrc pulado por ~${breaker.windowMinutes || BREAKER_MINUTES} min (volta sozinho; nenhuma tentativa gasta)`);
    return null;
  }
  const pool = usage.rankedPool();
  if (!pool.length) {
    note('Nenhuma Vercel configurada (VIDSRC_PROXY_URL / VIDSRC_PROXY_URLS) → provedor ignorado');
    return null;
  }
  note(`pool de ${pool.length} nó(s), da mais folgada para a mais cheia: ` +
    pool.map((p) => `${new URL(p.base).hostname} ${p.usedPct}%${p.exhausted ? ' (ESGOTADA)' : ''}${nodeCooling(p.base) ? ' (falhou há pouco, no fim da fila)' : ''}`).join(' · '));
  const families = [...new Set(pool.map((p) => familyOf(p.base)))];
  note(`famílias: ${families.map((f) => `${f}${familyCooling(f) ? ' (falhou há pouco: possível bloqueio de faixa)' : ''}`).join(' · ')}`);

  const key = lastGoodKey(type, id, s, e);
  const query = type === 'tv'
    ? `tmdb=${encodeURIComponent(id)}&type=tv&s=${s}&e=${e}`
    : `tmdb=${encodeURIComponent(id)}&type=movie`;
  const run = { note, errors: [], captionsPromise: null, signal: null };
  run.captionsPromise = companionCaptions(id, type, s, e);

  let nodes = orderNodes(pool);
  const recent = titleNode.get(key);
  if (recent && Date.now() - recent.at < TITLE_NODE_TTL_MS && nodes.includes(recent.base)) {
    // Mesmo título há pouco: o nó que o entregou ainda tem a resolução em cache (10 min). Perguntar
    // a ele custa ZERO chamada nova ao Vidsrc — melhor que rotacionar e refazer a cadeia.
    nodes = [recent.base, ...nodes.filter((base) => base !== recent.base)];
    note(`reaproveitando ${new URL(recent.base).hostname} (este título tocou há ${Math.max(1, Math.round((Date.now() - recent.at) / 60000))} min; o nó já tem a resolução em cache)`);
  }
  const calls = nodes.slice(0, MAX_NODES).map((base) => `${new URL(base).hostname} ${callsInWindow(base)}`);
  note(`chamadas no último minuto (ordem de hoje): ${calls.join(' · ')}`);
  const winner = await raceNodes(nodes, (base, signal) => {
    markNodeCall(base);
    return attemptVidsrcNode(base, query, { ...run, signal });
  });
  if (winner) {
    nodeHealth.delete(winner.proxyBase);
    closeBreaker();
    rememberGood(key, winner);
    titleNode.set(key, { base: winner.proxyBase, at: Date.now() });
    while (titleNode.size > 200) titleNode.delete(titleNode.keys().next().value);
    return winner;
  }

  // Todos falharam. Se este mesmo título já tocou há pouco, a master dele ainda deve valer (o token vale ~3 h): confere e usa.
  const good = lastGood.get(key);
  if (good && Date.now() - good.at < LAST_GOOD_TTL_MS) {
    try {
      const probe = await directFetch(good.result.url, { headers: { Accept: '*/*' } }, 8000);
      const text = probe && probe.ok ? await probe.text() : '';
      if (text.trimStart().startsWith('#EXTM3U')) {
        note(`reaproveitada a última extração boa deste título (há ${Math.round((Date.now() - good.at) / 60000)} min): os nós não responderam agora, mas a playlist ainda abre`);
        return good.result;
      }
      note('a última extração boa deste título já não abre; descartada');
    } catch (err) {
      note(`a última extração boa não abriu (${err.message}); descartada`);
    }
    lastGood.delete(key);
  }

  const counts = {};
  for (const why of run.errors) counts[why] = (counts[why] || 0) + 1;
  const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([why, n]) => `${why} ×${n}`);
  note(`RESUMO: ${Math.min(MAX_NODES, nodes.length)} nó(s) tentados · ${parts.join(' · ') || 'sem resposta'}`);

  // Mesmo erro em 2+ nós = falha sistêmica, não do título: abre o disjuntor para o próximo pedido
  // nem perder tempo com a pool (e para de martelar a origem).
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 2) {
    const reason = String(top[0]).replace(/^HTTP \d+:\s*/, '').replace(/\s*\(vs_src 429\)$/, '');
    openBreaker(reason || top[0]);
    if (breakerOpen()) note(`DISJUNTOR ABERTO por ${breaker.windowMinutes || BREAKER_MINUTES} min: o próximo filme vai direto ao AdFallback`);
  }
  return null;
}

function _resetVidsrcState() { if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
  nodeHealth.clear(); lastGood.clear(); familyHealth.clear(); callLog.clear(); titleNode.clear(); nodeStats.clear(); breaker = { until: 0, reason: '', failures: 0, openedAt: 0, windowMinutes: 0 }; }

// VidLink Pro vem primeiro: é o único extrator nativo, responde em ~1s e já
// traz qualidades/codec/legendas. Os demais só entram quando ele não acha o título.
// AnimeFire (só age em anime japonês do TMDB) vem antes do CinePro: é mais rápido e traz dublado em pt-BR.
const ALL_PROVIDERS = [
  // Só age se VIDSRC_PROXY_URL estiver definido; sem ela devolve null e a cascata segue igual.
  { name: 'Vidsrc Proxy', fn: tryVidsrcProxy },
  { name: 'VidLink Pro', fn: tryVidLink },
  { name: 'AnimeFire', fn: tryAnimeFire },
  { name: 'CinePro', fn: tryCinePro },
  { name: 'CineWinx', fn: tryCineWinx },
  { name: 'Stream-Winx', fn: tryStreamWinx },
  { name: 'Consumet', fn: tryConsumet },
  { name: 'Vidsrc', fn: tryVidsrc },
  { name: 'Embed.su', fn: tryEmbedSu },
  { name: 'MegaMoviesLibre', fn: tryMegaMoviesLibre },
  { name: 'API5', fn: tryApi5 },
  { name: 'KekikStream', fn: tryKekikStream },
  // Só entra se PT_DUB_API_BASE estiver definido (áudio dublado em português).
  { name: 'Dublado PT', fn: tryPortugues }
];

function getProviderList() {
  // Provedor opcional: sem PT_DUB_API_BASE ele não aparece nem no diagnóstico.
  const available = ALL_PROVIDERS.filter((p) => p.name !== 'Dublado PT' || process.env.PT_DUB_API_BASE);
  if (!process.env.FALLBACK_ORDER) {
    return available;
  }
  const order = process.env.FALLBACK_ORDER
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const matched = [];
  for (const name of order) {
    const p = available.find((item) => item.name.toLowerCase() === name);
    if (p) matched.push(p);
  }
  // Adiciona os que não foram especificados no final
  for (const item of available) {
    if (!matched.some((m) => m.name === item.name)) {
      matched.push(item);
    }
  }
  return matched;
}

/**
 * Executa a cascata de fallback até encontrar o primeiro stream válido.
 *
 * @param {{id: string|number, type: 'movie'|'tv', season?: number, episode?: number, title?: string}} options
 * @returns {Promise<object|null>}
 */
async function getFallbackStream(options) {
  const { id, type, season = 1, episode = 1, title = '', trace = null } = options;
  const skip = new Set(Array.isArray(options.skip) ? options.skip : []);
  const s = Math.max(1, Number(season) || 1);
  const e = Math.max(1, Number(episode) || 1);
  const providers = getProviderList();

  for (const p of providers) {
    if (skip.has(p.name)) continue;
    console.log(`[fallback] Tentando ${p.name}...`);
    const entry = { provider: p.name, outcome: 'sem resultado', ms: 0, notes: [] };
    if (trace) trace.push(entry);
    const started = Date.now();
    try {
      const result = await p.fn(id, type, s, e, title, { note: (msg) => entry.notes.push(String(msg)) });
      entry.ms = Date.now() - started;
      if (result && result.url) {
        entry.outcome = 'USADO';
        console.log(`[fallback] ✅ ${p.name} retornou stream com sucesso!`);
        return {
          ...result,
          provider: result.provider || p.name
        };
      }
    } catch (err) {
      entry.ms = Date.now() - started;
      entry.outcome = 'erro';
      entry.notes.push(err.message);
      console.warn(`[fallback] ${p.name} falhou:`, err.message);
    }
    entry.ms = entry.ms || Date.now() - started;
  }

  console.warn('[fallback] ❌ Todos os provedores na cascata falharam.');
  return null;
}

module.exports = {
  getFallbackStream,
  getProviderList,
  getCineProReport,
  tryCinePro,
  tryVidsrcProxy,
  tryAnimeFire,
  tryCineWinx,
  tryStreamWinx,
  tryConsumet,
  tryVidLink,
  tryVidsrc,
  tryEmbedSu,
  tryMegaMoviesLibre,
  tryApi5,
  tryKekikStream,
  tryPortugues,
  formatCaptions,
  raceNodes,
  orderNodes,
  familyOf,
  familyCooling,
  markNodeCall,
  callsInWindow,
  breakerOpen,
  breakerState,
  vidsrcHealth,
  openBreaker,
  closeBreaker,
  scheduleProbe,
  infraFailure,
  _resetVidsrcState
};
