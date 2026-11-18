'use strict';

// AnimesDigital: a fonte brasileira de anime que substitui o AnimeFire (CDN morto).
// O HLS do CDN exige Referer https://animesdigital.org/ e não manda CORS; o nó do AdFallback
// prepara a URL assinada. O teste cobre a busca, a escolha da temporada/dublado, o parser do
// player e o findStream inteiro, sem rede.

process.env.TMDB_API_KEY = 'test-key';
process.env.ADSHIELD_FALLBACK_URLS = 'https://node.example';
process.env.ADSHIELD_FALLBACK_KEY = 'k';
delete process.env.VIDEO_RELAY_URL;
delete process.env.RELAY_URL;
delete process.env.SM_RELAY;

const test = require('node:test');
const assert = require('node:assert/strict');

const anime = require('../lib/animesDigital');
const fallback = require('../lib/adshieldFallback');

const HLS = 'https://cdn-sv01.maximaimg.online/stream/j/jujutsu-kaisen-dublado/01.mp4/index.m3u8';

const SEARCH = `
  <a href="https://animesdigital.org/anime/a/jujutsu-kaisen-2-dublado">Jujutsu Kaisen 2 Dublado</a>
  <a href="https://animesdigital.org/anime/a/jujutsu-kaisen-2">Jujutsu Kaisen 2</a>
  <a href="https://animesdigital.org/anime/a/jujutsu-kaisen-dublado">Jujutsu Kaisen Dublado</a>
  <a href="https://animesdigital.org/anime/a/jujutsu-kaisen">Jujutsu Kaisen</a>`;

const ANIME = `
  <a href="https://animesdigital.org/video/a/ep2"><img alt="Episódio 2"><span>Jujutsu Kaisen Dublado Episódio 2</span></a>
  <a href="https://animesdigital.org/video/a/ep1"><img alt="Episódio 1"><span>Jujutsu Kaisen Dublado Episódio 1</span></a>`;

const EPISODE = `
  <iframe src="https://api.anivideo.net/videohls.php?d=https%3A%2F%2Fcdn-sv01.maximaimg.online%2Fstream%2Fj%2Fjujutsu-kaisen-dublado%2F01.mp4%2Findex.m3u8&#038;nocache1794966678&#038;i=https%3A%2F%2Fanimesdigital.org%2Fx.jpg"></iframe>`;

function stubFetch() {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('api.themoviedb.org') && u.includes('/tv/95479')) {
      return new Response(JSON.stringify({ genres: [{ id: 16 }], origin_country: ['JP'], original_language: 'ja' }), { status: 200 });
    }
    if (u.includes('animesdigital.org/?s=')) return new Response(SEARCH, { status: 200 });
    if (u.includes('/anime/a/jujutsu-kaisen-dublado')) return new Response(ANIME, { status: 200 });
    if (u.includes('/video/a/ep1')) return new Response(EPISODE, { status: 200 });
    if (u.includes('/_adshield/media/prepare')) {
      return new Response(JSON.stringify({ ok: true, kind: 'hls', url: 'https://node.example/_adshield/media/m/x' }), { status: 200 });
    }
    return new Response('x', { status: 404 });
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test('parseSearch/parseEpisodes/parsePlayer leem o HTML do site', () => {
  const results = anime.parseSearch(SEARCH);
  assert.equal(results.length, 4);
  assert.equal(results[2].label, 'Jujutsu Kaisen Dublado');

  const episodes = anime.parseEpisodes(ANIME);
  assert.equal(episodes.length, 2);
  assert.equal(episodes.find((e) => e.number === 1).url, 'https://animesdigital.org/video/a/ep1');

  assert.equal(anime.parsePlayer(EPISODE), HLS);
});

test('chooseAnime prefere a temporada pedida e, no empate, a dublada', () => {
  const results = anime.parseSearch(SEARCH);
  const s1 = anime.chooseAnime(results, 'Jujutsu Kaisen', 1, 'tv');
  assert.match(s1.url, /jujutsu-kaisen-dublado$/);
  const s2 = anime.chooseAnime(results, 'Jujutsu Kaisen', 2, 'tv');
  assert.match(s2.url, /jujutsu-kaisen-2-dublado$/);
  assert.equal(anime.chooseAnime(results, 'Outro Anime', 1, 'tv'), null);
});

test('findStream resolve o episódio e prepara o HLS no nó (sem Origin, que o CDN recusa)', async () => {
  anime._reset();
  fallback._reset();
  const s = stubFetch();
  try {
    const r = await anime.findStream({ id: '95479', type: 'tv', season: 1, episode: 1, title: 'Jujutsu Kaisen' });
    assert.ok(r, 'resolver devolveu resultado');
    assert.equal(r.provider, 'AnimesDigital');
    assert.equal(r.url, 'https://node.example/_adshield/media/m/x');
    assert.equal(r.dubbed, true);
    assert.equal(r.isHls, true);

    const prepare = s.calls.find((u) => u.includes('/_adshield/media/prepare'));
    assert.ok(prepare, 'preparou no nó');
    const q = new URL(prepare).searchParams;
    assert.equal(q.get('u'), HLS);
    assert.equal(q.get('r'), 'https://animesdigital.org/');
    assert.equal(q.get('o'), null, 'Origin não pode ir: o CDN responde 403');
  } finally {
    s.restore();
  }
});

test('findStream devolve null para título que não é anime', async () => {
  anime._reset();
  fallback._reset();
  const original = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.themoviedb.org')) {
      return new Response(JSON.stringify({ genres: [{ id: 28 }], origin_country: ['US'], original_language: 'en' }), { status: 200 });
    }
    return new Response('x', { status: 404 });
  };
  try {
    const r = await anime.findStream({ id: '550', type: 'movie', season: 1, episode: 1, title: 'Fight Club' });
    assert.equal(r, null);
  } finally {
    global.fetch = original;
  }
});
