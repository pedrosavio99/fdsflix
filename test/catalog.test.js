'use strict';

// Catálogo colhido em casa: leitura do arquivo, descarte de link morto e de URL com token (sem rede externa).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

let server;
let base;
let tmp;
let catalog;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/vivo.mp4')) {
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1/100' });
      return res.end('ab');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
  process.env.CATALOG_FILE = path.join(tmp, 'catalog.json');
  fs.writeFileSync(process.env.CATALOG_FILE, JSON.stringify({
    version: 1,
    movies: {
      129: { title: 'Chihiro', entries: [
        { source: 'bitchute', url: `${base}/morto.mp4`, quality: 'auto' },
        { source: 'bitchute', url: `${base}/vivo.mp4`, quality: '480p', audioLang: 'por' }
      ] },
      200: { title: 'Só com token', entries: [{ source: 'mgeb', url: 'https://cdn.exemplo.com/a.mp4?token=abc' }] }
    },
    misses: {}
  }));
  catalog = require('../lib/catalog');
});

after(() => new Promise((resolve) => { fs.rmSync(tmp, { recursive: true, force: true }); server.close(resolve); }));

test('só URL estável (https, sem token/assinatura) entra', () => {
  assert.equal(catalog.isStableUrl('https://seed1.bitchute.com/x/y.mp4'), true);
  assert.equal(catalog.isStableUrl('https://cdn/a.mp4?token=abc'), false);
  assert.equal(catalog.isStableUrl('https://cdn/a.mp4?sig=1'), false);
  assert.equal(catalog.isStableUrl('https://cdn/a.mp4?expires=99'), false);
  assert.equal(catalog.isStableUrl('http://cdn/a.mp4'), false);
  assert.equal(catalog.isStableUrl('http://127.0.0.1:9/a.mp4'), true); // só local, para teste
});

test('devolve o link vivo, em português primeiro, e descarta o morto', async () => {
  const out = await catalog.findStream({ id: 129, type: 'movie' });
  assert.ok(out, 'devia achar o link vivo');
  assert.equal(out.url, `${base}/vivo.mp4`);
  assert.equal(out.provider, 'Catálogo');
  assert.equal(out.audioLang, 'por');
  assert.equal(out.browserDirect, true);
});

test('série e título que não está no catálogo: null', async () => {
  assert.equal(await catalog.findStream({ id: 129, type: 'tv' }), null);
  assert.equal(await catalog.findStream({ id: 999999, type: 'movie' }), null);
});

test('entrada só com token não é servida', async () => {
  assert.equal(await catalog.findStream({ id: 200, type: 'movie' }), null);
});

test('catálogo conta os filmes', () => {
  assert.equal(catalog.size(), 2);
});
