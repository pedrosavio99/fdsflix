import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CAPABILITY, getSecret, handleLive, isPrivateHost, rewriteLive, signLive } from '../lib/liveHls.mjs';

const SECRET = getSecret({});
const NOW = 1_700_000_000_000;
const PLAYLIST_URL = 'http://iptv.example.com:8081/live/canal/index.m3u8';

async function req(url, { exp = NOW + 60_000, sig, route = '/live/hls', range } = {}) {
  const e = exp;
  const s = sig === undefined ? await signLive(url, e, SECRET) : sig;
  const headers = range ? { range } : {};
  return new Request(`https://x.vercel.app${route}?u=${encodeURIComponent(url)}&e=${e}&s=${s}`, { headers });
}

function fetchFrom(map, log = []) {
  return async (url, init) => {
    log.push({ url, init });
    const entry = map[url];
    if (!entry) return new Response('nao', { status: 404 });
    if (entry.redirect) return new Response(null, { status: 302, headers: { location: entry.redirect } });
    return new Response(entry.body, { status: entry.status || 200, headers: entry.headers || {} });
  };
}

test('cap=1 diz que esta Vercel entrega TV ao vivo', async () => {
  const res = await handleLive(new Request('https://x.vercel.app/live/hls?cap=1'), { route: '/live/hls' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ...CAPABILITY, route: '/live/hls' });
});

test('recusa URL sem assinatura, com assinatura errada e vencida', async () => {
  const opts = { now: NOW, fetch: fetchFrom({}) };
  assert.equal((await handleLive(await req(PLAYLIST_URL, { sig: '' }), opts)).status, 403);
  assert.equal((await handleLive(await req(PLAYLIST_URL, { sig: 'x'.repeat(22) }), opts)).status, 403);
  assert.equal((await handleLive(await req(PLAYLIST_URL, { exp: NOW - 1 }), opts)).status, 403);
});

test('a assinatura de uma URL não vale para outra (nem para outra validade)', async () => {
  const sig = await signLive(PLAYLIST_URL, NOW + 60_000, SECRET);
  const other = await req('http://evil.example.com/a.m3u8', { sig });
  assert.equal((await handleLive(other, { now: NOW, fetch: fetchFrom({}) })).status, 403);
  const longer = await req(PLAYLIST_URL, { exp: NOW + 120_000, sig });
  assert.equal((await handleLive(longer, { now: NOW, fetch: fetchFrom({}) })).status, 403);
});

test('não busca hosts locais mesmo com assinatura válida', async () => {
  for (const u of ['http://127.0.0.1/a.m3u8', 'http://localhost:3000/a.m3u8', 'http://10.0.0.5/a.m3u8', 'http://169.254.169.254/latest', 'http://[::1]/a.m3u8']) {
    const log = [];
    const res = await handleLive(await req(u), { now: NOW, fetch: fetchFrom({}, log) });
    assert.equal(res.status, 403, u);
    assert.equal(log.length, 0, u);
  }
  assert.equal(isPrivateHost('8.8.8.8'), false);
  assert.equal(isPrivateHost('iptv.example.com'), false);
});

test('playlist: reescreve variantes, segmentos e chaves com URLs assinadas da mesma rota', async () => {
  const body = [
    '#EXTM3U', '#EXT-X-VERSION:3',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x01',
    '#EXTINF:4.0,', 'seg1.ts?t=1',
    '#EXTINF:4.0,', 'http://outro.example.com:9000/seg2.ts', ''
  ].join('\n');
  const res = await handleLive(await req(PLAYLIST_URL, { route: '/live/np' }), {
    now: NOW, route: '/live/np',
    fetch: fetchFrom({ [PLAYLIST_URL]: { body, headers: { 'content-type': 'application/vnd.apple.mpegurl' } } })
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /mpegurl/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const out = await res.text();
  const lines = out.split('\n');
  const uris = lines.filter((l) => l.startsWith('/live/np?')).concat([...out.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]));
  assert.equal(uris.length, 3);
  assert.ok(uris.every((u) => u.startsWith('/live/np?u=') && /&e=\d+&s=[\w-]{22}$/.test(u)));
  const decoded = uris.map((u) => new URL(u, 'https://x').searchParams.get('u')).sort();
  assert.deepEqual(decoded, [
    'http://iptv.example.com:8081/live/canal/key.bin',
    'http://iptv.example.com:8081/live/canal/seg1.ts?t=1',
    'http://outro.example.com:9000/seg2.ts'
  ]);
  // O que foi assinado na reescrita é aceito de volta pelo proxy.
  const firstSeg = uris.find((u) => /seg1/.test(decodeURIComponent(u)));
  const back = await handleLive(new Request(`https://x.vercel.app${firstSeg}`), {
    now: NOW + 1000, fetch: fetchFrom({ 'http://iptv.example.com:8081/live/canal/seg1.ts?t=1': { body: 'TS', headers: { 'content-type': 'text/html' } } })
  });
  assert.equal(back.status, 200);
  assert.equal(back.headers.get('content-type'), 'video/mp2t');
});

test('segue redirecionamentos (Xtream) e resolve segmentos relativos pela URL final', async () => {
  const start = 'http://panel.example.com:25461/live/u/p/1.m3u8';
  const final = 'http://edge1.example.com/hls/abc/index.m3u8?tk=9';
  const res = await handleLive(await req(start), {
    now: NOW,
    fetch: fetchFrom({
      [start]: { redirect: final },
      [final]: { body: '#EXTM3U\n#EXTINF:4,\nchunk-1.ts\n', headers: { 'content-type': 'application/x-mpegURL' } }
    })
  });
  assert.equal(res.status, 200);
  const line = (await res.text()).split('\n').find((l) => l.startsWith('/live/hls?'));
  assert.equal(new URL(line, 'https://x').searchParams.get('u'), 'http://edge1.example.com/hls/abc/chunk-1.ts');
});

test('redirecionamento para host local é barrado', async () => {
  const start = 'http://panel.example.com/live.m3u8';
  const res = await handleLive(await req(start), {
    now: NOW, fetch: fetchFrom({ [start]: { redirect: 'http://127.0.0.1:8080/secret' } })
  });
  assert.equal(res.status, 403);
});

test('segmento: repassa Range, status 206 e normaliza o tipo', async () => {
  const seg = 'https://cdn.example.com/s/1.ts';
  const log = [];
  const res = await handleLive(await req(seg, { range: 'bytes=0-9' }), {
    now: NOW,
    fetch: fetchFrom({ [seg]: { status: 206, body: '0123456789', headers: { 'content-type': 'text/html', 'content-range': 'bytes 0-9/100' } } }, log)
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), 'video/mp2t');
  assert.equal(res.headers.get('content-range'), 'bytes 0-9/100');
  assert.equal(log[0].init.headers.Range, 'bytes=0-9');
  assert.equal(await res.text(), '0123456789');
});

test('resposta que não é playlist nem HLS válido vira 502; fonte 404 vira 404', async () => {
  const bad = 'http://iptv.example.com/x.m3u8';
  const res = await handleLive(await req(bad), { now: NOW, fetch: fetchFrom({ [bad]: { body: '<html>login</html>', headers: { 'content-type': 'text/html' } } }) });
  assert.equal(res.status, 502);
  const gone = await handleLive(await req(PLAYLIST_URL), { now: NOW, fetch: fetchFrom({}) });
  assert.equal(gone.status, 404);
});

test('rewriteLive ignora esquemas que não são http(s)', async () => {
  const out = await rewriteLive('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="skd://abc"\n', PLAYLIST_URL, '/live/hls', SECRET, NOW);
  assert.match(out, /URI="skd:\/\/abc"/);
});

test('método não permitido e OPTIONS', async () => {
  assert.equal((await handleLive(new Request('https://x/live/hls', { method: 'POST' }))).status, 405);
  assert.equal((await handleLive(new Request('https://x/live/hls', { method: 'OPTIONS' }))).status, 204);
});
