'use strict';

// "Dublado ou original?": classificação e regras de parada, com fontes falsas (sem rede).

const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');

const streamOptions = require('../lib/streamOptions');

beforeEach(() => streamOptions._cache.clear());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const src = (name, ms, info) => ({ name, fn: async () => { await wait(ms); return info ? { url: `https://x/${name}.mp4`, ...info } : null; } });

test('classifica pelo que a fonte informa', async () => {
  assert.equal(await streamOptions.classify({ url: 'https://x/a.m3u8', isHls: true }), 'orig');
  assert.equal(await streamOptions.classify({ url: 'https://x/a.m3u8', audioLang: 'por' }), 'dub');
  assert.equal(await streamOptions.classify({ url: 'https://x/a.m3u8', dubbed: true }), 'dub');
  assert.equal(await streamOptions.classify({ url: 'https://x/a.m3u8', provider: 'Dublado PT' }), 'dub');
  assert.equal(await streamOptions.classify(null), 'orig');
});

test('achou dublado e original: devolve os dois e para na hora', async () => {
  const t0 = Date.now();
  const out = await streamOptions.discover({
    id: '1', type: 'movie', season: 1, episode: 1, title: 't',
    providers: [
      src('VidLink Pro', 20, { isHls: true, quality: '720' }),
      src('Internet Archive', 60, { audioLang: 'por', quality: '480p' }),
      src('Vidsrc', 5000, null) // lenta: não pode atrasar
    ]
  });
  assert.ok(out.dub && out.orig);
  assert.equal(out.dub.provider, 'Internet Archive');
  assert.equal(out.orig.provider, 'VidLink Pro');
  assert.ok(Date.now() - t0 < 2000);
});

test('só original e as fontes de dublagem já terminaram: não espera à toa', async () => {
  const t0 = Date.now();
  const out = await streamOptions.discover({
    id: '2', type: 'movie', season: 1, episode: 1, title: 't',
    providers: [
      src('VidLink Pro', 20, { isHls: true, quality: '1080' }),
      src('Internet Archive', 80, null),
      src('MGEB', 90, null),
      src('Vidsrc', 6000, null) // não é fonte de dublagem: não vale esperar
    ]
  });
  assert.equal(out.dub, null);
  assert.ok(out.orig);
  assert.ok(Date.now() - t0 < 2500, 'esperou demais: ' + (Date.now() - t0));
});

test('nada achado: devolve vazio e guarda o "não achei" por pouco tempo', async () => {
  const providers = [src('VidLink Pro', 10, null), src('CinePro', 10, null)];
  const out = await streamOptions.discover({ id: '3', type: 'movie', season: 1, episode: 1, title: 't', providers });
  assert.deepEqual({ dub: out.dub, orig: out.orig }, { dub: null, orig: null });
});

test('fonte que lança erro não derruba as outras', async () => {
  const out = await streamOptions.discover({
    id: '4', type: 'movie', season: 1, episode: 1, title: 't',
    providers: [
      { name: 'Embed.su', fn: async () => { throw new Error('boom'); } },
      src('VidLink Pro', 20, { isHls: true, quality: '720' })
    ]
  });
  assert.ok(out.orig);
});

test('série: cada episódio tem a sua descoberta', () => {
  assert.notEqual(
    streamOptions.keyOf({ id: '9', type: 'tv', season: 1, episode: 1 }),
    streamOptions.keyOf({ id: '9', type: 'tv', season: 1, episode: 2 })
  );
});

