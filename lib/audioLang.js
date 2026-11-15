'use strict';

/**
 * Qual idioma está no áudio deste vídeo?
 *
 * O público pede "dublado". Em vez de adivinhar pelo nome do site, leio a faixa de áudio:
 * o MP4 guarda `language` por faixa (`por`, `eng`, `spa`…) e o ffprobe lê isso no cabeçalho.
 * Nesses arquivos o `moov` fica no começo (faststart), então é rápido; em HLS ele lê a
 * playlist e o primeiro pedaço.
 *
 * Best-effort: se o ffprobe não existir (ex.: Render sem ffmpeg) ou estourar o tempo,
 * devolve null e o painel simplesmente não mostra o selo — nunca quebra nada.
 */

const { execFile } = require('child_process');

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map(); // caminho (sem token) -> { langs, until }

function cacheKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (err) {
    return String(url || '');
  }
}

/**
 * @param {string} url
 * @returns {Promise<string[]|null>} ex.: ['por'] · null quando não deu para saber
 */
function audioLanguages(url, timeoutMs = 7000) {
  const key = cacheKey(url);
  if (!key) return Promise.resolve(null);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.langs);

  return new Promise((resolve) => {
    let done = false;
    const finish = (langs) => {
      if (done) return;
      done = true;
      if (langs) cache.set(key, { langs, until: Date.now() + CACHE_TTL_MS });
      resolve(langs);
    };

    const child = execFile(
      'ffprobe',
      ['-v', 'error', '-user_agent', 'fdsFlix/2.0 (+local player)',
        '-select_streams', 'a', '-show_entries', 'stream_tags=language',
        '-of', 'json', url],
      { timeout: Math.max(3000, timeoutMs), maxBuffer: 512 * 1024 },
      (err, stdout) => {
        if (err) return finish(null);
        try {
          const parsed = JSON.parse(stdout);
          const langs = [...new Set((parsed.streams || [])
            .map((s) => String((s.tags && s.tags.language) || '').toLowerCase().trim())
            .filter((l) => l && l !== 'und'))];
          finish(langs.length ? langs : null);
        } catch (parseError) {
          finish(null);
        }
      }
    );
    child.on('error', () => finish(null));
  });
}

/** 'por'/'pt'/'pt-br' = português. */
function isPortuguese(langs) {
  return Array.isArray(langs) && langs.some((l) => /^(por|pt|pt-br|pob)$/i.test(l));
}

module.exports = { audioLanguages, isPortuguese };
