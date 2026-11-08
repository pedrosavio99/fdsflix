'use strict';

/**
 * fdsFlix - Cliente Repassador (Relay Fetch)
 *
 * Inspirado no padrão SM_RELAY do módulo-playlist:
 * Quando o fdsFlix roda em datacenters (Render, Vercel, Railway, VPS), sites e CDNs
 * externos com proteção Cloudflare (ex.: AnimeFire, provedores de streaming) barram
 * requisições com HTTP 403 / 429 ("bloqueio de datacenter").
 *
 * O Cloudflare Worker repassador faz a requisição a partir da rede da Cloudflare (IPs que
 * muitos sites não tratam como "datacenter"), repassando o conteúdo (JSON, playlists HLS,
 * segmentos .ts/.m4s). Não é garantia de desbloqueio: alguns sites ainda barram.
 *
 * Segurança e Isolamento:
 * - Se VIDEO_RELAY_URL (ou SM_RELAY) não estiver definido: usa fetch() nativo direto.
 *   Zero alterações de comportamento; NADA QUEBRA no ambiente atual.
 * - Endereços locais (localhost, 127.0.0.1, rede interna) NUNCA passam pelo relay
 *   (garante que CinePro embutido na porta 3001, CineWinx em 3002, etc. continuem 100% locais).
 */

function getRelayConfig() {
  const url = String(
    process.env.VIDEO_RELAY_URL ||
    process.env.RELAY_URL ||
    process.env.SM_RELAY ||
    ''
  ).trim().replace(/\/+$/, '');

  const key = String(
    process.env.VIDEO_RELAY_KEY ||
    process.env.RELAY_KEY ||
    process.env.SM_RELAY_SENHA ||
    ''
  ).trim();

  return {
    enabled: Boolean(url),
    url,
    key
  };
}

/**
 * Verifica se a URL aponta para localhost ou IP de rede privada local.
 * Um Cloudflare Worker na internet pública não alcança localhost/rede interna.
 */
function isLocalOrInternal(urlString) {
  try {
    const parsed = new URL(urlString);
    // IPv6 vem entre colchetes em URL.hostname ("[::1]").
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '::') return true;
    if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return true;

    // Nome sem ponto (ex.: "cinepro" no Docker/compose) só existe na rede interna.
    if (!host.includes('.') && !host.includes(':')) return true;

    // IPv6 local/privado: fc00::/7 (fc.., fd..) e link-local fe80::/10
    if (host.includes(':') && /^(f[cd]|fe[89ab])/.test(host)) return true;

    // IPv4: loopback, privadas e link-local (inclui metadados de nuvem 169.254.x.x)
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    const m = host.match(/^172\.(\d+)\./);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Converte headers de qualquer formato comum (Objeto, Headers, Array) em objeto chave-valor.
 */
function normalizeHeaders(rawHeaders) {
  const out = {};
  if (!rawHeaders) return out;

  if (typeof rawHeaders.forEach === 'function') {
    rawHeaders.forEach((val, key) => {
      out[key] = val;
    });
    return out;
  }

  if (Array.isArray(rawHeaders)) {
    for (const [k, v] of rawHeaders) {
      if (k) out[k] = v;
    }
    return out;
  }

  return { ...rawHeaders };
}

/**
 * Faz fetch passando pelo Cloudflare Worker se configurado, ou direto caso contrário.
 *
 * @param {string} url - URL de destino
 * @param {RequestInit} [options] - Opções padrão do fetch (headers, method, signal, redirect, etc.)
 * @param {{ forceDirect?: boolean }} [relayOptions]
 * @returns {Promise<Response>}
 */
async function relayFetch(url, options = {}, relayOptions = {}) {
  const cfg = getRelayConfig();

  // Sem relay configurado, ou URL local/interna, ou bypass explícito: vai direto!
  if (!cfg.enabled || relayOptions.forceDirect || isLocalOrInternal(url)) {
    return fetch(url, options);
  }

  const relayEndpoint = new URL(cfg.url);
  relayEndpoint.searchParams.set('u', String(url));

  // Informa ao worker se deve operar em redirect manual (necessário para validação de hops)
  if (options && options.redirect === 'manual') {
    relayEndpoint.searchParams.set('redirect', 'manual');
  }

  const headers = normalizeHeaders(options.headers);

  // Senha do relay para proteção contra uso indevido por terceiros
  if (cfg.key) {
    headers['x-senha'] = cfg.key;
    headers['x-relay-key'] = cfg.key;
  }

  return fetch(relayEndpoint.toString(), {
    ...options,
    headers
  });
}

module.exports = {
  relayFetch,
  isLocalOrInternal,
  getRelayConfig
};
