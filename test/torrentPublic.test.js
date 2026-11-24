'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tp = require('../lib/torrentPublic');

const H = (n) => String(n).padStart(40, 'a').toUpperCase();
const mk = (n, extra = {}) => Object.assign({
  title: 'Filme ' + n, hash: H(n), magnet: `magnet:?xt=urn:btih:${H(n)}`, seeds: 20, score: 80,
  quality: '720p', audio: 'orig', size: 900 * 1024 ** 2, source: 'The Pirate Bay'
}, extra);

test.beforeEach(() => tp._reset());

test('pickCandidates: descarta arquivo grande demais, sem hash e sem seeds', () => {
  const out = tp.pickCandidates([
    mk(1, { size: 9 * 1024 ** 3 }),
    mk(2, { hash: '', magnet: '' }),
    mk(3, { seeds: 0 }),
    mk(4)
  ]);
  assert.deepEqual(out.map((c) => c.hash), [H(4)]);
});

test('pickCandidates: a resposta pública só leva hash/magnet/qualidade/dublado (sem fonte nem título de release)', () => {
  const [c] = tp.pickCandidates([mk(1, { audio: 'dub', title: 'Filme.2020.YIFY.1080p', source: 'Rede Torrent' })]);
  assert.deepEqual(Object.keys(c).sort(), ['dub', 'hash', 'magnet', 'q', 'seeds', 'size']);
  assert.equal(c.dub, true);
  assert.ok(!JSON.stringify(c).toLowerCase().includes('yify'));
  assert.ok(!JSON.stringify(c).toLowerCase().includes('rede torrent'));
});

test('mp4 (YTS) ganha de mkv com nota parecida; 2160p perde', () => {
  const out = tp.pickCandidates([
    mk(1, { score: 80, title: 'Filme x264 mkv' }),
    mk(2, { score: 78, source: 'YTS' }),
    mk(3, { score: 90, quality: '2160p' })
  ]);
  assert.equal(out[0].hash, H(2));
  assert.equal(out[out.length - 1].hash, H(3));
});

test('aprender: velocidade medida vale mais que seeds ("o 2º às vezes é mais rápido")', () => {
  const a = mk(1, { seeds: 500, score: 90 });
  const b = mk(2, { seeds: 8, score: 70 });
  assert.equal(tp.pickCandidates([a, b])[0].hash, H(1));
  tp.issue(tp.pickCandidates([a, b]));
  assert.ok(tp.learn(H(1), { ok: false }));
  assert.ok(tp.learn(H(1), { ok: false }));
  assert.ok(tp.learn(H(2), { kBs: 1800 }));
  assert.equal(tp.pickCandidates([a, b])[0].hash, H(2));
});

test('learn só aceita hash que nós entregamos e valor crível', () => {
  assert.equal(tp.learn(H(7), { kBs: 500 }), false);            // nunca entregue
  tp.issue([{ hash: H(7), magnet: 'm' }]);
  assert.equal(tp.learn('xyz', { kBs: 500 }), false);            // hash inválido
  assert.equal(tp.learn(H(7), { kBs: 999999999 }), true);
  assert.ok(tp.learnedOf(H(7)).kBs <= 50000, 'teto de 50 MB/s');
});

test('allowIp: limite por IP em 10 min e libera depois', () => {
  const t0 = 1_000_000;
  for (let i = 0; i < tp.PER_IP; i++) assert.equal(tp.allowIp('1.2.3.4', t0 + i), true);
  assert.equal(tp.allowIp('1.2.3.4', t0 + 100), false);
  assert.equal(tp.allowIp('9.9.9.9', t0 + 100), true);
  assert.equal(tp.allowIp('1.2.3.4', t0 + 11 * 60 * 1000), true);
});

test('find: cache de 30 min e pedidos iguais em voo viram uma busca só', async () => {
  let calls = 0;
  tp._setSearch(async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return { results: [mk(1), mk(2)] }; });
  const [x, y] = await Promise.all([tp.find(603, { title: 'Matrix' }), tp.find(603, { title: 'Matrix' })]);
  assert.equal(calls, 1);
  assert.equal(x.candidates.length, 2);
  assert.deepEqual(x, y);
  await tp.find(603, { title: 'Matrix' });
  assert.equal(calls, 1, 'cache');
  tp._setSearch(null);
});

test('find: erro da busca não derruba (vira lista vazia, cache curto)', async () => {
  tp._setSearch(async () => { throw new Error('offline'); });
  const out = await tp.find(1, { title: 'x' });
  assert.deepEqual(out.candidates, []);
  tp._setSearch(null);
});

test('isCached: título já buscado não conta no limite por IP', async () => {
  tp._setSearch(async () => ({ results: [mk(1)], sources: [{ name: 'YTS', ok: true, count: 1 }] }));
  assert.equal(tp.isCached(77), false);
  const out = await tp.find(77, { title: 'x' });
  assert.equal(tp.isCached(77), true);
  assert.match(out.debug.sources, /YTS:1/);
  tp._setSearch(null);
});

test('find: falha passageira da busca tenta de novo e acha', async () => {
  let n = 0;
  tp._setSearch(async () => { n += 1; return n === 1 ? { results: [], sources: [{ name: 'YTS', ok: false, error: 'HTTP 429' }] } : { results: [mk(1)], sources: [] }; });
  const out = await tp.find(88, { title: 'y' });
  assert.equal(out.candidates.length, 1);
  assert.equal(n, 2);
  tp._setSearch(null);
});

test('TORRENT_PUBLIC=0 desliga', () => {
  const old = process.env.TORRENT_PUBLIC;
  process.env.TORRENT_PUBLIC = '0';
  assert.equal(tp.enabled(), false);
  delete process.env.TORRENT_PUBLIC;
  assert.equal(tp.enabled(), true);
  if (old !== undefined) process.env.TORRENT_PUBLIC = old;
});

test('find: busca com título, original e inglês (como o admin) e junta por hash', async () => {
  const seen = [];
  tp._setSearch(async (q) => { seen.push(q.title); return { results: [mk(q.title === 'I\'m Still Here' ? 2 : 1)] }; });
  const out = await tp.find(1000837, { title: 'Ainda Estou Aqui', alt: 'Ainda Estou Aqui', alt2: 'I\'m Still Here', year: '2024' });
  assert.deepEqual(seen.sort(), ['Ainda Estou Aqui', 'I\'m Still Here'].sort());
  assert.equal(out.candidates.length, 2);
  tp._setSearch(null);
});
