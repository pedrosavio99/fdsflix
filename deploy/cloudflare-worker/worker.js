/**
 * fdsFlix - Cloudflare Worker Repassador para Vídeos e APIs (Streaming Relay)
 *
 * Inspirado no padrão SM_RELAY do módulo-playlist:
 * Bypassa bloqueios de Cloudflare / Datacenter (HTTP 403 / 429) em sites
 * como AnimeFire, catálogos de streaming e CDNs de vídeo.
 *
 * Recursos para vídeo:
 * - Suporte nativo a HTTP Range Requests (Status 206 Partial Content) para busca/seek no player.
 * - Streaming direto do corpo da resposta (ReadableStream) sem acumular dados em memória.
 * - Suporte a playlists HLS (.m3u8), chunks (.ts / .m4s) e APIs JSON.
 * - Cabeçalhos CORS completos para permitir reprodução em qualquer frontend.
 * - Senha OBRIGATÓRIA (RELAY_KEY ou SM_RELAY_SENHA) via x-senha ou x-relay-key. Sem a senha
 *   configurada o worker recusa tudo (senão viraria um proxy aberto para a internet inteira).
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Encoding',
  'Access-Control-Max-Age': '86400',
};

// Headers que NÃO devem ser repassados para o site de destino (específicos do Cloudflare/Edge)
const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
  'x-senha',
  'x-relay-key',
  'x-redirect'
]);

// Comparação em tempo (quase) constante para a senha.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Plano de dados assinado:  GET /m/<token>                            */
/*                                                                     */
/* O Render (backend) só assina um token HMAC; o vídeo passa AQUI e    */
/* vai direto ao player, sem gastar a banda de saída do Render.        */
/* Formato do token: base64url(JSON{u,h,r,e}) . base64url(HMAC)        */
/* ------------------------------------------------------------------ */

const MEDIA_UA = 'fdsFlix/2.0 (+local player)';
const MEDIA_MAX_HOPS = 4;
const MEDIA_PLAYLIST_MAX = 2 * 1024 * 1024;
// Só estes cabeçalhos do token chegam ao CDN (nunca nada vindo do navegador).
const MEDIA_HEADER_ALLOW = new Set(['user-agent', 'referer', 'origin', 'accept']);
const MEDIA_PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

const textEncoder = new TextEncoder();

function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret, usage) {
  return crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

async function signBody(secret, body) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), textEncoder.encode('m1.' + body));
  return bytesToB64u(new Uint8Array(sig));
}

/** @returns {Promise<{u:string,h:object,r:string,e:number}|{error:string,status:number}>} */
async function readToken(token, secret) {
  const dot = token.indexOf('.');
  if (dot < 1) return { error: 'token malformado', status: 400 };
  const body = token.slice(0, dot);
  let sig;
  try {
    sig = b64uToBytes(token.slice(dot + 1));
  } catch (err) {
    return { error: 'token malformado', status: 400 };
  }
  // crypto.subtle.verify compara em tempo constante.
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sig, textEncoder.encode('m1.' + body));
  if (!ok) return { error: 'assinatura inválida', status: 401 };

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64uToBytes(body)));
  } catch (err) {
    return { error: 'token ilegível', status: 400 };
  }
  if (!payload || typeof payload.u !== 'string' || !(payload.e > 0)) return { error: 'token incompleto', status: 400 };
  if (Date.now() / 1000 > payload.e) return { error: 'token expirado — recarregue o player', status: 410 };
  return payload;
}

/** https público, sem IP literal nem localhost; se houver raiz, o host precisa pertencer a ela. */
function mediaTargetAllowed(rawUrl, root) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (err) {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:') return null;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || !host.includes('.')) return null;
  if (root && !(host === root || host.endsWith('.' + root))) return null;
  return u;
}

function mediaJson(status, error, extra = {}) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS, ...extra }
  });
}

async function rewriteHlsPlaylist(text, upstreamUrl, payload, secret, origin) {
  const wanted = new Map(); // URL absoluta -> token
  const consider = (raw) => {
    let abs;
    try {
      abs = new URL(raw, upstreamUrl).toString();
    } catch (err) {
      return;
    }
    if (payload.r && mediaTargetAllowed(abs, payload.r) && !wanted.has(abs)) wanted.set(abs, null);
  };

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      for (const m of line.matchAll(/URI="([^"]+)"/g)) consider(m[1]);
    } else {
      consider(line.trim());
    }
  }

  await Promise.all(
    Array.from(wanted.keys()).map(async (abs) => {
      const body = bytesToB64u(
        textEncoder.encode(JSON.stringify({ u: abs, h: payload.h || {}, r: payload.r, e: payload.e }))
      );
      wanted.set(abs, `${origin}/m/${body}.${await signBody(secret, body)}`);
    })
  );

  const swap = (raw) => {
    try {
      const abs = new URL(raw, upstreamUrl).toString();
      return wanted.get(abs) || abs; // fora da raiz permitida: o player resolve por conta própria
    } catch (err) {
      return raw;
    }
  };

  return lines
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${swap(uri)}"`);
      return swap(line.trim());
    })
    .join('\n');
}

async function handleMedia(request, requestUrl, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return mediaJson(405, 'método não permitido');

  const secret = String(env.RELAY_KEY || env.SM_RELAY_SENHA || '').trim();
  if (!secret) return mediaJson(503, 'Worker sem RELAY_KEY configurada.');

  const payload = await readToken(decodeURIComponent(requestUrl.pathname.slice(3)), secret);
  if (payload.error) return mediaJson(payload.status, payload.error);

  // Cabeçalhos do CDN: só os do token (User-Agent neutro por padrão, sem Referer/Origin do navegador).
  const upstreamHeaders = new Headers({ 'User-Agent': MEDIA_UA, Accept: '*/*', 'Accept-Encoding': 'identity' });
  for (const [k, v] of Object.entries(payload.h || {})) {
    if (MEDIA_HEADER_ALLOW.has(k.toLowerCase()) && typeof v === 'string') upstreamHeaders.set(k, v);
  }
  const range = request.headers.get('range');
  if (range) upstreamHeaders.set('Range', range);

  // Redirecionamento manual: cada salto passa pelo mesmo filtro de host.
  let target = mediaTargetAllowed(payload.u, '');
  if (!target) return mediaJson(403, 'origem não permitida');
  let upstream;
  try {
    for (let hop = 0; hop <= MEDIA_MAX_HOPS; hop++) {
      upstream = await fetch(target.toString(), { method: request.method, headers: upstreamHeaders, redirect: 'manual' });
      if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location')) {
        const next = mediaTargetAllowed(new URL(upstream.headers.get('location'), target).toString(), payload.r);
        if (upstream.body) upstream.body.cancel().catch(() => {});
        if (!next || hop === MEDIA_MAX_HOPS) return mediaJson(502, 'redirecionamento bloqueado');
        target = next;
        continue;
      }
      break;
    }
  } catch (err) {
    return mediaJson(502, `falha ao conectar no provedor: ${err.message}`);
  }

  if (upstream.status >= 400) {
    if (upstream.body) upstream.body.cancel().catch(() => {});
    return mediaJson(502, `o provedor respondeu HTTP ${upstream.status}`, { 'x-upstream-status': String(upstream.status) });
  }

  const outHeaders = new Headers(CORS_HEADERS);
  for (const name of MEDIA_PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) outHeaders.set(name, value);
  }

  // Playlist HLS: reescreve e assina os filhos aqui mesmo (o Render não participa).
  const looksPlaylist =
    /mpegurl/i.test(upstream.headers.get('content-type') || '') || /\.m3u8$/i.test(target.pathname);
  if (looksPlaylist && request.method === 'GET' && payload.r) {
    const raw = await upstream.text();
    if (raw.length <= MEDIA_PLAYLIST_MAX && /^﻿?\s*#EXTM3U/.test(raw.slice(0, 64))) {
      const rewritten = await rewriteHlsPlaylist(raw, target.toString(), payload, secret, requestUrl.origin);
      outHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
      outHeaders.set('Cache-Control', 'no-store');
      outHeaders.delete('content-length');
      outHeaders.delete('content-range');
      return new Response(rewritten, { status: 200, headers: outHeaders });
    }
    return new Response(raw, { status: upstream.status, headers: outHeaders });
  }

  if (!outHeaders.has('content-type')) outHeaders.set('Content-Type', 'application/octet-stream');
  outHeaders.set('Cache-Control', 'public, max-age=3600');
  // Corpo repassado como stream: nada fica em memória no Worker.
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: outHeaders });
}

export default {
  async fetch(request, env = {}, ctx) {
    const requestUrl = new URL(request.url);

    // 1. Tratamento de CORS Preflight (OPTIONS)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    // 1b. Plano de dados assinado (vídeo direto ao player, sem senha no navegador)
    if (requestUrl.pathname.startsWith('/m/')) {
      return handleMedia(request, requestUrl, env);
    }

    // 2. Extração da URL de destino
    const targetUrl = requestUrl.searchParams.get('u') ||
      requestUrl.searchParams.get('url') ||
      request.headers.get('x-target-url');

    // Se nenhuma URL foi enviada, exibe status de saúde do worker
    if (!targetUrl) {
      return new Response(JSON.stringify({
        ok: true,
        service: 'fdsFlix Video Relay Worker',
        version: '1.0.0',
        usage: '/?u=https://site-destino.com/arquivo.m3u8',
        keyConfigured: Boolean(env.RELAY_KEY || env.SM_RELAY_SENHA)
      }, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...CORS_HEADERS
        }
      });
    }

    // 3. Senha obrigatória. Sem RELAY_KEY configurada, recusa (fail-closed).
    const requiredKey = String(env.RELAY_KEY || env.SM_RELAY_SENHA || '').trim();
    if (!requiredKey) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Worker sem senha configurada. Defina a variável/secret RELAY_KEY no painel da Cloudflare.'
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
      });
    }
    const providedKey = request.headers.get('x-senha') || request.headers.get('x-relay-key') || '';
    if (!safeEqual(providedKey, requiredKey)) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Chave de acesso inválida ou não fornecida no x-senha ou x-relay-key'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
      });
    }

    // 4. Validação da URL de destino
    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
      if (!/^https?:$/.test(parsedTarget.protocol)) {
        throw new Error('Apenas protocolos http e https são permitidos.');
      }
    } catch (err) {
      return new Response(JSON.stringify({
        ok: false,
        error: `URL de destino inválida: ${err.message}`
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...CORS_HEADERS
        }
      });
    }

    // 5. Montagem dos cabeçalhos repassados ao destino
    const forwardHeaders = new Headers();

    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (!HOP_BY_HOP_HEADERS.has(lower) && !lower.startsWith('cf-')) {
        forwardHeaders.set(key, value);
      }
    }

    // Pede o corpo sem compressão ao destino: evita content-encoding divergente do corpo
    // entregue (e o Content-Length repassado ao player bate com os bytes).
    forwardHeaders.set('accept-encoding', 'identity');

    // Suporte para sobreposição explícita de Referer e Origin (exigidos por CDNs de vídeo)
    if (request.headers.has('x-custom-referer')) {
      forwardHeaders.set('referer', request.headers.get('x-custom-referer'));
    }
    if (request.headers.has('x-custom-origin')) {
      forwardHeaders.set('origin', request.headers.get('x-custom-origin'));
    }
    if (request.headers.has('x-custom-user-agent')) {
      forwardHeaders.set('user-agent', request.headers.get('x-custom-user-agent'));
    }

    // 6. Opções de busca no destino
    const isManualRedirect = requestUrl.searchParams.get('redirect') === 'manual' ||
      request.headers.get('x-redirect') === 'manual';

    const fetchOptions = {
      method: request.method,
      headers: forwardHeaders,
      redirect: isManualRedirect ? 'manual' : 'follow'
    };

    // Repassa o corpo em requisições POST/PUT
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      fetchOptions.body = request.body;
    }

    // 7. Execução da chamada a partir da rede Cloudflare
    try {
      const upstreamResponse = await fetch(parsedTarget.toString(), fetchOptions);

      // Clona e limpa os cabeçalhos de resposta
      const responseHeaders = new Headers(upstreamResponse.headers);

      // Injeta cabeçalhos CORS completos
      for (const [k, v] of Object.entries(CORS_HEADERS)) {
        responseHeaders.set(k, v);
      }

      // Se for redirecionamento manual, repassa o header Location
      if (isManualRedirect && upstreamResponse.headers.has('location')) {
        responseHeaders.set('Location', upstreamResponse.headers.get('location'));
      }

      // Devolve o corpo como stream direto (vital para Range / vídeo HLS)
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders
      });
    } catch (err) {
      return new Response(JSON.stringify({
        ok: false,
        error: `Falha ao conectar com o destino: ${err.message}`
      }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...CORS_HEADERS
        }
      });
    }
  }
};
