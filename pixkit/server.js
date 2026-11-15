'use strict';

/**
 * fdsFlix · nó do Pix (Wasmer / VPS / Docker). Sem dependências, só HTTP.
 *
 * Guarda na MEMÓRIA os avisos de "Pix recebido" que o Apps Script do Gmail empurra (a cada minuto, a janela das
 * últimas 3 h inteira: se este nó reiniciar, o próximo envio repõe tudo). O fdsFlix (Render) consulta aqui.
 *
 *   GET  /health                 aberto, só contadores
 *   POST /pix/mail               { messages:[{headers, subject, text}] }   (x-pix-secret)
 *   GET  /pix/events?since=<ms>  eventos aceitos + últimos recusados com o motivo (x-pix-secret)
 */

const http = require('http');
const crypto = require('crypto');
const config = require('./lib/config');
const { verifyNubankPix } = require('./lib/mail');

const TTL_MS = 6 * 3600 * 1000;
const MAX_EVENTS = 300;
const MAX_REJECTED = 20;
const MAX_BODY = 512 * 1024;

function createStore(now = () => Date.now()) {
  const events = new Map(); // Message-ID -> { id, amountCents, at, seenAt }
  const rejected = [];
  const state = { lastPushAt: 0, pushes: 0 };

  function prune() {
    const limit = now() - TTL_MS;
    for (const [id, e] of events) if (e.seenAt < limit) events.delete(id);
    while (events.size > MAX_EVENTS) events.delete(events.keys().next().value);
  }

  function ingest(messages) {
    let accepted = 0; let duplicates = 0; let refused = 0;
    state.lastPushAt = now();
    state.pushes += 1;
    for (const msg of (Array.isArray(messages) ? messages : []).slice(0, 50)) {
      const r = verifyNubankPix(msg, now());
      if (!r.ok) {
        refused += 1;
        const key = r.id || '';
        if (!rejected.some((x) => x.id === key && x.reason === r.reason)) {
          rejected.unshift({ at: now(), id: key, reason: r.reason, subject: String((msg && msg.subject) || '').slice(0, 80) });
          if (rejected.length > MAX_REJECTED) rejected.pop();
        }
        continue;
      }
      if (events.has(r.id)) { duplicates += 1; continue; }
      events.set(r.id, { id: r.id, amountCents: r.amountCents, at: r.at, seenAt: now() });
      accepted += 1;
    }
    prune();
    return { accepted, duplicates, refused };
  }

  function list(since = 0) {
    prune();
    return [...events.values()].filter((e) => e.at >= since).sort((a, b) => a.at - b.at);
  }

  return { ingest, list, rejected: () => rejected.slice(), size: () => events.size, state };
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function createServer({ secret = config.secret, store = createStore() } = {}) {
  if (!secret) throw new Error('Sem chave: use o kit baixado do fdsFlix (ou defina PIX_SECRET).');

  return http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://x');
    const authed = () => safeEqual(req.headers['x-pix-secret'] || '', secret);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(200, { ok: true, service: 'fdsflix-pix', events: store.size(), lastPushAt: store.state.lastPushAt, pushes: store.state.pushes });
    }
    if (req.method === 'GET' && url.pathname === '/pix/events') {
      if (!authed()) return send(401, { error: 'chave inválida' });
      const since = Number(url.searchParams.get('since')) || 0;
      return send(200, { ok: true, now: Date.now(), lastPushAt: store.state.lastPushAt, events: store.list(since), rejected: store.rejected() });
    }
    if (req.method === 'POST' && url.pathname === '/pix/mail') {
      if (!authed()) return send(401, { error: 'chave inválida' });
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { send(413, { error: 'corpo grande demais' }); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (err) { return send(400, { error: 'JSON inválido' }); }
        send(200, { ok: true, ...store.ingest(body && body.messages) });
      });
      return undefined;
    }
    return send(404, { error: 'não encontrado' });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(config.port, config.host, () => console.log(`fdsflix-pix na porta ${config.port}`));
}

module.exports = { createServer, createStore };
