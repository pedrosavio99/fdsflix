'use strict';

/**
 * Registro em memória de tokens opacos.
 *
 * O navegador nunca recebe a URL assinada do CDN: ele recebe /api/proxy?t=TOKEN.
 * Isso evita que o CDN bloqueie a requisição (ele responde 429 quando vê
 * Referer/Origin de outra origem) e permite renovar a assinatura que expira.
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
const store = new Map();

function register(kind, payload, ttlMs = DEFAULT_TTL_MS) {
  const token = crypto.randomBytes(18).toString('base64url');
  store.set(token, {
    kind,
    payload,
    expiresAt: Date.now() + ttlMs
  });
  return token;
}

function resolve(kind, token) {
  if (!token || typeof token !== 'string') return null;
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.kind !== kind) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(token);
    return null;
  }
  return entry.payload;
}

function cleanup() {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (entry.expiresAt < now) store.delete(token);
  }
}

setInterval(cleanup, 10 * 60 * 1000).unref();

module.exports = {
  register,
  resolve
};
