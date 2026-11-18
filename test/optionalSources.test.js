'use strict';

// Fontes opcionais (CineWinx / Stream-Winx / Consumet): os adaptadores da cascata prontos para o
// deploy do dono. O teste usa uma API mockada (global.fetch) para provar que o parse de cada um
// funciona — quando o serviço subir, basta apontar a env para a URL pública.

process.env.CINEWINX_API_BASE = 'https://cinewinx.example';
process.env.STREAM_WINX_API_BASE = 'https://streamwinx.example';
process.env.CONSUMET_API_BASE = 'https://consumet.example';
delete process.env.VIDEO_RELAY_URL;
delete process.env.RELAY_URL;
delete process.env.SM_RELAY;

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryCineWinx, tryStreamWinx, tryConsumet } = require('../lib/fallbackCascade');

function stubFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

test('tryCineWinx lê streamUrl (série)', async () => {
  const restore = stubFetch(async (url) => {
    if (String(url).includes('/series/1399/seasons/1/episodes/1')) {
      return new Response(JSON.stringify({ streamUrl: 'https://cdn.example/got.m3u8', quality: '720' }), { status: 200 });
    }
    return new Response('x', { status: 404 });
  });
  try {
    const r = await tryCineWinx('1399', 'tv', 1, 1, 'Game of Thrones');
    assert.ok(r);
    assert.equal(r.url, 'https://cdn.example/got.m3u8');
    assert.equal(r.provider, 'CineWinx (Telegram)');
    assert.equal(r.isHls, true);
    assert.equal(r.quality, '720');
  } finally {
    restore();
  }
});

test('tryStreamWinx lê url (série)', async () => {
  const restore = stubFetch(async (url) => {
    if (String(url).includes('/stream/tv/1399/1/1')) {
      return new Response(JSON.stringify({ url: 'https://cdn.example/got.mp4' }), { status: 200 });
    }
    return new Response('x', { status: 404 });
  });
  try {
    const r = await tryStreamWinx('1399', 'tv', 1, 1, 'Game of Thrones');
    assert.ok(r);
    assert.equal(r.url, 'https://cdn.example/got.mp4');
    assert.equal(r.provider, 'Stream-Winx');
    assert.equal(r.isHls, false);
  } finally {
    restore();
  }
});

test('tryConsumet resolve meta/tmdb/info → watch (anime)', async () => {
  const calls = [];
  const restore = stubFetch(async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/meta/tmdb/info/12971')) {
      return new Response(JSON.stringify({ id: 12971, episodes: [{ id: 'ep1', season: 1, number: 1 }] }), { status: 200 });
    }
    if (u.includes('/meta/tmdb/watch/ep1')) {
      return new Response(JSON.stringify({
        sources: [{ url: 'https://cdn.example/dbz.m3u8', quality: '1080' }],
        subtitles: []
      }), { status: 200 });
    }
    return new Response('x', { status: 404 });
  });
  try {
    const r = await tryConsumet('12971', 'tv', 1, 1, 'Dragon Ball Z');
    assert.ok(r);
    assert.equal(r.url, 'https://cdn.example/dbz.m3u8');
    assert.match(r.provider, /Consumet/);
    assert.equal(r.isHls, true);
    assert.ok(calls.some((c) => c.includes('/meta/tmdb/info/')));
    assert.ok(calls.some((c) => c.includes('/meta/tmdb/watch/')));
  } finally {
    restore();
  }
});
