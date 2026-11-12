// Entrega de TV ao vivo (HLS) pela Vercel: /live/hls (Edge) e /live/np (função Node).
//
// Por que existe: o site do fdsFlix é HTTPS e a maioria das fontes de IPTV é HTTP, então o navegador
// bloqueia (conteúdo misto) e quase nenhuma libera CORS. A Vercel busca a playlist e os segmentos
// e entrega ao navegador, e o Render nunca vê um byte de vídeo (o limite dele é de 5 GB/mês).
//
// Duas rotas, um código só (só Web APIs, roda no Edge e no Node 20):
//   /live/hls  Edge runtime: conta só os 100 GB de Fast Data Transfer. MAS o Edge só alcança as portas
//              80 e 443 (outra porta é descartada e a conexão vai para a porta padrão).
//   /live/np   função Node: alcança qualquer porta, só que conta também os 10 GB de Fast Origin Transfer.
//
// Segurança: nada é buscado sem assinatura. O fdsFlix (Render) assina `live|<validade>|<url>` com HMAC e
// o proxy confere assinatura E validade (6 h), então um link vazado morre sozinho. Hosts locais e de rede
// privada nunca são buscados. ATENÇÃO: sem PROXY_SECRET próprio, o segredo embutido é o do repositório;
// defina PROXY_SECRET igual na Vercel e no Render se o repositório for público.

import secretModule from './secret.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TTL_MS = 6 * 60 * 60 * 1000;
const PLAYLIST_TIMEOUT_MS = 15000;
const SEGMENT_TIMEOUT_MS = 45000;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;

export const CAPABILITY = { live: 1 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
};

const encoder = new TextEncoder();

function env(e) {
  if (e) return e;
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

export function getSecret(e) {
  const x = env(e);
  const value = String(x.PROXY_SECRET || x.SESSION_SECRET || secretModule.BUILTIN_PROXY_SECRET).trim();
  return value || secretModule.BUILTIN_PROXY_SECRET;
}

/* ------------------------------- assinatura -------------------------------- */

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const keyCache = new Map();
function hmacKey(secret) {
  if (!keyCache.has(secret)) {
    keyCache.set(
      secret,
      crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    );
  }
  return keyCache.get(secret);
}

/** Mesma conta que lib/liveTv.js (Render) faz: base64url(HMAC-SHA256(secret, "live|exp|url")) em 22 chars. */
export async function signLive(url, exp, secret) {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`live|${exp}|${url}`));
  return toBase64Url(new Uint8Array(mac)).slice(0, 22);
}

async function verifyLive(url, exp, signature, secret, now) {
  const e = Number(exp);
  if (!signature || !Number.isFinite(e) || e < now) return false;
  return safeEqual(await signLive(url, e, secret), String(signature));
}

async function livePath(route, url, secret, now) {
  const exp = now + TTL_MS;
  return `${route}?u=${encodeURIComponent(url)}&e=${exp}&s=${await signLive(url, exp, secret)}`;
}

/* ------------------------------ rede privada ------------------------------- */

export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(':')) {
    return host === '::1' || host === '::' || /^(fe80|fc|fd)/.test(host) || /^::ffff:/.test(host);
  }
  return false;
}

/* ------------------------------ reescrita de HLS --------------------------- */

/** Troca cada URI (variantes, segmentos, chaves, mapas) por uma URL assinada deste mesmo proxy. */
export async function rewriteLive(text, upstreamUrl, route, secret, now = Date.now()) {
  const map = async (raw) => {
    const value = String(raw || '').trim();
    if (!value) return raw;
    let abs;
    try {
      abs = new URL(value, upstreamUrl);
    } catch (error) {
      return raw;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return raw;
    return livePath(route, abs.toString(), secret, now);
  };

  const lines = text.split(/\r?\n/);
  const out = await Promise.all(
    lines.map(async (line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) {
        if (!/URI="/.test(line)) return line;
        const parts = line.split(/(URI=")([^"]*)(")/);
        // split com 3 grupos: [antes, 'URI="', valor, '"', depois, ...]
        for (let i = 2; i < parts.length; i += 4) parts[i] = await map(parts[i]);
        return parts.join('');
      }
      return map(line);
    })
  );
  return out.join('\n');
}

/* --------------------------------- resposta -------------------------------- */

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function textResponse(text, status) {
  return new Response(text, { status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function discard(response) {
  try {
    if (response && response.body) await response.body.cancel();
  } catch (error) {
    /* ignora */
  }
}

async function fetchUpstream(fetchFn, start, range, timeoutMs, allowPrivate = false) {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = new URL(current);
    if (!allowPrivate && isPrivateHost(parsed.hostname)) throw Object.assign(new Error('host não permitido'), { status: 403 });
    const headers = { 'User-Agent': UA, Accept: '*/*' };
    if (range) headers.Range = range;
    // AbortController + setTimeout (como o edgeHls.mjs): o relógio vale até chegarem os cabeçalhos; depois o corpo
    // do segmento corre solto, sem ser cortado no meio.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchFn(current, { redirect: 'manual', headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await discard(response);
      current = new URL(location, current).toString();
      continue;
    }
    return { response, finalUrl: current };
  }
  throw Object.assign(new Error('redirecionamentos demais'), { status: 508 });
}

async function readCapped(response, cap) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw Object.assign(new Error('playlist grande demais'), { status: 502 });
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return new TextDecoder().decode(all);
}

async function serve(request, opts) {
  const fetchFn = opts.fetch || fetch;
  const route = opts.route || '/live/hls';
  const secret = getSecret(opts.env);
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const url = new URL(request.url);

  if (url.searchParams.get('cap') === '1') return jsonResponse({ ...CAPABILITY, route });

  let upstream;
  try {
    upstream = new URL(String(url.searchParams.get('u') || ''));
  } catch (error) {
    return jsonResponse({ error: 'URL inválida' }, 400);
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') return jsonResponse({ error: 'protocolo não permitido' }, 400);
  if (!(await verifyLive(upstream.toString(), url.searchParams.get('e'), url.searchParams.get('s'), secret, now))) {
    return jsonResponse({ error: 'URL não assinada ou vencida' }, 403);
  }

  const looksPlaylist = /\.m3u8?(?:$|\?)/i.test(upstream.pathname + upstream.search);
  const { response, finalUrl } = await fetchUpstream(
    fetchFn,
    upstream.toString(),
    request.headers.get('range'),
    looksPlaylist ? PLAYLIST_TIMEOUT_MS : SEGMENT_TIMEOUT_MS,
    env(opts.env).LIVE_ALLOW_PRIVATE_HOSTS === '1' // só para testes locais
  );

  if (!response.ok && response.status !== 206) {
    const body = await response.text().catch(() => '');
    return textResponse(body.slice(0, 300) || `Fonte respondeu ${response.status}`, response.status === 404 ? 404 : 502);
  }

  const contentType = String(response.headers.get('content-type') || '');
  const isPlaylist = looksPlaylist || /mpegurl/i.test(contentType) || /\.m3u8?(?:$|\?)/i.test(new URL(finalUrl).pathname);
  if (isPlaylist) {
    const text = await readCapped(response, MAX_PLAYLIST_BYTES);
    if (!text.startsWith('#EXTM3U')) return textResponse('A fonte não devolveu uma playlist HLS', 502);
    return new Response(await rewriteLive(text, finalUrl, route, secret, now), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }
    });
  }

  const headers = {
    ...CORS,
    'Cache-Control': 'no-store',
    'Content-Type': /html|text/i.test(contentType) || !contentType ? 'video/mp2t' : contentType
  };
  for (const name of ['content-range', 'accept-ranges', 'content-length']) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Handler das rotas /live/hls e /live/np. `opts.fetch`, `opts.env`, `opts.now` e `opts.route` existem para teste.
 * @param {Request} request
 */
export async function handleLive(request, opts = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'HEAD') return jsonResponse({ error: 'método não permitido' }, 405);
  try {
    const response = await serve(request, opts);
    if (request.method === 'HEAD') {
      await discard(response);
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  } catch (error) {
    const status = error && error.status ? error.status : 502;
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return textResponse(`Falha na TV ao vivo: ${timedOut ? 'a fonte demorou demais' : error && error.message ? error.message : error}`, timedOut ? 504 : status);
  }
}
