'use strict';

// Fonte "MGEB" (por id do TMDB): página falsa em HTTP local. Nenhuma requisição sai para a internet.

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');

const mgeb = require('../lib/mgeb');
const cascade = require('../lib/fallbackCascade');

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // player do filme (177572 = Big Hero 6)
    if (url.pathname === '/embed/177572') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<html><video><source src="${base}/cdn/a.mp4?username=x&token=abc" type="video/mp4"></video>`);
    }
    // episódio de série (o seletor da página só troca o caminho)
    if (url.pathname === '/embed/1399/1/2') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<source src="${base}/cdn/ep2.mp4?username=x&token=abc" type="video/mp4">`);
    }
    if (url.pathname === '/embed/1399/1/1' || url.pathname === '/embed/1399') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<source src="${base}/cdn/ep1.mp4?username=x&token=abc" type="video/mp4">`);
    }
    // título sem fonte: só o placeholder
    if (url.pathname === '/embed/999') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><source src="http://cdn/video/vod_nao_encontrado.mp4"></html>');
    }
    if (url.pathname === '/cdn/a.mp4' || url.pathname === '/cdn/ep1.mp4' || url.pathname === '/cdn/ep2.mp4') {
      if (req.headers.range) {
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-40/1000' });
        return res.end('\u0000\u0000\u0000 ftypisom\u0000\u0000\u0002\u0000isomiso2avc1mp41');
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      return res.end('\u0000\u0000\u0000 ftypisom\u0000\u0000\u0002\u0000isomiso2avc1mp41');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.MGEB_BASE = base;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('extrai o MP4 e ignora o placeholder de "não encontrado"', () => {
  assert.equal(
    mgeb.extractMp4('<source src="http://cdn/movies/1/2.mp4?username=a&token=b">'),
    'http://cdn/movies/1/2.mp4?username=a&token=b'
  );
  // host público vira https (conteúdo misto); local fica como está
  assert.equal(mgeb.toHttps('http://cdn/movies/1/2.mp4?token=b').startsWith('https://'), true);
  assert.equal(mgeb.toHttps('http://127.0.0.1:3000/a.mp4'), 'http://127.0.0.1:3000/a.mp4');
  assert.equal(mgeb.extractMp4('<source src="http://cdn/video/vod_nao_encontrado.mp4">'), null);
  assert.equal(mgeb.extractMp4('<html>nada</html>'), null);
});

test('filme: devolve o MP4 para o navegador, sem exigir CORS', async () => {
  const out = await mgeb.findStream({ id: '177572', type: 'movie', title: 'Operação Big Hero' });
  assert.ok(out);
  assert.match(out.url, /\/cdn\/a\.mp4\?username=x&token=abc$/);
  assert.equal(out.provider, 'MGEB');
  assert.equal(out.codec, 'h264');
  assert.equal(out.browserDirect, true);
  assert.equal(out.cors, false); // o CDN não manda Access-Control-Allow-Origin
  assert.equal(mgeb.getReport().ok, true);
});

test('título sem fonte devolve null sem quebrar', async () => {
  const out = await mgeb.findStream({ id: '999', type: 'movie' });
  assert.equal(out, null);
});

test('série: usa /embed/<id>/<temporada>/<episódio> (episódio certo)', async () => {
  const ep2 = await mgeb.findStream({ id: '1399', type: 'tv', season: 1, episode: 2 });
  assert.ok(ep2);
  assert.match(ep2.url, /\/cdn\/ep2\.mp4/);
  const ep1 = await mgeb.findStream({ id: '1399', type: 'tv', season: 1, episode: 1 });
  assert.match(ep1.url, /\/cdn\/ep1\.mp4/);
});

test('entra na cascata e MGEB_ENABLED=0 tira', () => {
  const list = cascade.getProviderList().map((p) => p.name);
  assert.ok(list.includes('MGEB'));
  process.env.MGEB_ENABLED = '0';
  try {
    assert.equal(cascade.getProviderList().some((p) => p.name === 'MGEB'), false);
  } finally {
    delete process.env.MGEB_ENABLED;
  }
});

test('cota do CDN estourada: usa a opção sem token que for filme inteiro', async () => {
  const sources = [
    { file: `${base}/quota/a.mp4?username=x&token=abc`, type: 'mp4', label: 'Opção 1' },
    { file: `${base}/short/clip.mp4`, type: 'mp4', label: 'Opção 2' },
    { file: `${base}/full/film.mp4`, type: 'mp4', label: 'Opção 3' },
    { file: `${base}/x/master.m3u8`, type: 'hls', label: 'Opção 4' }
  ];
  const html = `<script>var sources = ${JSON.stringify(sources)};\n</script>`;
  const list = mgeb.extractMp4Candidates(html);
  assert.deepEqual(list.map((c) => c.tokened), [true, false, false]);

  const mvhd = (timescale, duration) => {
    const b = Buffer.alloc(120);
    b.write('ftypisom', 4, 'latin1');
    b.write('mvhd', 32, 'latin1');
    b.writeUInt32BE(timescale, 32 + 16);
    b.writeUInt32BE(duration, 32 + 20);
    return b;
  };
  assert.equal(mgeb.mp4DurationSec(mvhd(1000, 7474000)), 7474);
});
