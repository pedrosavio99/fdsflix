'use strict';

// Provedor opcional "Dublado PT": só existe com PT_DUB_API_BASE. Aqui o serviço é falso (HTTP local).

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');

const cascade = require('../lib/fallbackCascade');

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const send = (code, body) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (url === '/api/filmes/1368337') {
      return send(200, {
        stream_url: 'https://cdn.example/filme-dublado.m3u8',
        quality: '1080p',
        subtitles: [{ url: 'https://cdn.example/legenda.srt', language: 'Português' }]
      });
    }
    if (url === '/api/series/213375/1/1') {
      return send(200, { data: { url: 'https://cdn.example/ep-dublado.mp4' }, qualidade: '720p' });
    }
    return send(404, { error: 'nada' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('sem PT_DUB_API_BASE o provedor nem aparece na cascata', () => {
  delete process.env.PT_DUB_API_BASE;
  assert.equal(cascade.getProviderList().some((p) => p.name === 'Dublado PT'), false);
});

test('com PT_DUB_API_BASE ele entra no fim da cascata', () => {
  process.env.PT_DUB_API_BASE = base;
  const list = cascade.getProviderList().map((p) => p.name);
  assert.equal(list[list.length - 1], 'Dublado PT');
  delete process.env.PT_DUB_API_BASE;
});

test('filme dublado: pega stream_url, qualidade e legendas', async () => {
  process.env.PT_DUB_API_BASE = base;
  try {
    const out = await cascade.tryPortugues('1368337', 'movie', 1, 1, 'Filme');
    assert.ok(out);
    assert.equal(out.url, 'https://cdn.example/filme-dublado.m3u8');
    assert.equal(out.quality, '1080p');
    assert.equal(out.isHls, true);
    assert.equal(out.audio, 'pt-BR');
    assert.equal(out.captions.length, 1);
  } finally {
    delete process.env.PT_DUB_API_BASE;
  }
});

test('série dublada: entende o formato { data: { url } }', async () => {
  process.env.PT_DUB_API_BASE = base;
  try {
    const out = await cascade.tryPortugues('213375', 'tv', 1, 1, 'Série');
    assert.ok(out);
    assert.equal(out.url, 'https://cdn.example/ep-dublado.mp4');
    assert.equal(out.quality, '720p');
    assert.equal(out.isHls, false);
  } finally {
    delete process.env.PT_DUB_API_BASE;
  }
});

test('título que o serviço não tem -> null (a cascata segue normal)', async () => {
  process.env.PT_DUB_API_BASE = base;
  try {
    assert.equal(await cascade.tryPortugues('999', 'movie', 1, 1, 'Nada'), null);
  } finally {
    delete process.env.PT_DUB_API_BASE;
  }
});
