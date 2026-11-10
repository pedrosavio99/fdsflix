'use strict';

const { proxyPath } = require('./urls');

/**
 * Reescreve playlists HLS (m3u8) para que variantes, segmentos, chaves e mapas
 * também passem pelo proxy. Isso é essencial quando o iframe do player é
 * proxiado: sem isso o navegador resolveria as URIs relativas contra a rota do
 * proxy e a reprodução falharia.
 */
function rewriteHls(text, baseUrl, pageUrl, config) {
  const lines = String(text || '').split(/\r?\n/);
  const cache = new Map();

  const toProxy = (raw) => {
    const value = String(raw || '').trim();
    if (!value || value.startsWith('#') || /^(?:data|blob):/i.test(value)) return raw;
    if (cache.has(value)) return cache.get(value);

    let url;
    try {
      url = new URL(value, baseUrl);
    } catch (error) {
      return raw;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;

    // Não filtramos hosts de anúncio aqui: em HLS, um segmento de anúncio é
    // indistinguível de um segmento normal. O bloqueio acontece no HTML.
    const mapped = proxyPath(url.toString(), pageUrl, config);
    cache.set(value, mapped);
    return mapped;
  };

  return lines
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (match, uri) => `URI="${toProxy(uri)}"`);
      }
      return toProxy(line);
    })
    .join('\n');
}

function isHlsContentType(contentType) {
  return /(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)/i.test(String(contentType || ''));
}

module.exports = { rewriteHls, isHlsContentType };
