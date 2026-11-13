'use strict';

const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.GEO_API_URL = 'off';

const watch = require('../lib/watchStats');
const { CHANNELS } = require('../lib/liveChannels');

const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const MIN = 60000;
const T0 = Date.now();

const req = (ip, path, query = {}, ua = UA) => ({ method: 'GET', path, query, headers: { 'user-agent': ua, 'cf-connecting-ip': ip } });

beforeEach(() => watch.reset());

test('filme, série e canal de TV entram nas listas certas, sem IP', async () => {
  const ch = CHANNELS[0];
  watch.record(req('177.1.1.1', '/api/stream', { type: 'movie', id: '872585', title: 'Oppenheimer' }), T0);
  watch.record(req('177.1.1.2', '/api/stream', { type: 'movie', id: '872585', title: 'Oppenheimer' }), T0 + 1000);
  watch.record(req('177.1.1.1', '/api/stream', { type: 'tv', id: '1399', title: 'Game of Thrones', s: '1', e: '3' }), T0 + 2000);
  watch.record(req('177.1.1.1', '/api/live/stream', { ch: ch.id }), T0 + 3000);
  const r = await watch.top({ days: 7 });
  assert.equal(r.top.movie[0].title, 'Oppenheimer');
  assert.equal(r.top.movie[0].watches, 2);
  assert.equal(r.top.movie[0].viewers, 2);
  assert.equal(r.top.series[0].title, 'Game of Thrones'); // a série, não o episódio
  assert.equal(r.top.live[0].title, ch.name);
  assert.equal(JSON.stringify(r).includes('177.1.1'), false);
});

test('recarregar ou trocar de fonte não infla; depois de 30 min conta de novo, mas é o mesmo aparelho', async () => {
  const ch = CHANNELS[0];
  const a = req('177.2.2.2', '/api/stream', { type: 'movie', id: '603', title: 'Matrix' });
  watch.record(a, T0);
  watch.record(a, T0 + 5 * MIN);
  watch.record(req('177.2.2.2', '/api/live/stream', { ch: ch.id, skip: 'abc' }), T0 + 6 * MIN); // troca de fonte: ignora
  watch.record(a, T0 + 40 * MIN);
  const r = await watch.top({ days: 7 });
  assert.equal(r.top.movie[0].watches, 2);
  assert.equal(r.top.movie[0].viewers, 1);
  assert.equal(r.top.live.length, 0);
});

test('bot, IP interno e requisição sem título nem id não contam', async () => {
  watch.record(req('177.3.3.3', '/api/stream', { type: 'movie', id: '1', title: 'X' }, 'Googlebot/2.1 (+http://www.google.com/bot.html)'), T0);
  watch.record(req('127.0.0.1', '/api/stream', { type: 'movie', id: '1', title: 'X' }), T0);
  watch.record(req('177.3.3.3', '/api/stream', { type: 'movie' }), T0);
  watch.record(req('177.3.3.3', '/api/live/stream', { ch: 'canal-que-nao-existe' }), T0);
  const r = await watch.top({ days: 7 });
  assert.deepEqual(r.totals, { movie: 0, series: 0, live: 0 });
});

test('ordena pelo mais assistido e respeita o limite', async () => {
  for (let i = 0; i < 3; i += 1) {
    watch.record(req(`177.4.4.${i}`, '/api/stream', { type: 'movie', id: '10', title: 'Popular' }), T0 + i);
  }
  watch.record(req('177.4.4.9', '/api/stream', { type: 'movie', id: '11', title: 'Raro' }), T0);
  const r = await watch.top({ days: 7, limit: 1 });
  assert.equal(r.top.movie.length, 1);
  assert.equal(r.top.movie[0].title, 'Popular');
});

test('envia ao Supabase em lote e, se falhar, não perde nada (soma de volta e reenvia)', async () => {
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_teste';
  const original = global.fetch;
  const calls = [];
  let fail = true;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return fail ? new Response('{"code":"PGRST202"}', { status: 404 }) : new Response('', { status: 200 });
  };
  try {
    watch.record(req('177.5.5.5', '/api/stream', { type: 'movie', id: '603', title: 'Matrix' }), T0);
    const bad = await watch.flush();
    assert.equal(bad.ok, false);
    fail = false;
    const good = await watch.flush();
    assert.equal(good.ok, true);
    assert.equal(good.sent, 1);
    const last = calls.filter((c) => /\/rpc\/fdsflix_add_watches$/.test(c.url)).pop();
    assert.ok(last, 'chamou a função em lote');
    assert.equal(last.body.p_rows[0].key, 'm:603');
    assert.equal(last.body.p_rows[0].watches, 1);
    assert.equal(JSON.stringify(last.body).includes('177.5.5.5'), false);
  } finally {
    global.fetch = original;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
  }
});
