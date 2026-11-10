'use strict';

/**
 * Plano de dados na borda (Cloudflare Worker): o Render só ASSINA, o Worker ENTREGA.
 *
 * Problema: o Render Free mede a banda de saída (5 GB/mês). Quando o vídeo passa por
 * /api/proxy ou /api/hls-proxy, cada byte assistido sai pelo Render.
 *
 * Aqui o /api/stream devolve ao player uma URL do Worker (`<worker>/m/<token>`). O
 * token é um HMAC-SHA256 que diz "pode buscar ESTA URL, com ESTES cabeçalhos, até
 * ESTA hora". O Worker valida a assinatura, busca no CDN (User-Agent neutro, sem
 * Referer — o que o navegador não consegue fazer) e entrega o corpo direto ao player.
 * O Render responde só um JSON de ~1 KB por filme.
 *
 * O token NÃO é a senha do Worker: o navegador nunca vê a chave, só tokens que
 * valem para uma URL e expiram.
 *
 * Formato:  base64url(JSON {u, h, r, e}) + "." + base64url(HMAC(chave, "m1." + parte1))
 *   u = URL de origem          h = cabeçalhos extras (allowlist no Worker)
 *   r = domínio-raiz permitido para filhos de playlist HLS (vazio = não reescreve)
 *   e = expiração (epoch em segundos)
 */

const crypto = require('crypto');
const { getRelayConfig, isLocalOrInternal } = require('./relayFetch');

const DEFAULT_TTL_SEC = 6 * 60 * 60;

/**
 * Quem entrega o vídeo: MEDIA_RELAY_URL/MEDIA_RELAY_KEY (ex.: o relay Node numa VM com muita banda,
 * deploy/media-relay) ou, se não houver, o mesmo Worker do VIDEO_RELAY_URL. Separar os dois deixa o
 * Worker cuidando só das consultas aos provedores.
 */
function mediaConfig() {
  const url = String(process.env.MEDIA_RELAY_URL || '').trim().replace(/\/+$/, '');
  if (url) return { enabled: true, url, key: String(process.env.MEDIA_RELAY_KEY || '').trim() };
  return getRelayConfig();
}

/** Liga se há relay + chave, e EDGE_MEDIA não foi desligado (EDGE_MEDIA=0). */
function edgeEnabled() {
  const cfg = mediaConfig();
  return cfg.enabled && Boolean(cfg.key) && String(process.env.EDGE_MEDIA || '1') !== '0';
}

/** O Worker só alcança URLs públicas em https (nada de localhost, IP literal ou rede interna). */
function canUseEdge(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (isLocalOrInternal(url)) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.includes(':')) return false;
    return true;
  } catch (err) {
    return false;
  }
}

/** "a.b.cdn.exemplo.com" -> "exemplo.com" (aproximação suficiente para filtrar filhos de playlist). */
function rootDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase().split('.').slice(-2).join('.');
  } catch (err) {
    return '';
  }
}

function signEdgeToken({ url, headers, root, ttlSec = DEFAULT_TTL_SEC }) {
  const cfg = mediaConfig();
  const body = Buffer.from(
    JSON.stringify({
      u: String(url),
      h: headers && typeof headers === 'object' ? headers : {},
      r: root || '',
      e: Math.floor(Date.now() / 1000) + ttlSec
    })
  ).toString('base64url');
  const mac = crypto.createHmac('sha256', cfg.key).update('m1.' + body).digest('base64url');
  return `${body}.${mac}`;
}

/** URL pronta para o <video>/hls.js: <worker>/m/<token>. */
function edgeUrl(options) {
  const cfg = mediaConfig();
  return `${cfg.url}/m/${signEdgeToken(options)}`;
}

/* ------------------------------------------------------------------ */
/* Sonda: o Worker CONSEGUE chegar nesse provedor?                     */
/*                                                                     */
/* Alguns CDNs de vídeo recusam a rede da Cloudflare (o Worker recebe  */
/* 4xx e devolve 502 ao player). Em vez de descobrir isso no meio do   */
/* play, o servidor pede 1 byte pelo Worker e só usa a borda se der    */
/* certo. Resultado guardado por host (poucos minutos): custa ~1 KB.   */
/* Se não der, o vídeo sai pelo /api/proxy do Render, como sempre foi. */
/* ------------------------------------------------------------------ */

const PROBE_OK_TTL_MS = 10 * 60 * 1000;
const PROBE_FAIL_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;
const probeCache = new Map(); // host -> { ok, status, reason, until, pending }

async function probeOnce(options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(edgeUrl({ ...options, ttlSec: 120 }), {
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal
    });
    const upstream = res.headers.get('x-upstream-status');
    if (res.body) res.body.cancel().catch(() => {});
    if (res.status === 200 || res.status === 206) return { ok: true, status: res.status };
    return { ok: false, status: res.status, reason: upstream ? `provedor HTTP ${upstream}` : `Worker HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, reason: err.name === 'AbortError' ? 'tempo esgotado' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{url: string, headers?: object, root?: string}} options  mesmos parâmetros do edgeUrl
 * @returns {Promise<{ok: boolean, status: number, reason?: string, cached: boolean}>}
 */
async function edgeReachable(options) {
  let host;
  try { host = new URL(options.url).hostname.toLowerCase(); } catch (err) { return { ok: false, status: 0, reason: 'URL inválida', cached: false }; }
  const hit = probeCache.get(host);
  if (hit && hit.pending) return { ...(await hit.pending), cached: true };
  if (hit && hit.until > Date.now()) return { ok: hit.ok, status: hit.status, reason: hit.reason, cached: true };

  const entry = { pending: null };
  entry.pending = probeOnce(options).then((r) => {
    probeCache.set(host, { ok: r.ok, status: r.status, reason: r.reason, until: Date.now() + (r.ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS) });
    return r;
  });
  probeCache.set(host, entry);
  return { ...(await entry.pending), cached: false };
}

module.exports = { edgeEnabled, canUseEdge, edgeReachable, rootDomain, signEdgeToken, edgeUrl, DEFAULT_TTL_SEC };
