'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createStreamGuard } = require('../lib/streamGuard');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sobe um app com o guard na frente de um handler lento que conta quantas vezes (e quantas ao mesmo tempo) rodou. */
async function setup(guardOptions, handler) {
  const guard = createStreamGuard({ isAdmin: (req) => req.get('x-admin') === '1', ...guardOptions });
  const state = { runs: 0, concurrent: 0, peak: 0 };
  const app = express();
  app.get('/api/stream', guard.middleware, async (req, res) => {
    state.runs += 1;
    state.concurrent += 1;
    state.peak = Math.max(state.peak, state.concurrent);
    try { await handler(req, res, state); } finally { state.concurrent -= 1; }
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: false });
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers, agent }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
  return { guard, state, get, close: () => new Promise((r) => { agent.destroy(); server.close(r); server.closeAllConnections && server.closeAllConnections(); }) };
}

const okHandler = (ms) => async (req, res) => { await sleep(ms); res.json({ ok: true, id: req.query.id, n: Math.random() }); };

test('pedidos idênticos ao mesmo tempo: a busca roda UMA vez e todos recebem a mesma resposta', async () => {
  const t = await setup({}, okHandler(150));
  const out = await Promise.all(Array.from({ length: 30 }, () => t.get('/api/stream?id=603&type=movie')));
  assert.equal(t.state.runs, 1);
  assert.ok(out.every((o) => o.status === 200));
  assert.equal(new Set(out.map((o) => o.body)).size, 1, 'todos com o mesmo corpo');
  assert.equal(t.guard.stats().coalesced, 29);
  await t.close();
});

test('nada fica guardado: o pedido seguinte (ex.: Recarregar) faz uma busca nova', async () => {
  const t = await setup({}, okHandler(20));
  const a = await t.get('/api/stream?id=1&type=movie');
  const b = await t.get('/api/stream?id=1&type=movie');
  assert.equal(t.state.runs, 2);
  assert.notEqual(a.body, b.body);
  assert.equal(t.guard.stats().inFlight, 0);
  await t.close();
});

test('títulos ou parâmetros diferentes nunca se misturam', async () => {
  const t = await setup({ maxActive: 50 }, okHandler(60));
  const out = await Promise.all([
    t.get('/api/stream?id=1&type=movie'), t.get('/api/stream?id=2&type=movie'),
    t.get('/api/stream?id=1&type=movie&hevc=1'), t.get('/api/stream?id=1&type=tv&s=1&e=2')
  ]);
  assert.equal(t.state.runs, 4);
  assert.deepEqual(out.map((o) => JSON.parse(o.body).id), ['1', '2', '1', '1']);
  await t.close();
});

test('administrador nunca é juntado: cada pedido dele roda sozinho (para ter o diagnóstico próprio)', async () => {
  const t = await setup({}, okHandler(80));
  await Promise.all(Array.from({ length: 5 }, () => t.get('/api/stream?id=9&type=movie', { 'x-admin': '1' })));
  assert.equal(t.state.runs, 5);
  await t.close();
});

test('erro 503 do líder é repassado igual aos que esperavam (mesmo status e corpo)', async () => {
  const t = await setup({}, async (req, res) => { await sleep(80); res.status(503).json({ error: 'fora', retryable: true }); });
  const out = await Promise.all(Array.from({ length: 6 }, () => t.get('/api/stream?id=7&type=movie')));
  assert.equal(t.state.runs, 1);
  assert.ok(out.every((o) => o.status === 503 && JSON.parse(o.body).retryable === true));
  await t.close();
});

test('se o líder não entrega JSON, quem esperava faz a própria busca (ninguém fica pendurado)', async () => {
  let first = true;
  const t = await setup({}, async (req, res) => {
    await sleep(60);
    if (first) { first = false; res.status(204).end(); return; }
    res.json({ ok: true });
  });
  const out = await Promise.all([t.get('/api/stream?id=5&type=movie'), t.get('/api/stream?id=5&type=movie'), t.get('/api/stream?id=5&type=movie')]);
  assert.equal(out.filter((o) => o.status === 200).length >= 1, true);
  assert.ok(out.every((o) => o.status === 200 || o.status === 204));
  assert.ok(t.state.runs >= 2);
  await t.close();
});

test('limita buscas simultâneas ao máximo configurado e atende todo mundo', async () => {
  const t = await setup({ maxActive: 4 }, okHandler(80));
  const out = await Promise.all(Array.from({ length: 20 }, (_, i) => t.get(`/api/stream?id=${i}&type=movie`)));
  try {
    assert.equal(t.state.runs, 20);
    // pico medido pelo próprio guard (a vaga volta no instante em que a resposta sai, antes do handler terminar de desmontar)
    assert.ok(t.guard.stats().peakActive <= 4, `pico ${t.guard.stats().peakActive}`);
    assert.ok(t.state.peak <= 5, `pico no handler ${t.state.peak}`);
    assert.ok(out.every((o) => o.status === 200));
    assert.ok(t.guard.stats().queued > 0);
  } finally {
    await t.close();
  }
});

test('fila nunca recusa: passado o tempo de espera o pedido roda mesmo assim', async () => {
  const t = await setup({ maxActive: 1, queueWaitMs: 60 }, okHandler(400));
  const started = Date.now();
  const [a, b] = await Promise.all([t.get('/api/stream?id=1&type=movie'), t.get('/api/stream?id=2&type=movie')]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.ok(Date.now() - started < 700, 'o segundo não esperou o primeiro terminar (400 ms)');
  assert.equal(t.state.peak, 2);
  assert.equal(t.guard.stats().queueTimeouts, 1);
  await t.close();
});

test('as vagas são devolvidas mesmo quando o handler falha (nada trava para sempre)', async () => {
  const t = await setup({ maxActive: 1 }, async (req, res) => { await sleep(20); res.status(502).json({ error: 'x' }); });
  for (let i = 0; i < 5; i += 1) await t.get(`/api/stream?id=${i}&type=movie`);
  const s = t.guard.stats();
  assert.equal(s.active, 0);
  assert.equal(s.waiting, 0);
  assert.equal(s.inFlight, 0);
  await t.close();
});
