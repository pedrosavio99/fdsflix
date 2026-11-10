'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');

const { createApp } = require('../lib/app');
const { loadConfig } = require('../lib/config');
const { configureSigning, proxiedPath, rewriteHls } = require('../lib/vidsrc');

let server;
let base;

before(async () => {
  const config = loadConfig({ PROXY_SECRET: 'k'.repeat(48), TARGET_ORIGIN: 'https://example.com' });
  configureSigning(config);
  server = http.createServer(createApp(config));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('rewriteHls remove o token e assina cada URI (variantes, segmentos e chaves)', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="/key.bin?token=ABC"',
    '#EXTINF:5.0,',
    '/content/x/page-0.html?token=ABC',
    '#EXTINF:5.0,',
    'https://other-cdn.space/content/x/page-1.html?token=ABC'
  ].join('\n');

  const out = rewriteHls(playlist, 'https://cdn.space/pl/abc/index.m3u8?token=ABC');

  assert.doesNotMatch(out, /token(=|%3D)ABC/);
  const proxied = out.split('\n').filter((line) => line.includes('/vidsrc/hls?u='));
  assert.equal(proxied.length, 3);
  for (const line of proxied) assert.match(line, /&s=[\w-]{22}/);
  // relativa resolve contra o host da playlist; absoluta mantém o próprio host (segmentos em outro domínio).
  assert.match(decodeURIComponent(out), /https:\/\/cdn\.space\/content\/x\/page-0\.html/);
  assert.match(decodeURIComponent(out), /https:\/\/other-cdn\.space\/content\/x\/page-1\.html/);
});

test('proxy só busca URLs assinadas por ele (sem proxy aberto / SSRF)', async () => {
  const target = 'https://example.com/a.m3u8';

  const unsigned = await fetch(`${base}/vidsrc/hls?u=${encodeURIComponent(target)}`);
  assert.equal(unsigned.status, 403);

  const forged = await fetch(`${base}/vidsrc/hls?u=${encodeURIComponent(target)}&s=AAAAAAAAAAAAAAAAAAAAAA`);
  assert.equal(forged.status, 403);

  const internal = 'http://169.254.169.254/latest/meta-data/';
  const ssrf = await fetch(`${base}${proxiedPath(internal)}`);
  assert.equal(ssrf.status, 403);
});

test('rotas /vidsrc respondem CORS e preflight', async () => {
  const preflight = await fetch(`${base}/vidsrc/hls`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Range/i);

  const bad = await fetch(`${base}/vidsrc/stream?tmdb=abc`);
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('access-control-allow-origin'), '*');
});
