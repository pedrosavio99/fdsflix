'use strict';

/**
 * Proxy de mídia genérico (a "AdShield de fallback").
 *
 * Sobe uma origem de mentira (playlist HLS + segmento + mp4 com Range + página HTML), liga o
 * adproxy com MEDIA_PROXY=1 e percorre o mesmo caminho do player: prepare -> playlist -> variante
 * -> segmento. Também confere a chave compartilhada, o token adulterado e o nó sem MEDIA_PROXY.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');

const { createApp } = require('../lib/app');
const { loadConfig } = require('../lib/config');

let originServer;
let proxyServer;
let disabledServer;
let originBase;
let proxyBase;
let disabledBase;

const MP4 = Buffer.alloc(4096, 1);

// MP4 "de mentira" só com a estrutura que importa: stsd + sample entry hev1.
const HEV1_AT = 4 + 4 + 4 + 8 + 4 + 8 + 4 + 8; // calculado abaixo de propósito
const HEV1_FILE = Buffer.concat([
  Buffer.from('00000018ftypisom', 'latin1'),
  Buffer.from('00000020moov', 'latin1'),
  Buffer.from('00000014stsd', 'latin1'),
  Buffer.from('00000000', 'latin1'),
  Buffer.from('0000000chev1', 'latin1'),
  Buffer.alloc(2048, 0x41)
]);
MP4[0] = 0x00;
MP4[4] = 0x66; // "ftyp" aproximado: só para os testes de bytes

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function startOrigin() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/master.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nv.m3u8\n');
      return;
    }
    if (url.pathname === '/v.m3u8') {
      res.setHeader('Content-Type', 'text/plain');
      res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2.0,\nseg.ts\n');
      return;
    }
    if (url.pathname === '/key.bin') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(Buffer.alloc(16, 7));
      return;
    }
    if (url.pathname === '/seg.ts') {
      res.setHeader('Content-Type', 'text/html'); // CDN mal-educado, como o do Vidsrc
      res.end(Buffer.from([0x47, 0x40, 0x11, 0x10, 1, 2, 3, 4]));
      return;
    }
    if (url.pathname === '/fake-hev1.mp4') {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(HEV1_FILE.length));
      res.setHeader('Accept-Ranges', 'bytes');
      res.end(HEV1_FILE);
      return;
    }
    if (url.pathname === '/movie.mp4') {
      const range = req.headers.range;
      if (range) {
        const [, startRaw, endRaw] = /bytes=(\d+)-(\d*)/.exec(range) || [];
        const start = Number(startRaw) || 0;
        const end = Math.min(endRaw ? Number(endRaw) : MP4.length - 1, MP4.length - 1);
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${MP4.length}`);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        res.end(MP4.subarray(start, end + 1));
        return;
      }
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(MP4.length));
      res.end(MP4);
      return;
    }
    if (url.pathname === '/page.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!DOCTYPE html><html><body>player</body></html>');
      return;
    }
    res.statusCode = 404;
    res.end('nada');
  });
}

before(async () => {
  originServer = startOrigin();
  originBase = await listen(originServer);

  const config = loadConfig({
    TARGET_ORIGIN: 'https://vidlink.pro',
    PROXY_SECRET: 'teste-media-secret',
    MEDIA_PROXY: '1',
    MEDIA_PROXY_KEY: 'chave-teste',
    ALLOW_PRIVATE_UPSTREAMS: '1',
    TRUST_PROXY: '0'
  });
  proxyServer = http.createServer(createApp(config));
  proxyBase = await listen(proxyServer);

  const disabled = loadConfig({
    TARGET_ORIGIN: 'https://vidlink.pro',
    PROXY_SECRET: 'teste-media-secret',
    ALLOW_PRIVATE_UPSTREAMS: '1',
    TRUST_PROXY: '0'
  });
  disabledServer = http.createServer(createApp(disabled));
  disabledBase = await listen(disabledServer);
});

after(async () => {
  await Promise.all([close(originServer), close(proxyServer), close(disabledServer)]);
});

function prepare(query, headers = {}) {
  return fetch(`${proxyBase}/_adshield/media/prepare?${new URLSearchParams(query)}`, { headers });
}

test('prepare exige a chave compartilhada', async () => {
  const res = await prepare({ u: `${originBase}/master.m3u8` });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /chave/i);
});

test('nó sem MEDIA_PROXY responde 404 (comportamento antigo intacto)', async () => {
  const res = await fetch(`${disabledBase}/_adshield/media/prepare?u=${encodeURIComponent(`${originBase}/master.m3u8`)}`);
  assert.equal(res.status, 404);
  const media = await fetch(`${disabledBase}/_adshield/media/m/qualquer.token`);
  assert.equal(media.status, 404);
});

test('playlist é reescrita e variante/chave/segmento também passam pelo nó', async () => {
  const prepared = await prepare({ u: `${originBase}/master.m3u8` }, { 'x-media-key': 'chave-teste' });
  assert.equal(prepared.status, 200);
  const info = await prepared.json();
  assert.equal(info.ok, true);
  assert.equal(info.kind, 'hls');
  assert.equal(info.hvc1, true, 'o nó anuncia que entrega hev1 como hvc1 (Safari)');
  assert.match(info.url, /\/_adshield\/media\/m\//);

  const master = await fetch(info.url);
  assert.equal(master.status, 200);
  const masterText = await master.text();
  assert.match(masterText, /^#EXTM3U/);
  assert.ok(!masterText.includes('v.m3u8'), 'a URI relativa não pode vazar sem assinatura');
  const variantPath = masterText.split(/\r?\n/).find((line) => line && !line.startsWith('#'));

  const variant = await fetch(`${proxyBase}${variantPath}`);
  assert.equal(variant.status, 200);
  const variantText = await variant.text();
  assert.match(variantText, /^#EXTM3U/);
  assert.ok(!variantText.includes('seg.ts'), 'o segmento precisa ser reescrito');
  assert.ok(!variantText.includes('key.bin'), 'a chave precisa ser reescrita');

  const keyPath = /URI="([^"]+)"/.exec(variantText)[1];
  const key = await fetch(`${proxyBase}${keyPath}`);
  assert.equal(key.status, 200);
  assert.equal((await key.arrayBuffer()).byteLength, 16);

  const segPath = variantText.split(/\r?\n/).find((line) => line && !line.startsWith('#'));
  const seg = await fetch(`${proxyBase}${segPath}`);
  assert.equal(seg.status, 200);
  assert.equal(seg.headers.get('content-type'), 'video/mp2t');
  const segBytes = new Uint8Array(await seg.arrayBuffer());
  assert.equal(segBytes[0], 0x47);
});

test('arquivo progressivo preserva Range e content-range', async () => {
  const prepared = await prepare({ u: `${originBase}/movie.mp4` }, { 'x-media-key': 'chave-teste' });
  const info = await prepared.json();
  assert.equal(info.ok, true);
  assert.equal(info.kind, 'file');

  const full = await fetch(info.url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal((await full.arrayBuffer()).byteLength, MP4.length);

  const partial = await fetch(info.url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(partial.status, 206);
  assert.match(partial.headers.get('content-range'), /^bytes 0-99\/4096$/);
  assert.equal((await partial.arrayBuffer()).byteLength, 100);
});

test('página HTML não é confundida com mídia', async () => {
  const prepared = await prepare({ u: `${originBase}/page.html` }, { 'x-media-key': 'chave-teste' });
  assert.equal(prepared.status, 415);
  const info = await prepared.json();
  assert.equal(info.ok, false);
  assert.match(info.error, /HTML/i);
});

test('token adulterado é recusado', async () => {
  const prepared = await prepare({ u: `${originBase}/master.m3u8` }, { 'x-media-key': 'chave-teste' });
  const info = await prepared.json();
  const tampered = info.url.replace(/([^/])$/, (c) => (c === 'A' ? 'B' : 'A'));
  const res = await fetch(tampered);
  assert.equal(res.status, 403);
});

test('referer/UA informados no prepare são repassados à origem', async () => {
  const seen = [];
  const capture = http.createServer((req, res) => {
    seen.push({ referer: req.headers.referer || '', origin: req.headers.origin || '', ua: req.headers['user-agent'] || '' });
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.end('#EXTM3U\n#EXTINF:1,\nseg.ts\n');
  });
  const captureBase = await listen(capture);
  try {
    const prepared = await prepare(
      { u: `${captureBase}/x.m3u8`, r: 'https://animefire.example/', o: 'https://animefire.example', a: 'UA-Do-Perfil/1.0' },
      { 'x-media-key': 'chave-teste' }
    );
    const info = await prepared.json();
    assert.equal(info.ok, true);
    await fetch(info.url);
    assert.ok(seen.length >= 1);
    assert.equal(seen[0].referer, 'https://animefire.example/');
    assert.equal(seen[0].origin, 'https://animefire.example/');
    assert.equal(seen[0].ua, 'UA-Do-Perfil/1.0');
  } finally {
    await close(capture);
  }
});


test('HEVC "hev1" vira "hvc1" SÓ quando o Render pede (iPhone/Safari: h=1)', async () => {
  const prepared = await prepare({ u: `${originBase}/fake-hev1.mp4`, h: '1' }, { 'x-media-key': 'chave-teste' });
  const info = await prepared.json();
  assert.equal(info.ok, true);
  assert.equal(info.kind, 'file');

  const res = await fetch(info.url);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, HEV1_FILE.length, 'o tamanho não muda (só 4 bytes)');
  assert.ok(body.includes(Buffer.from('hvc1')), 'sample entry trocado para hvc1');
  assert.ok(!body.includes(Buffer.from('hev1')), 'não sobrou hev1');
});

test('sem o pedido do iPhone/Safari o arquivo vai intacto (nenhuma leitura extra na origem)', async () => {
  const prepared = await prepare({ u: `${originBase}/fake-hev1.mp4` }, { 'x-media-key': 'chave-teste' });
  const info = await prepared.json();
  assert.equal(info.ok, true);
  const res = await fetch(info.url);
  const body = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(body, HEV1_FILE, 'idêntico ao da origem');
});
