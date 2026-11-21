'use strict';

/**
 * Legendas PT-BR pelo OpenSubtitles (fonte externa, independente do servidor de vídeo).
 *
 * Por que existe: a legenda "de companhia" (VidLink) é boa quando o título está no catálogo deles,
 * mas falha em muitos. Aqui a busca é por `tmdb_id` (o mesmo id que o app já tem), com preferência
 * por pt-BR, e o download devolve o arquivo direto do OpenSubtitles.
 *
 * O texto baixado passa pelo motor de tradução existente (`lib/translate.js` → `translateVtt`) quando
 * a legenda vier em outro idioma — e a verificação de sincronia (duração/offset) fica no
 * `/api/subtitle`, que é quem serve a faixa ao player.
 *
 * Chave: hardcoded por pedido do dono (pode sobrescrever com OPENSUBTITLES_KEY no ambiente).
 */

const KEY = process.env.OPENSUBTITLES_KEY || 'a30YhWpPd4TzdtBaaiqK1lbz50XNj1ZR';
const BASE = 'https://api.opensubtitles.com/api/v1';
const UA = 'fdsFlix v1.0';

const cache = new Map();
const CACHE_MS = 30 * 60 * 1000;

function headers() {
  return { 'Api-Key': KEY, 'User-Agent': UA, Accept: 'application/json' };
}

function remember(key, value) {
  cache.set(key, { value, until: Date.now() + CACHE_MS });
  while (cache.size > 400) cache.delete(cache.keys().next().value);
  return value;
}

async function searchRaw({ tmdbId, imdbId, type, season, episode, query }) {
  const q = new URLSearchParams({ languages: 'pt-BR', order_by: 'download_count', order_direction: 'desc' });
  if (tmdbId) q.set('tmdb_id', String(tmdbId));
  if (imdbId) q.set('imdb_id', String(imdbId));
  if (query) q.set('query', String(query));
  if (type === 'tv') {
    q.set('type', 'episode');
    if (season) q.set('season_number', String(season));
    if (episode) q.set('episode_number', String(episode));
  } else {
    q.set('type', 'movie');
  }
  const res = await fetch(`${BASE}/subtitles?${q}`, { headers: headers() });
  if (!res.ok) throw new Error('OpenSubtitles HTTP ' + res.status);
  const data = await res.json();
  return Array.isArray(data && data.data) ? data.data : [];
}

// Cota da API nova (100 downloads/dia para a chave do site inteiro): última leitura da resposta do /download.
const quota = { remaining: NaN, resetUtc: '' };

async function download(fileId) {
  const res = await fetch(`${BASE}/download`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
    body: JSON.stringify({ file_id: fileId })
  });
  if (!res.ok) throw new Error('OpenSubtitles download HTTP ' + res.status);
  const data = await res.json();
  if (data && Number.isFinite(Number(data.remaining))) { quota.remaining = Number(data.remaining); quota.resetUtc = String(data.reset_time_utc || ''); }
  return data && data.link ? String(data.link) : '';
}

/**
 * Devolve captions no mesmo formato do resto do app ({ url, label, lang, translated }).
 * Usa o `tmdb_id` do título/episódio; se faltar, aceita `query` (nome).
 */
async function captions({ tmdbId, imdbId, type, season, episode, query }) {
  const key = `${type}:${tmdbId || imdbId || query}:${type === 'tv' ? `${season}x${episode}` : ''}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;

  const out = [];
  try {
    const results = await searchRaw({ tmdbId, imdbId, type, season, episode, query });
    // Prefere pt-BR e releases mais baixadas; limita a 3 downloads por chamada.
    const picked = results
      .filter((r) => r && r.attributes && Array.isArray(r.attributes.files) && r.attributes.files.length)
      .slice(0, 3);
    for (const r of picked) {
      const f = r.attributes.files[0];
      if (!f || !f.file_id) continue;
      try {
        const link = await download(f.file_id);
        if (!link) continue;
        out.push({
          url: link,
          label: 'Português (OpenSubtitles)',
          lang: 'pt-BR',
          translated: false
        });
      } catch (err) { /* tenta a próxima */ }
    }
  } catch (err) {
    return remember(key, []);
  }
  return remember(key, out);
}

module.exports = { captions, download, searchRaw, quota, KEY };
