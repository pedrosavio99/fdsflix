// Entrega do vídeo do Vidsrc no EDGE runtime da Vercel (rota /vidsrc/hls).
//
// Por que existe: na função Node (lib/vidsrc.js -> proxyVidsrcHls) cada byte do vídeo
// passa pela função e conta DUAS vezes: Fast Data Transfer (100 GB no Hobby) e Fast Origin
// Transfer (10 GB no Hobby). O limite menor trava primeiro, então cada conta rendia 10 GB.
// No Edge runtime o mesmo repasse NÃO conta Fast Origin Transfer (medido: 300 MB pelo
// Edge => FOT 0), então a conta passa a render os 100 GB.
//
// O que roda aqui: só a parte que mexe nos bytes — verificar a assinatura, buscar no CDN do
// Vidsrc com o token, reescrever playlists e repassar segmentos. A resolução do título
// (/vidsrc/stream) continua na função Node, porque decifra a lista de streams com WASM e o
// Edge não permite compilar WASM em tempo de execução.
//
// IP binding: o CDN amarra o token ao /24 do IP que o gerou, e o IP de saída do Edge é
// diferente do da função Node. Por isso este módulo GERA O PRÓPRIO token (mesma cadeia do
// resolveVidsrc, sem a etapa de decifrar, que não é necessária para o token).
//
// Compatível com o que já existe: as URLs assinadas (`/vidsrc/hls?u=&s=`) têm o mesmo
// formato e a mesma assinatura HMAC da versão Node, então um master emitido pela função Node
// funciona aqui e vice-versa. Só Web APIs (nada de Buffer/stream/crypto do Node).

import secretModule from './secret.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const CDN_REFERER = 'https://stellarconductornexus.com/';
const CANARY_TMDB = '603';
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000;
const CDN_TIMEOUT_MS = 25000;

// Resposta de `/vidsrc/hls?cap=1`: o fdsFlix (Render) pergunta isto para saber que esta
// Vercel entrega pelo Edge (cota de 100 GB) e não pela função Node (cota efetiva de 10 GB).
export const CAPABILITY = { adproxy: 'edge', v: 1 };

const encoder = new TextEncoder();

/* ------------------------------- assinatura -------------------------------- */

function currentEnv(env) {
  if (env) return env;
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

// Mesma regra de lib/config.js: PROXY_SECRET > SESSION_SECRET > valor embutido.
export function getSecret(env) {
  const e = currentEnv(env);
  const value = String(e.PROXY_SECRET || e.SESSION_SECRET || secretModule.BUILTIN_PROXY_SECRET).trim();
  return value || secretModule.BUILTIN_PROXY_SECRET;
}

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

// Igual a sign() de lib/vidsrc.js: base64url(HMAC-SHA256(secret, url)) cortado em 22 chars.
export async function sign(url, secret) {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(url));
  return toBase64Url(new Uint8Array(mac)).slice(0, 22);
}

export async function verify(url, signature, secret) {
  if (!signature) return false;
  return safeEqual(await sign(url, secret), String(signature));
}

async function proxiedPath(url, secret) {
  return `/vidsrc/hls?u=${encodeURIComponent(url)}&s=${await sign(url, secret)}`;
}

/* ----------------------------- reescrita de HLS ----------------------------- */

// Igual a rewriteHls de lib/vidsrc.js: tira o token e assina cada URI (variantes, segmentos, chaves).
export async function rewriteHls(text, upstreamUrl, secret) {
  const map = async (raw) => {
    const value = String(raw || '').trim();
    if (!value || value.startsWith('#')) return raw;
    let url;
    try {
      url = new URL(value, upstreamUrl);
      url.searchParams.delete('token');
    } catch (error) {
      return raw;
    }
    return proxiedPath(url.toString(), secret);
  };

  const lines = String(text || '').split(/\r?\n/);
  const out = await Promise.all(
    lines.map(async (line) => {
      if (!line.trim()) return line;
      if (!line.startsWith('#')) return map(line);
      const matches = [...line.matchAll(/URI="([^"]+)"/g)];
      if (!matches.length) return line;
      const mapped = await Promise.all(matches.map((m) => map(m[1])));
      let result = '';
      let last = 0;
      matches.forEach((m, i) => {
        result += `${line.slice(last, m.index)}URI="${mapped[i]}"`;
        last = m.index + m[0].length;
      });
      return result + line.slice(last);
    })
  );
  return out.join('\n');
}

/* --------------------------------- token ----------------------------------- */

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

async function fetchText(fetchFn, url, headers = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
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

/**
 * Gera um token do generate.php A PARTIR DO IP DESTE EDGE. É a cadeia de resolveVidsrc
 * (vidsrc.sh -> stellar -> player -> metaApi -> api.php -> generate.php) sem decifrar a lista
 * de streams: o token só depende do `api_token` e do IP, não dos streams.
 */
export async function mintToken(fetchFn) {
  const embed = `https://vidsrc.sh/embed/movie/${CANARY_TMDB}/`;

  const page = await fetchText(fetchFn, embed, { Referer: 'https://vidsrc.sh/' });
  if (!page.response.ok) throw new Error(`embed HTTP ${page.response.status}`);
  const apiPathMatch = page.text.match(/data-api="([^"]+)"/i);
  if (!apiPathMatch) throw new Error('data-api não encontrado');

  const srcResponse = await fetchText(fetchFn, new URL(decodeEntities(apiPathMatch[1]), embed).toString(), {
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
  const stellar = await fetchText(fetchFn, stellarUrl, { Referer: embed });
  const cfg = parseJsonAssignment(stellar.text, 'CFG');
  if (!cfg || !cfg.playerUrl) throw new Error('CFG/playerUrl ausente');

  const playerUrl = new URL(cfg.playerUrl, 'https://stellarconductornexus.com').toString();
  const player = await fetchText(fetchFn, playerUrl, { Referer: srcJson.src });
  const config = parseJsonAssignment(player.text, 'CONFIG');
  if (!config || !config.apiToken) throw new Error('CONFIG/apiToken ausente');

  const meta = await fetchText(fetchFn, cfg.metaApi, { Referer: srcJson.src });
  let metaJson;
  try {
    metaJson = JSON.parse(meta.text);
  } catch (error) {
    throw new Error('metaApi não é JSON');
  }
  const host = metaJson && metaJson.data && metaJson.data.stream_urls_api_host;
  if (!host) throw new Error('stream_urls_api_host ausente');

  // Mesmo pedido que a cadeia original faz antes do generate.php (a resposta não importa aqui).
  const apiUrl =
    `https://${host}/api.php?type=movie&tmdb=${encodeURIComponent(CANARY_TMDB)}` +
    `&stream_urls&api_token=${encodeURIComponent(config.apiToken)}`;
  await fetchText(fetchFn, apiUrl, { Referer: playerUrl }).catch(() => null);

  const tokenResponse = await fetchText(
    fetchFn,
    `https://${host}/generate.php?api_token=${encodeURIComponent(config.apiToken)}`,
    { Referer: playerUrl }
  );
  const token = String(tokenResponse.text || '').trim();
  if (!token) throw new Error('generate.php sem token');
  return token;
}

// Um token por instância do Edge (módulo): vale ~4 h e para qualquer título. Se o CDN responder
// 403 "not in range" (IP de saída mudou), o token é refeito (getToken com o token que falhou).
const tokenState = { token: null, expires: 0, pending: null };

export async function getToken(fetchFn, staleToken) {
  const fresh = tokenState.token && Date.now() < tokenState.expires && tokenState.token !== staleToken;
  if (fresh) return tokenState.token;
  if (!tokenState.pending) {
    tokenState.pending = mintToken(fetchFn)
      .then((token) => {
        tokenState.token = token;
        tokenState.expires = Date.now() + TOKEN_TTL_MS;
        return token;
      })
      .finally(() => {
        tokenState.pending = null;
      });
  }
  return tokenState.pending;
}

export function resetTokenForTests() {
  tokenState.token = null;
  tokenState.expires = 0;
  tokenState.pending = null;
}

/* -------------------------------- handler ---------------------------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function textResponse(text, status) {
  return new Response(text, {
    status,
    headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function withToken(raw, token) {
  const url = new URL(raw);
  url.searchParams.set('token', token);
  return url.toString();
}

async function fetchCdn(fetchFn, upstream, token, range) {
  const headers = { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity', Referer: CDN_REFERER };
  if (range) headers.Range = range;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDN_TIMEOUT_MS);
  try {
    // O prazo vale só até os cabeçalhos chegarem; depois o corpo (segmento) corre sem corte.
    return await fetchFn(withToken(upstream.toString(), token), { headers, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function discard(response) {
  try {
    if (response.body) await response.body.cancel();
  } catch (error) {
    /* ignora */
  }
}

async function serve(request, opts) {
  const fetchFn = opts.fetch || fetch;
  const secret = getSecret(opts.env);
  const url = new URL(request.url);

  if (url.searchParams.get('cap') === '1') return jsonResponse(CAPABILITY);

  const raw = String(url.searchParams.get('u') || '');
  let upstream;
  try {
    upstream = new URL(raw);
  } catch (error) {
    return jsonResponse({ error: 'URL inválida' }, 400);
  }
  if (upstream.protocol !== 'https:' || !(await verify(upstream.toString(), String(url.searchParams.get('s') || ''), secret))) {
    return jsonResponse({ error: 'URL não assinada pelo proxy' }, 403);
  }

  const range = request.headers.get('range');
  let token = await getToken(fetchFn);
  let response = await fetchCdn(fetchFn, upstream, token, range);

  if (response.status === 403) {
    // IP de saída mudou desde que o token foi gerado: refaz e tenta de novo.
    await discard(response);
    token = await getToken(fetchFn, token);
    response = await fetchCdn(fetchFn, upstream, token, range);
  }
  for (let retry = 0; retry < 3 && response.status === 429; retry += 1) {
    // Rate limit do CDN: espera um pouco (respeitando Retry-After) e repete.
    const wait = Math.min(2000, (Number(response.headers.get('retry-after')) || 0) * 1000 || 250 * (retry + 1) ** 2);
    await discard(response);
    await new Promise((resolve) => setTimeout(resolve, wait));
    response = await fetchCdn(fetchFn, upstream, token, range);
  }

  if (!response.ok && response.status !== 206) {
    return textResponse(await response.text(), response.status);
  }

  const contentType = String(response.headers.get('content-type') || '');
  const isPlaylist = /mpegurl/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(upstream.pathname + upstream.search);

  if (isPlaylist) {
    const text = await response.text();
    return new Response(await rewriteHls(text, upstream.toString(), secret), {
      status: response.status,
      headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }
    });
  }

  // O CDN serve os segmentos MPEG-TS como text/html; normaliza para o player.
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
 * Handler da rota /vidsrc/hls. `opts.fetch` e `opts.env` existem para os testes.
 * @param {Request} request
 */
export async function handleHls(request, opts = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'método não permitido' }, 405);
  }
  try {
    const response = await serve(request, opts);
    if (request.method === 'HEAD') {
      await discard(response);
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  } catch (error) {
    return textResponse(`Falha no Vidsrc: ${error && error.message ? error.message : error}`, 502);
  }
}
