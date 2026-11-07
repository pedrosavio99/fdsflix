'use strict';

/**
 * Extrator do VidLink Pro.
 *
 * O provedor devolve um JSON com as qualidades (360/480/720/1080) e as
 * legendas. O token é o id da mídia + timestamp, cifrado com XSalsa20
 * (tweetnacl) usando a chave de VIDLINK_KEY_HEX.
 */

const nacl = require('tweetnacl');
const { execFile } = require('child_process');

const VIDLINK_KEY_HEX =
  process.env.VIDLINK_KEY_HEX ||
  'c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd';
const VIDLINK_API_URL = (process.env.VIDLINK_API_URL || 'https://vidlink.pro/api/b').replace(/\/+$/, '');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// O CDN de vídeo responde 428/429 para UA de navegador; use um UA neutro.
const MEDIA_USER_AGENT = 'fdsFlix/2.0 (+local player)';

const QUALITY_ORDER = ['1080', '720', '480', '360'];

const key = Buffer.from(VIDLINK_KEY_HEX, 'hex');
const nonce = new Uint8Array(24);

const EXTRACT_TTL_MS = 4 * 60 * 1000; // a URL assinada expira em ~8 min
const extractCache = new Map(); // chave -> { data, expires }
const probeCache = new Map(); // url -> { codec, width, height }

function encryptToken(mediaId) {
  const timestamp = Math.floor(Date.now() / 1000) + 480;
  const mediaIdBuf = Buffer.from(String(mediaId), 'utf-8');
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64BE(BigInt(timestamp));

  const message = Buffer.concat([mediaIdBuf, tsBuf]);
  const ciphertext = nacl.secretbox(new Uint8Array(message), nonce, new Uint8Array(key));
  const payload = Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);

  return payload.toString('base64url');
}

function extractUrl(type, id, season, episode) {
  const token = encryptToken(id);
  if (type === 'movie') {
    return `${VIDLINK_API_URL}/movie/${token}?multiLang=1`;
  }
  return `${VIDLINK_API_URL}/tv/${token}/${season}/${episode}?multiLang=1`;
}

async function fetchVidLink(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Origin: 'https://vidlink.pro',
        Referer: 'https://vidlink.pro/',
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      console.warn(`[vidlink] HTTP ${response.status}`);
      return null;
    }

    return await response.json();
  } catch (err) {
    console.warn('[vidlink] falha na requisição:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeQualities(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const qualities = {};

  for (const entry of Object.keys(source)) {
    const item = source[entry];
    if (!item || !item.url) continue;
    qualities[entry] = {
      url: item.url,
      codecName: String(item.codecName || '').toLowerCase(),
      size: item.size ? Number(item.size) : null
    };
  }

  return qualities;
}

function bestQualityKey(qualities) {
  for (const quality of QUALITY_ORDER) {
    if (qualities[quality]) return quality;
  }
  const keys = Object.keys(qualities).sort((a, b) => Number(b) - Number(a));
  return keys[0] || null;
}

function parseResponse(data) {
  if (!data || !data.stream) return null;

  const stream = data.stream;
  const qualities = normalizeQualities(stream.qualities);
  const best = bestQualityKey(qualities);
  const fallbackUrl = stream.playlist || stream.url || data.url || null;
  const url = best ? qualities[best].url : fallbackUrl;

  if (!url) return null;

  const captions = (Array.isArray(stream.captions) ? stream.captions : [])
    .filter((caption) => caption && caption.url)
    .map((caption) => ({
      url: caption.url,
      language: caption.language || 'Legenda',
      type: String(caption.type || 'srt').toLowerCase()
    }));

  return {
    url,
    quality: best || 'auto',
    qualities,
    codec: best ? qualities[best].codecName : '',
    captions,
    sourceId: data.sourceId || null,
    provider: 'VidLink Pro'
  };
}

/**
 * Descobre o codec real do arquivo quando o provedor não informa.
 * Usa ffprobe (vem junto com o ffmpeg).
 */
function probeVideo(url) {
  const cached = probeCache.get(url);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-user_agent', MEDIA_USER_AGENT,
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height',
      '-of', 'json',
      url
    ];

    let finished = false;
    const done = (result) => {
      if (finished) return;
      finished = true;
      if (result.codec || result.width) probeCache.set(url, result);
      resolve(result);
    };

    const child = execFile(
      'ffprobe',
      args,
      { timeout: 20000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return done({ codec: null, width: null, height: null });
        try {
          const parsed = JSON.parse(stdout);
          const stream = parsed.streams && parsed.streams[0];
          done({
            codec: stream && stream.codec_name ? String(stream.codec_name).toLowerCase() : null,
            width: stream ? stream.width : null,
            height: stream ? stream.height : null
          });
        } catch (parseError) {
          done({ codec: null, width: null, height: null });
        }
      }
    );

    child.on('error', () => done({ codec: null, width: null, height: null }));
  });
}

/**
 * @param {{id: string|number, type: 'movie'|'tv', season?: number, episode?: number, force?: boolean}} options
 */
async function getVidLinkStream({ id, type, season = 1, episode = 1, force = false }) {
  const cacheKey = `${type}:${id}:${season}:${episode}`;

  if (!force) {
    const cached = extractCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return cached.data;
    }
  }

  const url = extractUrl(type, id, Math.max(1, Number(season) || 1), Math.max(1, Number(episode) || 1));
  const data = await fetchVidLink(url);
  const parsed = parseResponse(data);

  if (!parsed) {
    extractCache.delete(cacheKey);
    return null;
  }

  if (!parsed.codec) {
    const probe = await probeVideo(parsed.url);
    parsed.codec = probe.codec || '';
    parsed.width = probe.width;
    parsed.height = probe.height;
  }

  extractCache.set(cacheKey, {
    data: parsed,
    expires: Date.now() + EXTRACT_TTL_MS
  });

  return parsed;
}

module.exports = {
  getVidLinkStream,
  probeVideo,
  QUALITY_ORDER
};
