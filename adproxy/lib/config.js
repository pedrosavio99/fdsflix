'use strict';

const crypto = require('crypto');
const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
  quiet: true
});

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Kit "AdFallback": o gerador do .zip (lib/poolKit.js do fdsFlix) troca ESTA linha no arquivo publicado
// para ligar o proxy de mídia e embutir a chave (zero variável de ambiente no nó). No repositório fica
// desligado, então nada muda para quem já roda o adproxy.
const MEDIA_KIT = { enabled: false, key: '' };

// Valores EMBUTIDOS: o kit "Vercel extra" sobe sem configurar nenhuma variável de ambiente.
// Variável de ambiente (PROXY_SECRET / TARGET_ORIGIN) continua valendo e manda mais que estes.
// O segredo é público de propósito (decisão do dono): ele só assina as URLs de vídeo que a
// Vercel emite; quem o souber consegue assinar URLs e usar a Vercel como proxy. Para trocar,
// defina PROXY_SECRET na Vercel ou mude lib/secret.js e publique de novo. (Fica em arquivo
// próprio, sem dependências, porque o Edge runtime — api/hls.js — precisa do MESMO valor.)
const { BUILTIN_PROXY_SECRET } = require('./secret');
const BUILTIN_TARGET_ORIGIN = 'https://vidlink.pro';

const DEFAULT_PLAYER_HOSTS = [
  // Players / embed services comuns
  'vidlink.pro',
  'vidsrc.xyz',
  'vidsrc.to',
  'vidsrc.me',
  'vidsrc.net',
  'vidsrc.in',
  'vidsrc.pro',
  'vidsrc.cc',
  'vidsrc.rip',
  '2embed.cc',
  '2embed.to',
  'autoembed.co',
  'embed.su',
  'vidfast.pro',
  'vidfast.io',
  'multiembed.mov',
  'streamtape.com',
  'streamtape.to',
  'doodstream.com',
  'd000d.com',
  'filemoon.sx',
  'filemoon.to',
  'filemoon.in',
  'vidhide.com',
  'vidhidepro.com',
  'veev.to',
  'ok.ru',
  'vk.com',
  'youtube.com',
  'youtube-nocookie.com',
  'player.vimeo.com',
  'jwplayer.com',
  'bunny.net',
  'bunnycdn.com',
  'cloudflarestream.com',
  'videodelivery.net',
  'mux.com',
  'wistia.com',
  'loom.com'
];

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'sim'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'nao', 'não'].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseList(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * O alvo é sempre uma origem (esquema + host + porta), sem credenciais.
 * Caminhos e query strings do site são mapeados 1:1 a partir do proxy.
 */
function parseTargetOrigin(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`TARGET_ORIGIN inválido: ${value}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('TARGET_ORIGIN precisa usar http:// ou https://');
  }
  if (url.username || url.password) {
    throw new Error('TARGET_ORIGIN não pode conter usuário/senha');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('TARGET_ORIGIN deve conter apenas esquema, host e porta (sem caminho/query)');
  }

  return {
    origin: url.origin,
    hostname: url.hostname.toLowerCase(),
    protocol: url.protocol,
    secure: url.protocol === 'https:'
  };
}

function loadConfig(env = process.env) {
  const target = parseTargetOrigin(env.TARGET_ORIGIN || BUILTIN_TARGET_ORIGIN);
  const explicitSecret = String(env.PROXY_SECRET || env.SESSION_SECRET || BUILTIN_PROXY_SECRET).trim();
  const secret = explicitSecret || crypto.randomBytes(32).toString('hex');

  return {
    port: parseInteger(env.PORT, 3000, 1, 65535),
    host: String(env.HOST || '0.0.0.0').trim() || '0.0.0.0',
    target,
    targetOrigin: target ? target.origin : null,
    secret,
    secretStable: Boolean(explicitSecret),
    userAgent: String(env.UPSTREAM_USER_AGENT || DEFAULT_USER_AGENT).trim(),
    upstreamTimeoutMs: parseInteger(env.UPSTREAM_TIMEOUT_MS, 30000, 3000, 120000),
    maxHtmlBytes: parseInteger(env.MAX_HTML_BYTES, 8 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024),
    maxCssBytes: parseInteger(env.MAX_CSS_BYTES, 4 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024),
    maxBodyBytes: parseInteger(env.MAX_REQUEST_BODY_BYTES, 2 * 1024 * 1024, 0, 16 * 1024 * 1024),
    allowCrossOrigin: parseBoolean(env.ALLOW_CROSS_ORIGIN, true),
    allowPrivateUpstreams: parseBoolean(env.ALLOW_PRIVATE_UPSTREAMS, false),
    forwardCookies: parseBoolean(env.FORWARD_COOKIES, true),
    proxyPlayerIframes: parseBoolean(env.PROXY_PLAYER_IFRAMES, false),
    hardenPlayerIframes: parseBoolean(env.HARDEN_PLAYER_IFRAMES, false),
    rewriteExternalLinks: parseBoolean(env.REWRITE_EXTERNAL_LINKS, false),
    // Proxy de MÍDIA genérico (só para o nó de FALLBACK dos filmes). Desligado por padrão: os
    // nós atuais respondem 404 nessas rotas e nada muda. Ver lib/mediaProxy.js.
    mediaProxy: parseBoolean(env.MEDIA_PROXY, MEDIA_KIT.enabled),
    mediaProxyKey: String(env.MEDIA_PROXY_KEY || MEDIA_KIT.key).trim(),
    mediaProxyTtlSec: parseInteger(env.MEDIA_PROXY_TTL_SEC, 6 * 60 * 60, 300, 24 * 60 * 60),
    blockPopups: parseBoolean(env.BLOCK_POPUPS, true),
    injectStubs: parseBoolean(env.INJECT_ADBLOCK_STUBS, true),
    injectHidingCss: parseBoolean(env.INJECT_HIDING_CSS, true),
    debug: parseBoolean(env.DEBUG, false),
    trustProxy: parseBoolean(env.TRUST_PROXY, true),
    playerHosts: [...DEFAULT_PLAYER_HOSTS, ...parseList(env.EXTRA_PLAYER_HOSTS)],
    popupAllowHosts: parseList(env.POPUP_ALLOW_HOSTS),
    controlPrefix: '/_adshield',
    version: '1.0.0'
  };
}

module.exports = {
  BUILTIN_PROXY_SECRET,
  BUILTIN_TARGET_ORIGIN,
  DEFAULT_USER_AGENT,
  DEFAULT_PLAYER_HOSTS,
  loadConfig,
  parseTargetOrigin,
  parseBoolean,
  parseInteger,
  parseList
};
