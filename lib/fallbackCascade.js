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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
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

async function tryVidsrcProxy(id, type, s, e, title, ctx) {
  const note = (msg) => { if (ctx && ctx.note) ctx.note(msg); };
  const pool = usage.rankedPool();
  if (!pool.length) {
    note('Nenhuma Vercel configurada (VIDSRC_PROXY_URL / VIDSRC_PROXY_URLS) → provedor ignorado');
    return null;
  }
  note(`pool de ${pool.length} Vercel(s), da mais folgada para a mais cheia: ` +
    pool.map((p) => `${new URL(p.base).hostname} ${p.usedPct}%${p.exhausted ? ' (ESGOTADA)' : ''}`).join(' · '));

  const captionsPromise = companionCaptions(id, type, s, e);
  const query = type === 'tv'
    ? `tmdb=${encodeURIComponent(id)}&type=tv&s=${s}&e=${e}`
    : `tmdb=${encodeURIComponent(id)}&type=movie`;

  for (const { base } of pool.slice(0, 3)) {
    const host = new URL(base).hostname;
    try {
      const t0 = Date.now();
      const res = await directFetch(`${base}/vidsrc/stream?${query}`, {
        headers: { Accept: 'application/json' }
      }, 12000);
      note(`[${host}] GET /vidsrc/stream → HTTP ${res ? res.status : '?'} em ${Date.now() - t0} ms`);
      if (!res || !res.ok) {
        if (res) note(`[${host}] corpo: ${String(await res.text().catch(() => '')).slice(0, 160)}`);
        continue;
      }

      const data = await res.json();
      if (!data || !data.ok || !data.url) {
        note(`[${host}] resposta sem stream: ${JSON.stringify(data).slice(0, 160)}`);
        continue;
      }
      note(`[${host}] extraído: "${data.title || '?'}" · ${(data.sources || []).length} espelho(s)`);

      // Confere se a master toca de verdade (também "aquece" o token da instância).
      const candidates = [data.url, ...(Array.isArray(data.sources) ? data.sources.map((x) => x.url) : [])]
        .filter((url, index, list) => url && list.indexOf(url) === index)
        .slice(0, 3);
      for (let i = 0; i < candidates.length; i += 1) {
        try {
          const t1 = Date.now();
          const probe = await directFetch(candidates[i], { headers: { Accept: '*/*' } }, 10000);
          const text = probe && probe.ok ? await probe.text() : '';
          const good = text.trimStart().startsWith('#EXTM3U');
          note(`[${host}] espelho ${i + 1}: master HTTP ${probe ? probe.status : '?'} em ${Date.now() - t1} ms · ${good ? 'playlist HLS válida' : 'NÃO é playlist'}`);
          if (!good) continue;

          let captions = formatCaptions(data.subtitles);
          let captionSource = 'Vidsrc';
          if (!captions.length) {
            captions = formatCaptions(await captionsPromise);
            captionSource = 'VidLink';
          }
          note(`legendas: ${captions.length}${captions.length ? ` (de ${captionSource})` : ' (nenhuma fonte tem para este título)'}`);
          return {
            url: candidates[i],
            provider: 'Vidsrc',
            quality: 'auto',
            isHls: true,
            proxyBase: base,
            captions
          };
        } catch (err) {
          note(`[${host}] espelho ${i + 1}: falhou (${err.message})`);
        }
      }
    } catch (err) {
      note(`[${host}] erro: ${err.name === 'AbortError' ? 'tempo esgotado' : err.message}`);
    }
  }
  return null;
}

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
  { name: 'KekikStream', fn: tryKekikStream }
];

function getProviderList() {
  if (!process.env.FALLBACK_ORDER) {
    return ALL_PROVIDERS;
  }
  const order = process.env.FALLBACK_ORDER
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const matched = [];
  for (const name of order) {
    const p = ALL_PROVIDERS.find((item) => item.name.toLowerCase() === name);
    if (p) matched.push(p);
  }
  // Adiciona os que não foram especificados no final
  for (const item of ALL_PROVIDERS) {
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
  const s = Math.max(1, Number(season) || 1);
  const e = Math.max(1, Number(episode) || 1);
  const providers = getProviderList();

  for (const p of providers) {
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
  formatCaptions
};
