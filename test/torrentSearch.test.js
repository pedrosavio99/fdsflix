'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  search, parseApibay, parseYts, parseHtml, rank,
  magnetFor, guessAudio, titleMatch
} = require('../lib/torrentSearch');

test('magnetFor monta um magnet válido', () => {
  const m = magnetFor('D7A46713EAEE18C746B3254B7D1492A50FD9D6CE', 'The Matrix');
  assert.match(m, /^magnet:\?xt=urn:btih:D7A46713EAEE18C746B3254B7D1492A50FD9D6CE/);
  assert.match(m, /&dn=The%20Matrix/);
  assert.match(m, /&tr=/);
});

test('guessAudio: PT-BR dublado, dual, legendado e English Dub (não é PT-BR)', () => {
  assert.equal(guessAudio('Matrix Dublado 1080p'), 'dub');
  assert.equal(guessAudio('Matrix Dual Áudio 720p'), 'dual');
  assert.equal(guessAudio('Matrix Legendado'), 'leg');
  assert.equal(guessAudio('Dragon Ball Super - English Dub - 1080p'), 'orig');
  assert.equal(guessAudio('The Matrix 1999 1080p'), 'orig');
});

test('titleMatch casa título + ano e recusa outro ano', () => {
  assert.equal(titleMatch('The Matrix (1999) 1080p', { title: 'Matrix', year: '1999' }), true);
  assert.equal(titleMatch('The Matrix Reloaded (2003)', { title: 'Matrix', year: '1999' }), false);
  assert.equal(titleMatch('Matrix', { title: 'Matrix' }), true);
  assert.equal(titleMatch('Pulp Fiction', { title: 'Matrix' }), false);
});

test('titleMatch aceita o título original (mostra PT-BR, busca os dois)', () => {
  assert.equal(titleMatch('Finding Nemo (2003) 1080p', { title: 'Procurando Nemo', alt: 'Finding Nemo', year: '2003' }), true);
  assert.equal(titleMatch('Procurando Nemo 2003 Dublado 1080p', { title: 'Procurando Nemo', year: '2003' }), true);
});

test('rank prefere 720p e, no empate, mais seeds', () => {
  const items = [
    { title: 'Matrix 1080p', audio: 'orig', quality: '1080p', seeds: 500, hash: 'H1' },
    { title: 'Matrix 720p', audio: 'orig', quality: '720p', seeds: 5, hash: 'H2' },
    { title: 'Matrix 720p', audio: 'orig', quality: '720p', seeds: 90, hash: 'H3' }
  ];
  const out = rank(items, { title: 'Matrix' });
  assert.equal(out[0].quality, '720p');
  assert.equal(out[0].hash, 'H3');
});

test('parseApibay lê o JSON e gera magnet', () => {
  const body = JSON.stringify([{
    id: '1', name: 'The Matrix (1999) 1080p BrRip', info_hash: 'D7A46713EAEE18C746B3254B7D1492A50FD9D6CE',
    seeders: '906', leechers: '10', size: '1992277407', added: '1339543961', imdb: 'tt0133093'
  }]);
  const out = parseApibay(body);
  assert.equal(out.length, 1);
  assert.equal(out[0].seeds, 906);
  assert.match(out[0].magnet, /urn:btih:D7A4/);
  assert.equal(out[0].source, 'The Pirate Bay');
});

test('parseYts lê o JSON e gera magnet', () => {
  const body = JSON.stringify({
    data: {
      movies: [{
        title_long: 'The Matrix (1999)', date_uploaded: '2010-01-01',
        torrents: [{ hash: 'D7A46713EAEE18C746B3254B7D1492A50FD9D6CE', quality: '1080p', type: 'bluray', seeds: 100, peers: 5, size_bytes: 1992277407, url: 'https://yts.lt/torrent/download/1' }]
      }]
    }
  });
  const out = parseYts(body);
  assert.equal(out.length, 1);
  assert.equal(out[0].quality, '1080p');
  assert.match(out[0].magnet, /urn:btih:D7A4/);
});

test('parseHtml pega magnet e classifica dublado', () => {
  const html = '<a href="magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=Matrix">Matrix Dublado 1080p</a>';
  const out = parseHtml(html, { name: 'X', base: 'https://x.test', lang: 'pt' }, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].audio, 'dub');
  assert.match(out[0].magnet, /urn:btih:ABCDEF/);
});

test('rank põe dublado primeiro e rejeita CAM', () => {
  const items = [
    { title: 'Matrix 1080p CAM', audio: 'orig', quality: '1080p', seeds: 500, hash: 'C1' },
    { title: 'Matrix Legendado 1080p', audio: 'leg', quality: '1080p', seeds: 300, hash: 'L1' },
    { title: 'Matrix Dublado 720p', audio: 'dub', quality: '720p', seeds: 10, hash: 'D1' }
  ];
  const out = rank(items, { title: 'Matrix' });
  assert.equal(out[0].audio, 'dub');
  assert.ok(out.every((x) => !/CAM/.test(x.title)));
});

test('search junta as fontes (fetch mockado)', async () => {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('apibay')) {
      return new Response(JSON.stringify([{
        id: '1', name: 'The Matrix (1999) 1080p', info_hash: 'D7A46713EAEE18C746B3254B7D1492A50FD9D6CE',
        seeders: '906', leechers: '1', size: '1992277407', added: '1', imdb: 'tt0133093'
      }]), { status: 200 });
    }
    if (u.includes('yts.lt')) return new Response(JSON.stringify({ data: { movies: [] } }), { status: 200 });
    return new Response('<html></html>', { status: 200 });
  };
  try {
    const r = await search({ title: 'Matrix', year: '1999' });
    assert.ok(r.results.length >= 1);
    assert.match(r.results[0].magnet, /^magnet:/);
    assert.ok(r.sources.some((s) => s.id === 'apibay' && s.ok));
  } finally {
    global.fetch = original;
  }
});
