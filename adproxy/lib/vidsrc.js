'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// Segmentos e playlists ficam em domínios que mudam por título (ex.: master em
// oakhollowoutpost.space, segmentos em sageandsolstice.space), então não há lista
// fixa de hosts. Em vez disso, toda URL que o proxy emite é ASSINADA (HMAC) e o
// proxy só busca URLs assinadas por ele: não vira proxy aberto nem alvo de SSRF.
let signingSecret = null;

function configureSigning(config) {
  if (signingSecret) return;
  if (config && config.secretStable) {
    signingSecret = config.secret;
    return;
  }
  const seed =
    process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_PROJECT_ID || process.env.VERCEL_URL || '';
  signingSecret = seed
    ? crypto.createHash('sha256').update(`fdsflix-vidsrc|${seed}`).digest('hex')
    : (config && config.secret) || crypto.randomBytes(32).toString('hex');
}

function sign(url) {
  return crypto.createHmac('sha256', signingSecret).update(url).digest('base64url').slice(0, 22);
}

function verify(url, signature) {
  if (!signingSecret || !signature) return false;
  const expected = Buffer.from(sign(url));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function proxiedPath(url) {
  return `/vidsrc/hls?u=${encodeURIComponent(url)}&s=${sign(url)}`;
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
    apiToken: config.apiToken,
    pageUrl: embed,
    playerUrl,
    token,
    rawUrls: streams,
    urls: streams.map((url) => `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`),
    subtitles: Array.isArray(apiJson.default_subs) ? apiJson.default_subs : [],
    title: metaJson.data.title || null
  };
}

// ---------------------------------------------------------------------------
// Token por instância
//
// O CDN do Vidsrc amarra o JWT (`token`) ao CIDR do IP que o gerou (/24 no IPv4,
// /64 no IPv6). O caminho `/pl/...` NÃO é amarrado, e o token vale para qualquer
// título por ~4h. Como cada instância serverless pode sair por um IP diferente,
// cada uma guarda o PRÓPRIO token e o aplica em qualquer caminho. Se o CDN
// responder "not in range" (IP mudou), o token é refeito e a requisição repete.
// ---------------------------------------------------------------------------
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000;
const CANARY_TMDB = '603';
const tokenState = { token: null, expires: 0, pending: null };
const resolveCache = new Map();
const RESOLVE_TTL_MS = 10 * 60 * 1000;

function rememberToken(host, token) {
  if (token) {
    tokenState.token = token;
    tokenState.expires = Date.now() + TOKEN_TTL_MS;
  }
}

async function getEdgeToken(staleToken) {
  // `staleToken`: token que acabou de falhar. Se outra requisição já o trocou,
  // reaproveita o novo em vez de refazer a cadeia inteira (evita rajada de mints).
  const fresh = tokenState.token && Date.now() < tokenState.expires && tokenState.token !== staleToken;
  if (fresh) return tokenState.token;
  if (!tokenState.pending) {
    tokenState.pending = resolveVidsrc({ id: CANARY_TMDB, type: 'movie' })
      .then((result) => {
        rememberToken(result.host, result.token);
        return result.token;
      })
      .finally(() => {
        tokenState.pending = null;
      });
  }
  return tokenState.pending;
}

function stripToken(raw) {
  const url = new URL(raw);
  url.searchParams.delete('token');
  return url.toString();
}

function withToken(raw, token) {
  const url = new URL(raw);
  url.searchParams.set('token', token);
  return url.toString();
}

/** Igual a resolveVidsrc, mas com cache e URLs SEM token (o proxy aplica o dele). */
async function resolveVidsrcCached(options, config) {
  configureSigning(config);
  const key = [options.type || 'movie', options.id, options.season || 1, options.episode || 1].join(':');
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.value;
  const result = await resolveVidsrc(options);
  rememberToken(result.host, result.token);
  const value = {
    provider: result.provider,
    title: result.title,
    subtitles: result.subtitles,
    urls: result.rawUrls.map(stripToken)
  };
  resolveCache.set(key, { at: Date.now(), value });
  if (resolveCache.size > 200) resolveCache.delete(resolveCache.keys().next().value);
  return value;
}

function rewriteHls(text, upstreamUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const map = (raw) => {
    const value = String(raw || '').trim();
    if (!value || value.startsWith('#')) return raw;
    let url;
    try {
      url = new URL(value, upstreamUrl);
      url.searchParams.delete('token');
    } catch (error) {
      return raw;
    }
    return proxiedPath(url.toString());
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

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

async function fetchCdn(upstream, token, rangeHeader) {
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    Referer: 'https://stellarconductornexus.com/'
  };
  if (rangeHeader) headers.Range = rangeHeader;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(withToken(upstream.toString(), token), {
      headers,
      redirect: 'follow',
      signal: controller.signal
    });
    return { response, timer };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function proxyVidsrcHls(req, res, config) {
  configureSigning(config);
  setCors(res);
  const raw = String(req.query.u || '');
  let upstream;
  try {
    upstream = new URL(raw);
  } catch (error) {
    return res.status(400).json({ error: 'URL inválida' });
  }

  if (upstream.protocol !== 'https:' || !verify(upstream.toString(), String(req.query.s || ''))) {
    return res.status(403).json({ error: 'URL não assinada pelo proxy' });
  }

  let token = await getEdgeToken();

  let attempt = await fetchCdn(upstream, token, req.headers.range);
  if (attempt.response.status === 403) {
    // IP de saída mudou desde que o token foi gerado: refaz e tenta de novo.
    clearTimeout(attempt.timer);
    await attempt.response.arrayBuffer().catch(() => null);
    token = await getEdgeToken(token);
    attempt = await fetchCdn(upstream, token, req.headers.range);
  }
  for (let retry = 0; retry < 3 && attempt.response.status === 429; retry += 1) {
    // Rate limit do CDN: espera um pouco (respeitando Retry-After) e repete.
    clearTimeout(attempt.timer);
    const wait = Math.min(2000, (Number(attempt.response.headers.get('retry-after')) || 0) * 1000 || 250 * (retry + 1) ** 2);
    await attempt.response.arrayBuffer().catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, wait));
    attempt = await fetchCdn(upstream, token, req.headers.range);
  }

  const { response, timer } = attempt;
  res.on('close', () => clearTimeout(timer));
  res.setHeader('Cache-Control', 'no-store');

  if (!response.ok && response.status !== 206) {
    clearTimeout(timer);
    return res.status(response.status).type('text').send(await response.text());
  }

  const contentType = String(response.headers.get('content-type') || '');
  const isPlaylist =
    /mpegurl/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(upstream.pathname + upstream.search);

  if (isPlaylist) {
    const text = await response.text();
    clearTimeout(timer);
    res.status(response.status);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    return res.send(rewriteHls(text, upstream.toString()));
  }

  res.status(response.status);
  // O CDN serve os segmentos MPEG-TS como text/html; normaliza para o player.
  res.setHeader('Content-Type', /html|text/i.test(contentType) || !contentType ? 'video/mp2t' : contentType);
  for (const name of ['content-range', 'accept-ranges', 'content-length']) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!response.body) {
    clearTimeout(timer);
    return res.end();
  }
  const stream = Readable.fromWeb(response.body);
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function egressIp() {
  try {
    const { text } = await fetchText('https://api.ipify.org', {}, 8000);
    return text.trim();
  } catch (error) {
    return null;
  }
}

async function probeStep(url, headers, wantBytes) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity', ...headers },
      redirect: 'follow'
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      ms: Date.now() - started,
      bytes: buffer.length,
      contentType: response.headers.get('content-type'),
      head: wantBytes ? undefined : buffer.toString('utf8', 0, 160),
      text: wantBytes ? undefined : buffer.toString('utf8'),
      first: wantBytes ? buffer.subarray(0, 4).toString('hex') : undefined
    };
  } catch (error) {
    return { status: 0, error: error.message, ms: Date.now() - started };
  }
}

/**
 * Teste do IP binding: baixa master -> variante -> 1 segmento a partir do IP
 * DESTA função. Se `url` vier, usa essa master (resolvida em outra invocação).
 */
async function probeVidsrc(options) {
  const out = { egressIp: await egressIp(), steps: {} };
  const referer = { Referer: 'https://stellarconductornexus.com/' };
  let master = options.url;
  if (!master) {
    const started = Date.now();
    const resolved = await resolveVidsrc(options);
    out.resolveMs = Date.now() - started;
    out.resolvedFromIp = out.egressIp;
    master = resolved.urls[resolved.urls.length - 1];
    out.master = master;
  }
  const m = await probeStep(master, referer, false);
  out.steps.master = { status: m.status, ms: m.ms, bytes: m.bytes, head: m.head, error: m.error };
  if (m.status !== 200) return out;

  const lines = String(m.text).split(/\r?\n/).map((l) => l.trim());
  const variant = lines.find((l) => l && !l.startsWith('#'));
  if (!variant) return out;
  const variantUrl = new URL(variant, master).toString();
  const v = await probeStep(variantUrl, referer, false);
  out.steps.variant = { status: v.status, ms: v.ms, bytes: v.bytes, head: v.head, error: v.error };
  if (v.status !== 200) return out;

  const seg = String(v.text).split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!seg) return out;
  const segUrl = new URL(seg, variantUrl).toString();
  const s = await probeStep(segUrl, { ...referer, Range: 'bytes=0-262143' }, true);
  out.steps.segment = { status: s.status, ms: s.ms, bytes: s.bytes, contentType: s.contentType, first: s.first, error: s.error };
  return out;
}

module.exports = {
  resolveVidsrc,
  resolveVidsrcCached,
  proxyVidsrcHls,
  rewriteHls,
  probeVidsrc,
  getEdgeToken,
  setCors,
  proxiedPath,
  configureSigning,
  rememberToken
};
