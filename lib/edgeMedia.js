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

/** Liga se há Worker + chave, e EDGE_MEDIA não foi desligado (EDGE_MEDIA=0). */
function edgeEnabled() {
  const cfg = getRelayConfig();
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
  const cfg = getRelayConfig();
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
  const cfg = getRelayConfig();
  return `${cfg.url}/m/${signEdgeToken(options)}`;
}

module.exports = { edgeEnabled, canUseEdge, rootDomain, signEdgeToken, edgeUrl, DEFAULT_TTL_SEC };
