'use strict';

// VidLink: lançamentos que o provedor indexa pelo IMDB (não pelo TMDB).
// "A Odisseia" (TMDB 1368337) devolve null; com tt33764258 devolve o stream. O fallback
// busca o id externo no TMDB e repete a chamada — sem isso o título some da cascata.

process.env.TMDB_API_KEY = 'test-key';
process.env.VIDLINK_IMDB_FALLBACK = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getVidLinkStream } = require('../lib/streamExtractor');

const STREAM = {
  sourceId: 'mwVault',
  stream: {
    id: 'primary',
    type: 'file',
    qualities: {
      720: { type: 'mp4', url: 'https://cdn.example/x.mp4', codecName: 'h264' }
    }
  }
};

/** fetch falso: a 1ª chamada ao VidLink devolve null; a 2ª (com o id do IMDB) devolve o stream. */
function stubFetch() {
  const calls = [];
  let vidlink = 0;
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('api.themoviedb.org') && u.includes('/external_ids')) {
      return new Response(JSON.stringify({ imdb_id: 'tt999' }), { status: 200 });
    }
    if (u.includes('vidlink.pro')) {
      vidlink += 1;
      if (vidlink === 1) return new Response('null', { status: 200 });
      return new Response(JSON.stringify(STREAM), { status: 200 });
    }
    return new Response('x', { status: 404 });
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test('VidLink: sem resultado no id do TMDB, tenta o IMDB do TMDB e entrega', async () => {
  const s = stubFetch();
  try {
    const r = await getVidLinkStream({ id: '999001', type: 'movie', season: 1, episode: 1 });
    assert.ok(r, 'entregou o stream pelo IMDB');
    assert.equal(r.quality, '720');
    assert.equal(r.url, 'https://cdn.example/x.mp4');
    assert.ok(s.calls.some((u) => u.includes('/movie/999001/external_ids')), 'buscou o id externo');
    assert.equal(s.calls.filter((u) => u.includes('vidlink.pro')).length, 2, 'duas chamadas: TMDB e IMDB');
  } finally {
    s.restore();
  }
});

test('VidLink: com VIDLINK_IMDB_FALLBACK=0 não busca o id externo', async () => {
  const saved = process.env.VIDLINK_IMDB_FALLBACK;
  process.env.VIDLINK_IMDB_FALLBACK = '0';
  const s = stubFetch();
  try {
    const r = await getVidLinkStream({ id: '999002', type: 'movie', season: 1, episode: 1 });
    assert.equal(r, null);
    assert.ok(!s.calls.some((u) => u.includes('/external_ids')), 'não buscou o TMDB');
  } finally {
    s.restore();
    if (saved === undefined) delete process.env.VIDLINK_IMDB_FALLBACK;
    else process.env.VIDLINK_IMDB_FALLBACK = saved;
  }
});
