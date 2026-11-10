'use strict';

const TRANSPARENT_GIF =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const IMPORT_RE = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);/gi;

function isSkippable(raw) {
  const value = String(raw || '').trim();
  return (
    !value ||
    value.startsWith('#') ||
    /^(?:data|blob|about|mailto|tel|javascript):/i.test(value)
  );
}

/**
 * Reescreve url() e @import de um CSS. URLs bloqueadas viram um GIF transparente
 * (em vez de deixar o navegador buscar o anúncio) e imports bloqueados somem.
 */
function rewriteCss(css, baseUrl, mapUrl, stats = null) {
  const input = String(css || '');
  if (!input) return input;

  const mapped = new Map();

  const map = (raw) => {
    if (isSkippable(raw)) return raw;
    const key = String(raw).trim();
    if (mapped.has(key)) return mapped.get(key);
    const result = mapUrl(key, baseUrl);
    let value;
    if (!result || result.blocked) {
      value = null;
    } else {
      value = result.value;
    }
    mapped.set(key, value);
    return value;
  };

  let output = input.replace(IMPORT_RE, (match, quote, raw, conditions) => {
    const value = map(raw);
    if (!value) {
      if (stats) stats.blockedCssUrls = (stats.blockedCssUrls || 0) + 1;
      return '/* @adshield: @import de anúncio removido */';
    }
    if (stats) stats.rewrittenCssUrls = (stats.rewrittenCssUrls || 0) + 1;
    if (value === raw) return match;
    const suffix = String(conditions || '').trim();
    return `@import url("${value}")${suffix ? ` ${suffix}` : ''};`;
  });

  output = output.replace(URL_RE, (match, quote, raw) => {
    const value = map(raw);
    if (!value) {
      if (stats) stats.blockedCssUrls = (stats.blockedCssUrls || 0) + 1;
      return `url("${TRANSPARENT_GIF}")`;
    }
    if (stats) stats.rewrittenCssUrls = (stats.rewrittenCssUrls || 0) + 1;
    return value === raw ? match : `url("${value}")`;
  });

  return output;
}

module.exports = { rewriteCss, TRANSPARENT_GIF };
