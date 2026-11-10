'use strict';

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');

const { isAdUrl, isPlayerHost } = require('./adRules');

class ProxyError extends Error {
  constructor(message, status = 502, code = 'PROXY_ERROR') {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
    this.code = code;
  }
}

function signUrl(targetUrl, referer, config) {
  const payload = Buffer.from(
    JSON.stringify({ u: String(targetUrl), r: referer ? String(referer) : null, v: 1 }),
    'utf8'
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', config.secret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token, config) {
  const raw = String(token || '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;

  const payload = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);
  const expected = crypto
    .createHmac('sha256', config.secret)
    .update(payload)
    .digest('base64url');

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }
  if (!parsed || typeof parsed.u !== 'string') return null;

  let url;
  try {
    url = new URL(parsed.u);
  } catch (error) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  let referer = null;
  if (parsed.r) {
    try {
      const ref = new URL(parsed.r);
      if (ref.protocol === 'http:' || ref.protocol === 'https:') referer = ref.toString();
    } catch (error) {
      referer = null;
    }
  }

  return { url: url.toString(), referer };
}

function proxyPath(targetUrl, referer, config) {
  return `${config.controlPrefix}/r/${signUrl(targetUrl, referer, config)}`;
}

function isTargetUrl(url, config) {
  if (!config.targetOrigin) return false;
  return url.origin === config.targetOrigin;
}

function targetPath(url) {
  return `${url.pathname || '/'}${url.search || ''}${url.hash || ''}`;
}

/**
 * Converte a URL recebida pelo proxy na URL do site alvo.
 * O caminho é mapeado 1:1, preservando query string e codificação.
 */
function targetUrlFromRequest(req, config) {
  if (!config.targetOrigin) {
    throw new ProxyError('TARGET_ORIGIN não configurado', 503, 'TARGET_NOT_CONFIGURED');
  }
  const original = req.originalUrl || '/';
  const queryIndex = original.indexOf('?');
  const rawPath = queryIndex === -1 ? original : original.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? '' : original.slice(queryIndex + 1);

  const url = new URL(config.targetOrigin);
  url.pathname = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
  url.search = rawQuery ? `?${rawQuery}` : '';
  return url;
}

/**
 * Reescreve uma URL para o espaço do proxy.
 *
 * mode "target": o documento veio do próprio site alvo; links e recursos do
 * mesmo host continuam em caminhos relativos/absolutos e são servidos pelo
 * catch-all do proxy.
 *
 * mode "proxied": o documento veio de outro host por /_adshield/r/...; nesse
 * caso até recursos do mesmo host precisam de um novo token, pois o caminho
 * local pertence ao alvo principal.
 */
function rewriteUrl(rawValue, baseUrl, options) {
  const { config, mode = 'target', pageUrl, navigation = false } = options;
  const original = String(rawValue ?? '').trim();
  if (!original || original.startsWith('#')) {
    return { value: original, blocked: false, changed: false, external: false };
  }
  if (/^(?:data|blob|about|mailto|tel|sms|magnet|javascript|file):/i.test(original)) {
    return { value: original, blocked: false, changed: false, external: false };
  }
  // Já é uma URL do próprio proxy (ex.: um @import que acabou de ser gerado).
  // Não assinar de novo, senão o token apontaria para outro token.
  if (original.startsWith(config.controlPrefix + '/')) {
    return { value: original, blocked: false, changed: false, external: false };
  }

  let url;
  try {
    url = new URL(original, baseUrl || config.targetOrigin || undefined);
  } catch (error) {
    return { value: original, blocked: false, changed: false, external: false };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { value: original, blocked: false, changed: false, external: false };
  }

  const target = isTargetUrl(url, config);
  const player = isPlayerHost(url.hostname, config);
  const ad = !player && isAdUrl(url.toString(), undefined);

  if (ad && !navigation) {
    return { value: original, blocked: true, changed: false, external: !target };
  }

  if (target) {
    if (mode === 'target') {
      const path = targetPath(url);
      if (path.startsWith('//') || path.startsWith(config.controlPrefix)) {
        return {
          value: proxyPath(url.toString(), pageUrl, config),
          blocked: false,
          changed: true,
          external: false
        };
      }
      return { value: path, blocked: false, changed: path !== original, external: false };
    }
    return {
      value: proxyPath(url.toString(), pageUrl, config),
      blocked: false,
      changed: true,
      external: false
    };
  }

  if (!config.allowCrossOrigin) {
    return { value: url.toString(), blocked: false, changed: url.toString() !== original, external: true };
  }
  if (navigation && !config.rewriteExternalLinks) {
    return { value: url.toString(), blocked: false, changed: url.toString() !== original, external: true };
  }

  return {
    value: proxyPath(url.toString(), pageUrl, config),
    blocked: false,
    changed: true,
    external: true
  };
}

function refererFromRequest(req, config) {
  const referer = String(req.get('referer') || '');
  if (!referer) return config.targetOrigin || null;

  let url;
  try {
    url = new URL(referer);
  } catch (error) {
    return config.targetOrigin || null;
  }

  const marker = `${config.controlPrefix}/r/`;
  if (url.pathname.startsWith(marker)) {
    const entry = verifyToken(url.pathname.slice(marker.length), config);
    if (entry && entry.url) return entry.url;
  }

  if (config.targetOrigin && url.origin === config.targetOrigin) return url.toString();

  // O Referer do navegador aponta para o nosso proxy. O do upstream deve ser
  // o do site alvo, que é quem incorpora os recursos.
  if (!config.targetOrigin) return null;
  try {
    return new URL(url.pathname + url.search, config.targetOrigin).toString();
  } catch (error) {
    return config.targetOrigin;
  }
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIP(ip) {
  const value = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const version = net.isIP(value);
  if (version === 4) return isPrivateIPv4(value);
  if (version !== 6) return true;

  if (value === '::' || value === '::1') return true;
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    return net.isIP(mapped) === 4 ? isPrivateIPv4(mapped) : true;
  }
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(value)) return true;
  if (/^ff[0-9a-f]{2}:/.test(value)) return true;
  return false;
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === 'metadata' || host === 'metadata.google.internal' || host === 'instance-data') return true;
  return false;
}

const dnsCache = new Map();
const DNS_CACHE_MS = 60 * 1000;

async function assertSafeDestination(rawUrl, config) {
  let url;
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  } catch (error) {
    throw new ProxyError('URL inválida', 400, 'INVALID_URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProxyError('Protocolo não permitido', 403, 'BAD_PROTOCOL');
  }
  if (url.username || url.password) {
    throw new ProxyError('URL com credenciais não permitida', 403, 'BAD_CREDENTIALS');
  }
  if (isTargetUrl(url, config)) return url;
  if (config.allowPrivateUpstreams) return url;

  const host = url.hostname.toLowerCase();
  if (isPrivateHostname(host)) {
    throw new ProxyError('Destino privado bloqueado', 403, 'PRIVATE_DESTINATION');
  }
  if (net.isIP(host)) {
    if (isPrivateIP(host)) {
      throw new ProxyError('IP privado bloqueado', 403, 'PRIVATE_DESTINATION');
    }
    return url;
  }

  const cached = dnsCache.get(host);
  if (cached && cached.expires > Date.now()) {
    if (!cached.safe) throw new ProxyError('Destino resolve para IP privado', 403, 'PRIVATE_DESTINATION');
    return url;
  }

  let addresses;
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (error) {
    dnsCache.set(host, { safe: false, expires: Date.now() + 15000 });
    throw new ProxyError(`DNS falhou para ${host}`, 502, 'DNS_ERROR');
  }

  const unsafe = addresses.some((item) => isPrivateIP(item.address));
  dnsCache.set(host, { safe: !unsafe, expires: Date.now() + DNS_CACHE_MS });
  if (unsafe) {
    throw new ProxyError('Destino resolve para IP privado', 403, 'PRIVATE_DESTINATION');
  }
  return url;
}

module.exports = {
  ProxyError,
  assertSafeDestination,
  isPrivateIP,
  isPrivateHostname,
  isTargetUrl,
  proxyPath,
  refererFromRequest,
  rewriteUrl,
  signUrl,
  targetUrlFromRequest,
  targetPath,
  verifyToken
};
