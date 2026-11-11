import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test, beforeEach } from 'node:test';

import {
  CAPABILITY,
  getSecret,
  handleHls,
  resetTokenForTests,
  rewriteHls,
  sign
} from '../lib/edgeHls.mjs';

const require = createRequire(import.meta.url);
const vidsrc = require('../lib/vidsrc.js');
const { BUILTIN_PROXY_SECRET, loadConfig } = require('../lib/config.js');

const SECRET = getSecret({});
const MASTER = 'https://oakhollowoutpost.space/pl/abc/master.m3u8';
const SEGMENT = 'https://sageandsolstice.space/pl/xyz/seg-1.ts';

// O Node assina com o segredo da config; o Edge tem de assinar IGUAL.
vidsrc.configureSigning(loadConfig({}));

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-KEY:METHOD=AES-128,URI="https://k.example.com/key.bin?token=old",IV=0x01',
  '#EXTINF:6.0,',
  'seg-1.ts?token=old',
  '#EXTINF:6.0,',
  'https://other.example.com/a/seg-2.ts',
  ''
].join('\n');

async function signedHlsUrl(url) {
  return `https://x.vercel.app/vidsrc/hls?u=${encodeURIComponent(url)}&s=${await sign(url, SECRET)}`;
}

/** fetch simulado: a cadeia do token (generate.php) e o CDN. */
function makeFetch({ cdn, tokens = ['tok-1'], log = [] }) {
  let minted = 0;
  const fn = async (input, init = {}) => {
    const url = String(input);
    const headers = init.headers || {};
    log.push({ url, headers });
    if (url.startsWith('https://vidsrc.sh/embed/')) return new Response('<div data-api="/vs_src.php?x=1&amp;y=2"></div>');
    if (url.includes('/vs_src.php')) return new Response(JSON.stringify({ src: '/stellar/player' }));
    if (url.includes('/stellar/player')) {
      return new Response('window.CFG = {"playerUrl":"/p/1","metaApi":"https://meta.example.com/m"};');
    }
    if (url.includes('/p/1')) return new Response('window.CONFIG = {"apiToken":"API-TOKEN"};');
    if (url.startsWith('https://meta.example.com/m')) {
      return new Response(JSON.stringify({ data: { stream_urls_api_host: 'api.example.com' } }));
    }
    if (url.startsWith('https://api.example.com/api.php')) return new Response('{}');
    if (url.startsWith('https://api.example.com/generate.php')) {
      const token = tokens[Math.min(minted, tokens.length - 1)];
      minted += 1;
      return new Response(token);
    }
    return cdn(url, headers);
  };
  fn.minted = () => minted;
  return fn;
}

beforeEach(() => resetTokenForTests());

test('assinatura do Edge é idêntica à da função Node (master emitido por um vale no outro)', async () => {
  assert.equal(SECRET, BUILTIN_PROXY_SECRET);
  const nodeUrl = vidsrc.proxiedPath(MASTER); // /vidsrc/hls?u=...&s=...
  const nodeSig = new URL(nodeUrl, 'https://x').searchParams.get('s');
  assert.equal(await sign(MASTER, SECRET), nodeSig);
});

test('PROXY_SECRET na Vercel manda mais que o embutido, igual à config Node', () => {
  assert.equal(getSecret({ PROXY_SECRET: 'meu-segredo' }), 'meu-segredo');
  assert.equal(loadConfig({ PROXY_SECRET: 'meu-segredo' }).secret, 'meu-segredo');
  assert.equal(getSecret({ SESSION_SECRET: 'outro' }), 'outro');
});

test('rewriteHls do Edge produz exatamente o mesmo texto que o da função Node', async () => {
  const node = vidsrc.rewriteHls(PLAYLIST, MASTER);
  const edge = await rewriteHls(PLAYLIST, MASTER, SECRET);
  assert.equal(edge, node);
  assert.ok(!edge.includes('token='), 'o token do CDN não pode vazar para o player');
  assert.equal(edge.split('\n').filter((l) => l.includes('/vidsrc/hls?u=')).length, 3);
});

test('cap=1 diz que esta Vercel entrega pelo Edge', async () => {
  const res = await handleHls(new Request('https://x.vercel.app/vidsrc/hls?cap=1'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), CAPABILITY);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('preflight e métodos', async () => {
  const pre = await handleHls(new Request('https://x.vercel.app/vidsrc/hls', { method: 'OPTIONS' }));
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /Range/);
  const post = await handleHls(new Request('https://x.vercel.app/vidsrc/hls', { method: 'POST' }));
  assert.equal(post.status, 405);
});

test('só busca URLs assinadas: sem assinatura, assinatura errada e URL http dão 403/400 (sem SSRF)', async () => {
  const log = [];
  const fetchFn = makeFetch({ cdn: () => new Response('x'), log });
  const bad = [
    `https://x.vercel.app/vidsrc/hls?u=${encodeURIComponent(MASTER)}`,
    `https://x.vercel.app/vidsrc/hls?u=${encodeURIComponent(MASTER)}&s=AAAAAAAAAAAAAAAAAAAAAA`,
    `https://x.vercel.app/vidsrc/hls?u=${encodeURIComponent('http://169.254.169.254/latest')}&s=${await sign('http://169.254.169.254/latest', SECRET)}`
  ];
  for (const url of bad) {
    const res = await handleHls(new Request(url), { fetch: fetchFn });
    assert.equal(res.status, 403, url);
  }
  const invalid = await handleHls(new Request('https://x.vercel.app/vidsrc/hls?u=nao-e-url&s=x'), { fetch: fetchFn });
  assert.equal(invalid.status, 400);
  assert.equal(log.length, 0, 'nenhuma requisição saiu para a internet');
});

test('playlist: gera o token no Edge, manda Referer + token ao CDN e devolve links assinados', async () => {
  const log = [];
  const fetchFn = makeFetch({
    log,
    cdn: () => new Response(PLAYLIST, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
  });
  const res = await handleHls(new Request(await signedHlsUrl(MASTER)), { fetch: fetchFn });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(await res.text(), vidsrc.rewriteHls(PLAYLIST, MASTER));

  const cdnCall = log.find((c) => c.url.startsWith(MASTER));
  assert.equal(new URL(cdnCall.url).searchParams.get('token'), 'tok-1');
  assert.equal(cdnCall.headers.Referer, 'https://stellarconductornexus.com/');
});

test('segmento: repassa o corpo, normaliza text/html para video/mp2t e respeita Range', async () => {
  const body = new Uint8Array([0x47, 1, 2, 3, 4, 5]);
  const log = [];
  const fetchFn = makeFetch({
    log,
    cdn: () =>
      new Response(body, {
        status: 206,
        headers: { 'content-type': 'text/html', 'content-range': 'bytes 0-5/100', 'accept-ranges': 'bytes', 'content-length': '6' }
      })
  });
  const res = await handleHls(
    new Request(await signedHlsUrl(SEGMENT), { headers: { Range: 'bytes=0-5' } }),
    { fetch: fetchFn }
  );
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), 'video/mp2t');
  assert.equal(res.headers.get('content-range'), 'bytes 0-5/100');
  assert.equal(res.headers.get('content-length'), '6');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), body);
  assert.equal(log.find((c) => c.url.startsWith(SEGMENT)).headers.Range, 'bytes=0-5');
});

test('403 "not in range": refaz o token uma vez e repete; token novo é reaproveitado depois', async () => {
  const fetchFn = makeFetch({
    tokens: ['velho', 'novo'],
    cdn: (url) => {
      const token = new URL(url).searchParams.get('token');
      return token === 'novo' ? new Response('ok', { headers: { 'content-type': 'video/mp2t' } }) : new Response('ip 1.2.3.4 not in range', { status: 403 });
    }
  });
  const res = await handleHls(new Request(await signedHlsUrl(SEGMENT)), { fetch: fetchFn });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
  assert.equal(fetchFn.minted(), 2);

  const again = await handleHls(new Request(await signedHlsUrl(SEGMENT)), { fetch: fetchFn });
  assert.equal(again.status, 200);
  assert.equal(fetchFn.minted(), 2, 'não gera token de novo enquanto o atual vale');
});

test('várias requisições juntas na partida fazem UM só mint de token', async () => {
  const fetchFn = makeFetch({ cdn: () => new Response('ok', { headers: { 'content-type': 'video/mp2t' } }) });
  const url = await signedHlsUrl(SEGMENT);
  const all = await Promise.all(Array.from({ length: 6 }, () => handleHls(new Request(url), { fetch: fetchFn })));
  assert.ok(all.every((r) => r.status === 200));
  assert.equal(fetchFn.minted(), 1);
});

test('erro do CDN (404) chega ao player com o mesmo status, e falha ao gerar token vira 502 legível', async () => {
  const notFound = makeFetch({ cdn: () => new Response('nao existe', { status: 404 }) });
  const res = await handleHls(new Request(await signedHlsUrl(SEGMENT)), { fetch: notFound });
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'nao existe');

  resetTokenForTests();
  const down = async () => new Response('fora', { status: 500 });
  const bad = await handleHls(new Request(await signedHlsUrl(SEGMENT)), { fetch: down });
  assert.equal(bad.status, 502);
  assert.match(await bad.text(), /Falha no Vidsrc: embed HTTP 500/);
});
