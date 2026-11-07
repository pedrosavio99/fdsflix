'use strict';

/**
 * Proxy de vídeo.
 *
 * Motivo de existir: o CDN do provedor devolve HTTP 429 sempre que a
 * requisição chega com Referer/Origin de outra origem. O navegador SEMPRE
 * manda esses cabeçalhos ao carregar <video src="https://cdn...">, então o
 * vídeo nunca tocava direto. Aqui a requisição sai sem Referer/Origin e
 * ainda renovamos a URL assinada quando ela está perto de expirar.
 */

const http = require('http');
const https = require('https');

// Atenção: o CDN do provedor responde 428 para qualquer User-Agent que comece
// com "Mozilla" (anti-hotlink). Um UA neutro (ou nenhum) funciona.
const USER_AGENT = 'fdsFlix/2.0 (+local player)';

const MAX_REDIRECTS = 4;
const UPSTREAM_TIMEOUT_MS = 30000;
const TOKEN_TTL_MS = 4 * 60 * 1000;
const REFRESH_MARGIN_MS = 45000;

const FORWARD_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag'
];

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const AUTH_ERROR_CODES = new Set([401, 403, 410]);

function requestOnce(targetUrl, method, range) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      return reject(new Error('URL inválida'));
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Accept-Encoding': 'identity'
    };
    if (range) headers.Range = range;

    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method,
        headers
      },
      resolve
    );

    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      req.destroy(new Error('tempo esgotado no provedor'));
    });
    req.on('error', reject);
    req.end();
  });
}

async function openUpstream(url, method, range, redirects = 0) {
  const response = await requestOnce(url, method, range);
  const status = response.statusCode || 0;

  if (REDIRECT_CODES.has(status) && response.headers.location && redirects < MAX_REDIRECTS) {
    response.resume();
    const next = new URL(response.headers.location, url).toString();
    return openUpstream(next, method, range, redirects + 1);
  }

  return { response, status };
}

async function refreshEntry(entry) {
  if (typeof entry.refresh !== 'function') return null;
  try {
    const fresh = await entry.refresh();
    if (fresh) {
      entry.url = fresh;
      entry.expiresAt = Date.now() + TOKEN_TTL_MS;
      return fresh;
    }
  } catch (err) {
    console.warn('[proxy] falha ao renovar URL:', err.message);
  }
  return null;
}

function sendError(res, status, message) {
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: message });
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{url: string, expiresAt?: number, refresh?: () => Promise<string|null>}} entry
 */
async function proxyVideo(req, res, entry) {
  if (entry.expiresAt && Date.now() > entry.expiresAt - REFRESH_MARGIN_MS) {
    await refreshEntry(entry);
  }

  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  const range = req.headers.range;

  let opened;
  try {
    opened = await openUpstream(entry.url, method, range);
  } catch (err) {
    return sendError(res, 502, 'Falha ao conectar no provedor: ' + err.message);
  }

  // A assinatura pode ter expirado entre a extração e o play: renova e tenta 1x.
  if (AUTH_ERROR_CODES.has(opened.status) && typeof entry.refresh === 'function') {
    opened.response.resume();
    const fresh = await refreshEntry(entry);
    if (fresh) {
      try {
        opened = await openUpstream(fresh, method, range);
      } catch (err) {
        return sendError(res, 502, 'Falha ao conectar no provedor: ' + err.message);
      }
    }
  }

  const { response, status } = opened;

  if (status >= 400) {
    response.resume();
    const message =
      status === 429
        ? 'O provedor recusou a requisição (429). Tente recarregar o player.'
        : `O provedor respondeu HTTP ${status}.`;
    return sendError(res, status === 429 ? 429 : 502, message);
  }

  res.status(status);
  for (const header of FORWARD_HEADERS) {
    const value = response.headers[header];
    if (value) res.setHeader(header, value);
  }
  if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  if (method === 'HEAD') {
    response.resume();
    return res.end();
  }

  res.on('close', () => response.destroy());
  response.on('error', () => res.destroy());
  response.pipe(res);
}

module.exports = {
  proxyVideo,
  USER_AGENT,
  TOKEN_TTL_MS
};
