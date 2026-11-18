'use strict';

// JKAnime: segunda fonte de anime (ad-free; MP4 preso ao IP do nó que abriu o player).
// O teste cobre os parsers e o findStream inteiro, com fetch/prepareOn substituídos.

process.env.ADSHIELD_FALLBACK_URLS = 'https://node.example';
process.env.ADSHIELD_FALLBACK_KEY = 'k';
delete process.env.VIDEO_RELAY_URL;
delete process.env.RELAY_URL;
delete process.env.SM_RELAY;

const test = require('node:test');
const assert = require('node:assert/strict');

const jk = require('../lib/jkAnime');
const anime = require('../lib/animesDigital');
const fallback = require('../lib/adshieldFallback');

const SEARCH = `
  <a href="https://jkanime.net/dash/editar-perfil">Editar perfil</a>
  <a href="https://jkanime.net/one-piece-3d2y-ace-no-shi-wo-koete-luffy-nakama-tono-chikai/">One Piece 3D2Y</a>
  <a href="https://jkanime.net/one-piece/">One Piece</a>`;

const EPISODE = `
  <iframe class="player_conte" src="https://jkanime.net/jkplayer/jk?u=stream/jkmedia/tok/hash/1/203.0.113.9/" width="565" height="318"></iframe>`;

const PLAYER = `
  <script>
    var dp = new DPlayer({ video: {
      url: 'https://jkplayers.com/stream/jkmedia/tok/hash/1/203.0.113.9/',
      type: 'mp4'
    } });
  </script>`;

test('parseSearch lê os animes e ignora as páginas do site', () => {
  const results = jk.parseSearch(SEARCH);
  assert.equal(results.length, 2);
  assert.equal(results[1].slug, 'one-piece');
  assert.ok(!results.some((r) => r.slug === 'dash'));
});

test('parseJkIframe e parseJkPlayer leem o player jk', () => {
  const jkUrl = jk.parseJkIframe(EPISODE);
  assert.match(jkUrl, /jkplayer\/jk\?u=stream\/jkmedia\//);
  const video = jk.parseJkPlayer(PLAYER);
  assert.equal(video.type, 'mp4');
  assert.match(video.url, /jkplayers\.com\/stream\/jkmedia\//);
});

test('findStream resolve pelo nó (episódio + player + MP4 no mesmo nó)', async () => {
  jk._reset();
  anime._reset();
  fallback._reset();
  const originalInfo = anime.animeInfo;
  const originalNodes = fallback.mediaNodes;
  const originalPrepareOn = fallback.prepareOn;
  const originalFetch = global.fetch;
  const calls = [];
  let preparedOn = null;
  anime.animeInfo = async () => ({ isAnime: true, names: ['One Piece'] });
  fallback.mediaNodes = () => ['https://node.example'];
  fallback.prepareOn = async (base, options) => {
    preparedOn = { base, options };
    return { ok: true, kind: 'file', url: 'https://node.example/_adshield/media/m/x', node: base, contentType: 'video/mp4', ms: 8 };
  };
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/buscar/?q=')) return new Response(SEARCH, { status: 200 });
    if (u.includes('/_adshield/r/')) {
      const via = calls.filter((c) => c.includes('/_adshield/r/')).length;
      return new Response(via === 1 ? EPISODE : PLAYER, { status: 200 });
    }
    return new Response('x', { status: 404 });
  };
  try {
    const r = await jk.findStream({ id: '37854', type: 'tv', season: 1, episode: 1, title: 'One Piece' });
    assert.ok(r);
    assert.equal(r.provider, 'JKAnime');
    assert.equal(r.url, 'https://node.example/_adshield/media/m/x');
    assert.equal(r.isHls, false);
    assert.equal(preparedOn.base, 'https://node.example');
    assert.equal(preparedOn.options.allowCompat, false);
    assert.equal(preparedOn.options.referer, 'https://jkanime.net/');
    assert.match(preparedOn.options.url, /jkplayers\.com\/stream\/jkmedia\//);
    assert.equal(calls.filter((c) => c.includes('/_adshield/r/')).length, 2, 'episódio e player pelo nó');
    assert.ok(calls.some((c) => c.includes('/buscar/?q=')));
  } finally {
    anime.animeInfo = originalInfo;
    fallback.mediaNodes = originalNodes;
    fallback.prepareOn = originalPrepareOn;
    global.fetch = originalFetch;
  }
});

test('findStream devolve null para título não-anime', async () => {
  jk._reset();
  anime._reset();
  const originalInfo = anime.animeInfo;
  anime.animeInfo = async () => ({ isAnime: false, names: [] });
  try {
    const r = await jk.findStream({ id: '550', type: 'movie', season: 1, episode: 1, title: 'Fight Club' });
    assert.equal(r, null);
  } finally {
    anime.animeInfo = originalInfo;
  }
});
