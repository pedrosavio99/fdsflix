'use strict';

const { Readable } = require('stream');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const ALLOWED_HOSTS = ['oakhollowoutpost.space', 'data.vidsrc.sh', 'vidsrc.sh'];

function allowedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALLOWED_HOSTS.some((item) => host === item || host.endsWith('.' + item));
}

function withTimeout(controller, ms) {
  return setTimeout(() => controller.abort(), ms);
}

async function fetchText(url, headers = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = withTimeout(controller, timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        ...headers
      },
      redirect: 'follow',
      signal: controller.signal
    });
    return { response, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function parseJsonAssignment(text, name) {
  const re = new RegExp(`(?:window\\.)?${name}\\s*=\\s*(\\{[\\s\\S]*?\\});`);
  const match = String(text || '').match(re);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    return null;
  }
}

async function decryptStreamUrls(streamUrls, vs) {
  if (Array.isArray(streamUrls)) return streamUrls;
  if (typeof streamUrls !== 'string' || !vs) return [];

  let wasm;
  if (vs.wasm_url) {
    const response = await fetch(vs.wasm_url, {
      headers: { 'User-Agent': UA, Accept: 'application/wasm,*/*' }
    });
    if (!response.ok) throw new Error(`WASM HTTP ${response.status}`);
    wasm = await response.arrayBuffer();
  } else if (vs.wasm) {
    wasm = Buffer.from(vs.wasm, 'base64');
  } else {
    return [];
  }

  const { instance } = await WebAssembly.instantiate(wasm, {});
  const exports = instance.exports;
  const encrypted = Buffer.from(streamUrls, 'base64');
  const pointer = exports.alloc(encrypted.length);
  new Uint8Array(exports.memory.buffer, pointer, encrypted.length).set(encrypted);
  const length = exports.decrypt(pointer, encrypted.length);
  const text = new TextDecoder().decode(
    new Uint8Array(exports.memory.buffer, pointer + 12, length)
  );
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Extrai as playlists HLS do Vidsrc atual (vidsrc.sh -> stellar -> API + WASM).
 * Retorna URLs de master.m3u8 já com o token JWT do generate.php.
 */
async function resolveVidsrc(options) {
  const { id, type = 'movie', season = 1, episode = 1 } = options;
  const isTv = type === 'tv';
  const embed = isTv
    ? `https://vidsrc.sh/embed/tv/${encodeURIComponent(id)}/${Number(season) || 1}/${Number(episode) || 1}/`
    : `https://vidsrc.sh/embed/movie/${encodeURIComponent(id)}/`;

  const page = await fetchText(embed, { Referer: 'https://vidsrc.sh/' });
  if (!page.response.ok) throw new Error(`embed HTTP ${page.response.status}`);
  const apiPathMatch = page.text.match(/data-api="([^"]+)"/i);
  if (!apiPathMatch) throw new Error('data-api não encontrado');
  const apiPath = decodeEntities(apiPathMatch[1]);

  const srcResponse = await fetchText(new URL(apiPath, embed).toString(), {
    Referer: embed
  });
  if (!srcResponse.response.ok) throw new Error(`vs_src HTTP ${srcResponse.response.status}`);
  let srcJson;
  try {
    srcJson = JSON.parse(srcResponse.text);
  } catch (error) {
    throw new Error('vs_src não é JSON');
  }
  if (!srcJson || !srcJson.src) throw new Error('vs_src sem src');

  const stellarUrl = new URL(srcJson.src, 'https://stellarconductornexus.com').toString();
  const stellar = await fetchText(stellarUrl, { Referer: embed });
  const cfg = parseJsonAssignment(stellar.text, 'CFG');
  if (!cfg || !cfg.playerUrl) throw new Error('CFG/playerUrl ausente');

  const playerUrl = new URL(cfg.playerUrl, 'https://stellarconductornexus.com').toString();
  const player = await fetchText(playerUrl, { Referer: srcJson.src });
  const config = parseJsonAssignment(player.text, 'CONFIG');
  if (!config || !config.apiToken) throw new Error('CONFIG/apiToken ausente');

  const meta = await fetchText(cfg.metaApi, { Referer: srcJson.src });
  let metaJson;
  try {
    metaJson = JSON.parse(meta.text);
  } catch (error) {
    throw new Error('metaApi não é JSON');
  }
  const host = metaJson && metaJson.data && metaJson.data.stream_urls_api_host;
  if (!host) throw new Error('stream_urls_api_host ausente');

  const apiUrl =
    `https://${host}/api.php?type=${encodeURIComponent(type)}&tmdb=${encodeURIComponent(id)}` +
    `&stream_urls&api_token=${encodeURIComponent(config.apiToken)}`;
  const api = await fetchText(apiUrl, { Referer: playerUrl });
  if (!api.response.ok) throw new Error(`stream API HTTP ${api.response.status}`);
  let apiJson;
  try {
    apiJson = JSON.parse(api.text);
  } catch (error) {
    throw new Error('stream API não é JSON');
  }
  if (!apiJson || !apiJson.data || apiJson.data.stream_urls == null) {
    throw new Error('stream API sem stream_urls');
  }

  const streams = await decryptStreamUrls(apiJson.data.stream_urls, apiJson.vs);
  if (!streams.length) throw new Error('nenhuma playlist decriptada');

  const tokenResponse = await fetchText(
    `https://${host}/generate.php?api_token=${encodeURIComponent(config.apiToken)}`,
    { Referer: playerUrl }
  );
  const token = String(tokenResponse.text || '').trim();
  if (!token) throw new Error('generate.php sem token');

  return {
    provider: 'Vidsrc',
    host,
    pageUrl: embed,
    playerUrl,
    urls: streams.map((url) => `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`),
    subtitles: Array.isArray(apiJson.default_subs) ? apiJson.default_subs : [],
    title: metaJson.data.title || null
  };
}

function rewriteHls(text, upstreamUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const map = (raw) => {
    const value = String(raw || '').trim();
    if (!value || value.startsWith('#')) return raw;
    let url;
    try {
      url = new URL(value, upstreamUrl).toString();
    } catch (error) {
      return raw;
    }
    return `/vidsrc/hls?u=${encodeURIComponent(url)}`;
  };

  return lines
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (match, uri) => `URI="${map(uri)}"`);
      }
      return map(line);
    })
    .join('\n');
}

async function proxyVidsrcHls(req, res, config) {
  const raw = String(req.query.u || '');
  let upstream;
  try {
    upstream = new URL(raw);
  } catch (error) {
    return res.status(400).json({ error: 'URL inválida' });
  }
  if (upstream.protocol !== 'https:' || !allowedHost(upstream.hostname)) {
    return res.status(403).json({ error: 'Host não permitido' });
  }

  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    Referer: 'https://stellarconductornexus.com/'
  };
  if (req.headers.range) headers.Range = req.headers.range;

  const response = await fetch(upstream, { headers, redirect: 'follow' });
  if (!response.ok && response.status !== 206) {
    return res.status(response.status).type('text').send(await response.text());
  }

  const contentType = String(response.headers.get('content-type') || '');
  const isPlaylist =
    /mpegurl/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(upstream.pathname + upstream.search);

  if (isPlaylist) {
    const text = await response.text();
    const body = rewriteHls(text, upstream.toString());
    res.status(response.status);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(body);
  }

  res.status(response.status);
  res.setHeader('Access-Control-Allow-Origin', '*');
  for (const name of ['content-type', 'content-range', 'accept-ranges', 'content-length']) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!response.body) return res.end();
  Readable.fromWeb(response.body).pipe(res);
}

module.exports = { resolveVidsrc, proxyVidsrcHls, rewriteHls };
