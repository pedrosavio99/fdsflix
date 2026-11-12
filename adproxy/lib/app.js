'use strict';

const express = require('express');
const { Readable } = require('stream');

const { removedSummary, sanitizeHtml } = require('./htmlRewrite');
const { rewriteCss } = require('./cssRewrite');
const { rewriteHls, isHlsContentType } = require('./hlsRewrite');
const { resolveVidsrcCached, proxyVidsrcHls, probeVidsrc, setCors, proxiedPath } = require('./vidsrc');
const { isAdHost, isAdUrl, isPlayerHost } = require('./adRules');
const {
  assertSafeDestination,
  proxyPath,
  refererFromRequest,
  rewriteUrl,
  targetPath,
  targetUrlFromRequest,
  verifyToken
} = require('./urls');
const {
  buildRequestHeaders,
  copyResponseHeaders,
  decodeText,
  fetchUpstream,
  isCssContentType,
  isHtmlContentType,
  readBody
} = require('./upstream');

const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function setupPage() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AdShield — configuração pendente</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e8eaed;margin:0;display:grid;min-height:100vh;place-items:center}
  main{max-width:640px;padding:32px}
  h1{font-size:1.5rem;margin:0 0 12px}
  p{line-height:1.6;color:#aeb4bf}
  code{background:#1c2029;padding:2px 6px;border-radius:5px;color:#9fd1ff}
  pre{background:#1c2029;padding:16px;border-radius:10px;overflow:auto;color:#c9d4e3}
  .badge{display:inline-block;background:#3a1d1d;color:#ff9d9d;border:1px solid #6b2b2b;padding:4px 9px;border-radius:999px;font-size:.8rem;margin-bottom:16px}
</style>
</head>
<body><main>
<span class="badge">TARGET_ORIGIN ausente</span>
<h1>AdShield Proxy</h1>
<p>Defina a variável de ambiente <code>TARGET_ORIGIN</code> com a origem do site que será proxiado.</p>
<pre>TARGET_ORIGIN=https://site-alvo.com
PROXY_SECRET=uma-chave-aleatoria-longa</pre>
<p>Depois reinicie o serviço. O health check fica em <code>/_adshield/health</code>.</p>
</main></body></html>`;
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      req.resume();
      return resolve(undefined);
    }

    const declared = Number(req.get('content-length') || 0);
    if (declared > maxBytes) {
      const error = new Error('Corpo da requisição grande demais');
      error.status = 413;
      req.resume();
      return reject(error);
    }

    const chunks = [];
    let total = 0;
    let exceeded = false;
    req.on('data', (chunk) => {
      if (exceeded) return;
      total += chunk.length;
      if (total > maxBytes) {
        exceeded = true;
        const error = new Error('Corpo da requisição grande demais');
        error.status = 413;
        // Drena o restante para conseguir responder 413 em vez de resetar o socket.
        req.resume();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('Requisição abortada'), { status: 499 })));
  });
}

async function rewriteRedirectLocation(location, baseUrl, config) {
  let next;
  try {
    next = new URL(location, baseUrl);
  } catch (error) {
    const invalid = new Error('Redirecionamento inválido');
    invalid.status = 502;
    throw invalid;
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    const error = new Error('Redirecionamento para protocolo não permitido');
    error.status = 403;
    throw error;
  }

  await assertSafeDestination(next, config);

  if (isAdUrl(next.toString(), undefined) && !isPlayerHost(next.hostname, config)) {
    const error = new Error('Redirecionamento para domínio de anúncio bloqueado');
    error.status = 403;
    throw error;
  }

  if (next.origin === config.targetOrigin) {
    const path = targetPath(next);
    if (path.startsWith('//') || path.startsWith(config.controlPrefix)) {
      return proxyPath(next.toString(), baseUrl, config);
    }
    return path || '/';
  }

  if (!config.allowCrossOrigin) return next.toString();
  return proxyPath(next.toString(), baseUrl, config);
}

function sendRedirect(res, upstream, location, config) {
  copyResponseHeaders(upstream.response, res, {
    config,
    isTargetRequest: upstream.isTargetRequest,
    setCookies: upstream.setCookies,
    modified: false
  });
  res.status(upstream.response.status);
  res.setHeader('Location', location);
  res.setHeader('Content-Length', '0');
  res.removeHeader('Content-Type');
  res.end();
}

async function sendUpstream(req, res, upstream, meta) {
  const { config, isTargetRequest, setCookies, mode, documentUrl } = meta;
  const response = upstream.response;
  const contentType = String(response.headers.get('content-type') || '');
  const status = response.status;
  const pageReferer = documentUrl || refererFromRequest(req, config) || upstream.finalUrl;

  const baseMeta = {
    config,
    isTargetRequest,
    setCookies,
    modified: false
  };

  if (req.method === 'HEAD' || status === 204 || status === 304) {
    copyResponseHeaders(response, res, baseMeta);
    const length = response.headers.get('content-length');
    if (length && !response.headers.get('content-encoding')) res.setHeader('Content-Length', length);
    res.status(status).end();
    return;
  }

  if (isHtmlContentType(contentType)) {
    const buffer = await readBody(response, config.maxHtmlBytes);
    const text = decodeText(buffer, contentType);
    const { html, stats } = sanitizeHtml(text, {
      url: upstream.finalUrl,
      config,
      mode
    });
    const out = Buffer.from(html, 'utf8');

    copyResponseHeaders(response, res, { ...baseMeta, modified: true });
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', out.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-AdShield-Removed', removedSummary(stats));
    if (config.debug) {
      console.log(`[html] ${status} ${upstream.finalUrl} removidos=${removedSummary(stats)}`);
    }
    res.end(out);
    return;
  }

  if (isCssContentType(contentType)) {
    const buffer = await readBody(response, config.maxCssBytes);
    const text = decodeText(buffer, contentType);
    const stats = {};
    const rewritten = rewriteCss(
      text,
      upstream.finalUrl,
      (raw, base) =>
        rewriteUrl(raw, base, {
          config,
          mode,
          pageUrl: pageReferer,
          navigation: false
        }),
      stats
    );
    const out = Buffer.from(rewritten, 'utf8');

    copyResponseHeaders(response, res, { ...baseMeta, modified: true });
    res.status(status);
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Content-Length', out.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(out);
    return;
  }

  if (isHlsContentType(contentType) || /\.m3u8(?:$|\?)/i.test(new URL(upstream.finalUrl).pathname + new URL(upstream.finalUrl).search)) {
    const buffer = await readBody(response, config.maxCssBytes);
    const text = decodeText(buffer, contentType || 'application/vnd.apple.mpegurl');
    const rewritten = rewriteHls(text, upstream.finalUrl, pageReferer, config);
    const out = Buffer.from(rewritten, 'utf8');

    copyResponseHeaders(response, res, { ...baseMeta, modified: true });
    res.status(status);
    res.setHeader('Content-Type', contentType || 'application/vnd.apple.mpegurl');
    res.setHeader('Content-Length', out.length);
    res.end(out);
    return;
  }

  copyResponseHeaders(response, res, baseMeta);
  res.status(status);
  const length = response.headers.get('content-length');
  if (length && !response.headers.get('content-encoding')) res.setHeader('Content-Length', length);
  if (!response.body) {
    res.end();
    return;
  }

  const stream = Readable.fromWeb(response.body);
  stream.on('error', (error) => {
    if (!res.headersSent) res.status(502).end();
    else res.destroy(error);
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function createApp(config) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  if (config.trustProxy) app.set('trust proxy', true);

  app.use((req, res, next) => {
    res.setHeader('X-AdShield-Version', config.version);
    if (config.debug) {
      const pathOnly = String(req.originalUrl || '').split('?')[0];
      console.log(`[req] ${req.method} ${pathOnly}`);
    }
    next();
  });

  app.get('/_adshield/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = {
      ok: Boolean(config.targetOrigin),
      version: config.version,
      target: config.targetOrigin || null,
      secretStable: config.secretStable,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version
    };
    if (!config.targetOrigin) {
      body.error = 'TARGET_ORIGIN não configurado';
      return res.status(503).json(body);
    }
    res.json(body);
  });

  app.get('/_adshield/info', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: Boolean(config.targetOrigin),
      version: config.version,
      target: config.targetOrigin || null,
      flow: {
        pages: 'HTML sanitizado e recursos reescritos',
        sameOrigin: 'caminhos passam pelo catch-all do proxy',
        crossOrigin: 'URLs assinadas em /_adshield/r/<token>',
        playerIframes: config.proxyPlayerIframes
          ? 'proxiados (pode quebrar players que validam origem)'
          : 'mantidos diretos para preservar a reprodução'
      },
      limits: {
        maxHtmlBytes: config.maxHtmlBytes,
        maxCssBytes: config.maxCssBytes,
        maxRequestBodyBytes: config.maxBodyBytes
      }
    });
  });

  app.get('/_adshield/blocked.gif', (req, res) => {
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(TRANSPARENT_GIF);
  });

  app.all('/_adshield/r/:token', async (req, res) => {
    if (!config.targetOrigin) return res.status(503).type('text').send('TARGET_ORIGIN não configurado');
    if (req.method === 'CONNECT' || req.method === 'TRACE') return res.status(405).end();

    const entry = verifyToken(req.params.token, config);
    if (!entry) {
      return res.status(403).type('text').send('Token de recurso inválido.');
    }

    let target;
    try {
      target = new URL(entry.url);
    } catch (error) {
      return res.status(400).type('text').send('URL inválida.');
    }

    if (isAdHost(target.hostname) && !isPlayerHost(target.hostname, config)) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-AdShield-Blocked', 'ad-domain');
      return res.status(204).end();
    }

    const isTargetRequest = target.origin === config.targetOrigin;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
    res.on('close', () => controller.abort());

    try {
      const body = await readRequestBody(req, config.maxBodyBytes);
      const headers = buildRequestHeaders(req, target, config, {
        isTargetRequest,
        referer: entry.referer
      });
      const upstream = await fetchUpstream(target, {
        config,
        method: req.method,
        headers,
        body,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (upstream.redirect) {
        const location = await rewriteRedirectLocation(upstream.redirect, upstream.finalUrl, config);
        sendRedirect(res, { ...upstream, isTargetRequest }, location, config);
        return;
      }
      await sendUpstream(req, res, upstream, {
        config,
        isTargetRequest,
        setCookies: upstream.setCookies,
        mode: 'proxied',
        documentUrl: entry.referer || upstream.finalUrl
      });
    } catch (error) {
      clearTimeout(timer);
      handleProxyError(req, res, error, config);
    }
  });

  app.options('/vidsrc/*', (req, res) => {
    setCors(res);
    res.status(204).end();
  });

  app.get('/vidsrc/stream', async (req, res) => {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    const id = String(req.query.tmdb || req.query.id || '').trim();
    if (!/^\d+$/.test(id)) {
      return res.status(400).json({ error: 'tmdb/id inválido' });
    }
    const type = String(req.query.type || 'movie') === 'tv' ? 'tv' : 'movie';
    const season = Math.max(1, Number(req.query.s || req.query.season) || 1);
    const episode = Math.max(1, Number(req.query.e || req.query.episode) || 1);
    try {
      const result = await resolveVidsrcCached({ id, type, season, episode }, config);
      const base = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
      const proxied = (item) => `${base}${proxiedPath(item)}`;
      // Cada item é um ESPELHO com a master.m3u8 completa (640p/1280p/1920p); o
      // player escolhe a qualidade sozinho (ABR).
      res.json({
        ok: true,
        provider: result.provider,
        title: result.title,
        type,
        tmdb: id,
        url: proxied(result.urls[0]),
        sources: result.urls.map((item, index) => ({ index, url: proxied(item) })),
        subtitles: result.subtitles
      });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  app.get('/vidsrc/probe', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const id = String(req.query.tmdb || req.query.id || '603').trim();
    const url = req.query.url ? String(req.query.url) : undefined;
    try {
      const out = await probeVidsrc({
        id,
        url,
        type: String(req.query.type || 'movie') === 'tv' ? 'tv' : 'movie',
        season: Number(req.query.s) || 1,
        episode: Number(req.query.e) || 1
      });
      res.json(out);
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  app.get('/vidsrc/hls', async (req, res) => {
    try {
      await proxyVidsrcHls(req, res, config);
    } catch (error) {
      if (!res.headersSent) res.status(502).type('text').send(`Falha no Vidsrc: ${error.message}`);
      else res.destroy();
    }
  });

  // TV ao vivo por função Node: alcança qualquer porta (o Edge só vai às 80/443). Mesmo código do Edge
  // (lib/liveHls.mjs); o Edge atende /live/hls. Ver o cabeçalho de liveHls.mjs.
  app.all('/live/np', async (req, res) => {
    try {
      const { handleLive } = await import('./liveHls.mjs');
      const headers = {};
      if (req.headers.range) headers.range = req.headers.range;
      const request = new Request(`https://${req.headers.host || 'localhost'}${req.originalUrl}`, { method: req.method, headers });
      const out = await handleLive(request, { route: '/live/np' });
      res.status(out.status);
      out.headers.forEach((value, name) => res.setHeader(name, value));
      if (!out.body) return res.end();
      const stream = Readable.fromWeb(out.body);
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      if (!res.headersSent) res.status(502).type('text').send(`Falha na TV ao vivo: ${error.message}`);
      else res.destroy();
    }
  });

  app.all('/_adshield/*', (req, res) => {
    res.status(404).json({ error: 'Rota interna desconhecida.' });
  });

  app.all('*', async (req, res) => {
    if (!config.targetOrigin) {
      res.status(503).type('html').send(setupPage());
      return;
    }
    if (req.method === 'CONNECT' || req.method === 'TRACE') return res.status(405).end();

    let target;
    try {
      target = targetUrlFromRequest(req, config);
    } catch (error) {
      res.status(503).type('text').send('TARGET_ORIGIN não configurado.');
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
    res.on('close', () => controller.abort());

    try {
      const body = await readRequestBody(req, config.maxBodyBytes);
      const headers = buildRequestHeaders(req, target, config, { isTargetRequest: true });
      const upstream = await fetchUpstream(target, {
        config,
        method: req.method,
        headers,
        body,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (upstream.redirect) {
        const location = await rewriteRedirectLocation(upstream.redirect, upstream.finalUrl, config);
        sendRedirect(res, { ...upstream, isTargetRequest: true }, location, config);
        return;
      }
      await sendUpstream(req, res, upstream, {
        config,
        isTargetRequest: true,
        setCookies: upstream.setCookies,
        mode: 'target',
        documentUrl: upstream.finalUrl
      });
    } catch (error) {
      clearTimeout(timer);
      handleProxyError(req, res, error, config);
    }
  });

  return app;
}

function handleProxyError(req, res, error, config) {
  if (res.writableEnded || res.destroyed) return;

  const status = Number(error.status) || (error.name === 'AbortError' ? 504 : 502);
  const message =
    status === 504
      ? 'O site de origem demorou demais para responder.'
      : status === 403
        ? 'Destino bloqueado pelo proxy.'
        : status === 413
          ? 'Corpo da requisição grande demais.'
          : 'Falha ao buscar o conteúdo no site de origem.';

  if (config.debug) {
    console.warn(`[proxy] ${req.method} ${String(req.originalUrl).split('?')[0]} -> ${status}: ${error.message}`);
  }

  if (res.headersSent) {
    res.destroy(error);
    return;
  }

  if (status === 204) return res.status(204).end();
  if (status >= 400 && status < 600) {
    res.status(status).type('text/plain').send(config.debug ? `${message}\n${error.message}` : message);
    return;
  }
  res.status(502).type('text/plain').send('Falha no proxy.');
}

module.exports = { createApp, setupPage };
