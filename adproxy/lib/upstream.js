'use strict';

const { isAdUrl, isPlayerHost } = require('./adRules');
const { assertSafeDestination, refererFromRequest } = require('./urls');

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection'
]);

const RESPONSE_BLOCKLIST = new Set([
  ...HOP_BY_HOP,
  'content-length',
  'content-encoding',
  'set-cookie',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  'feature-policy',
  'strict-transport-security',
  'public-key-pins',
  'public-key-pins-report-only',
  'alt-svc',
  'server',
  'x-powered-by',
  'x-adshield-version',
  'x-adshield-removed',
  'x-adshield-blocked',
  'report-to',
  'nel',
  'refresh',
  'link',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers'
]);

function firstHeader(value) {
  return String(Array.isArray(value) ? value[0] : value || '').trim();
}

function buildRequestHeaders(req, targetUrl, config, options = {}) {
  const headers = {
    'User-Agent': config.userAgent,
    Accept: firstHeader(req.get('accept')) || '*/*',
    'Accept-Language': firstHeader(req.get('accept-language')) || 'pt-BR,pt;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity'
  };

  for (const name of ['cache-control', 'pragma', 'range', 'if-range', 'if-none-match', 'if-modified-since']) {
    const value = firstHeader(req.get(name));
    if (value) headers[name.replace(/(^|-)([a-z])/g, (m, p, c) => p + c.toUpperCase())] = value;
  }

  const contentType = firstHeader(req.get('content-type'));
  if (contentType) headers['Content-Type'] = contentType;

  const isTarget = options.isTargetRequest !== false;
  if (isTarget) {
    const authorization = firstHeader(req.get('authorization'));
    if (authorization) headers.Authorization = authorization;
    if (config.forwardCookies) {
      const cookie = firstHeader(req.get('cookie'));
      if (cookie) headers.Cookie = cookie;
    }
    if (!['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())) {
      headers.Origin = config.targetOrigin;
    }
  }

  const referer = options.referer || refererFromRequest(req, config);
  if (referer) headers.Referer = referer;

  return headers;
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function collectSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

/**
 * Faz UMA requisição ao upstream, sem seguir redirecionamentos. O chamador
 * transforma o Location em uma rota local (ou token assinado) e devolve o
 * redirecionamento ao navegador. Assim a URL na barra de endereços continua
 * coerente com o site alvo e cada salto passa pelo guard de SSRF.
 */
async function fetchUpstream(initialUrl, options) {
  const { config, method = 'GET', headers, body, signal } = options;
  const currentUrl = new URL(initialUrl);

  await assertSafeDestination(currentUrl, config);

  const response = await fetch(currentUrl, {
    method: String(method || 'GET').toUpperCase(),
    headers,
    body,
    redirect: 'manual',
    signal
  });

  const setCookies = collectSetCookies(response).map((cookie) => ({
    cookie,
    origin: currentUrl.origin
  }));

  const location = response.headers.get('location');
  const isRedirectResponse = isRedirect(response.status) && Boolean(location);

  if (isRedirectResponse && response.body) {
    response.body.cancel().catch(() => {});
  }

  return {
    response,
    finalUrl: currentUrl.toString(),
    setCookies,
    redirect: isRedirectResponse ? location : null
  };
}

function rewriteSetCookie(rawCookie, isSecure) {
  let cookie = String(rawCookie || '');
  cookie = cookie.replace(/;\s*domain=[^;]*/gi, '');
  if (!/;\s*path=/i.test(cookie)) cookie += '; Path=/';
  // Em HTTP local, cookies Secure não seriam gravados. Em produção (HTTPS)
  // mantemos a flag. O Secure não é removido de SameSite=None.
  if (!isSecure) cookie = cookie.replace(/;\s*secure\b/gi, '');
  return cookie;
}

function copyResponseHeaders(upstream, res, options = {}) {
  const { config, isTargetRequest, setCookies = [], modified = false } = options;

  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (RESPONSE_BLOCKLIST.has(lower)) continue;
    if (lower.startsWith('access-control-')) continue;
    if (lower.startsWith('cf-')) continue;
    if (modified && (lower === 'etag' || lower === 'last-modified')) continue;
    if (Array.isArray(value)) res.setHeader(name, value.join(', '));
    else res.setHeader(name, value);
  }

  if (isTargetRequest && setCookies.length) {
    for (const item of setCookies) {
      if (item.origin !== config.targetOrigin) continue;
      res.append('Set-Cookie', rewriteSetCookie(item.cookie, Boolean(res.req && res.req.secure)));
    }
  }
}

async function readBody(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        const error = new Error('Resposta do upstream grande demais para sanitizar');
        error.status = 502;
        error.code = 'BODY_TOO_LARGE';
        throw error;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks);
}

function charsetFromContentType(contentType) {
  const match = String(contentType || '').match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return match ? match[1].trim().toLowerCase() : null;
}

function sniffCharset(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be';

  const head = buffer.subarray(0, 4096).toString('latin1');
  let match = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9._-]+)/i);
  if (match) return match[1].toLowerCase();
  match = head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9._-]+)/i);
  if (match) return match[1].toLowerCase();
  return null;
}

function decodeText(buffer, contentType) {
  const label = charsetFromContentType(contentType) || sniffCharset(buffer) || 'utf-8';
  const normalized = label === 'iso-8859-1' || label === 'latin1' ? 'windows-1252' : label;
  try {
    return new TextDecoder(normalized, { fatal: false }).decode(buffer);
  } catch (error) {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

function isHtmlContentType(contentType) {
  return /(?:text\/html|application\/xhtml\+xml)/i.test(String(contentType || ''));
}

function isCssContentType(contentType) {
  return /^text\/css\b/i.test(String(contentType || ''));
}

module.exports = {
  buildRequestHeaders,
  copyResponseHeaders,
  decodeText,
  fetchUpstream,
  isCssContentType,
  isHtmlContentType,
  readBody,
  rewriteSetCookie
};
