'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const vixsrc = require('../lib/vixsrc');
const fallback = require('../lib/adshieldFallback');

const NODE = 'https://node.example';
const KEY = 'media-key';
const MASTER = 'https://vixsrc.to/playlist/123?ub=1&token=tok123&expires=1800147000&h=1&lang=en';

const EMBED = `<html><body><script>
window.streams = [{"name":"Server1","active":true,"url":"https://vixsrc.to/playlist/123?ub=1"},{"name":"Server2","active":false,"url":"https://vixsrc.to/playlist/123?ab=1"}];
window.masterPlaylist = {
    params: {
        'token': 'tok123',
        'expires': '1800147000',
        'asn': '',
    },
    url: 'https://vixsrc.to/playlist/123',
}
</script></body></html>`;

/** fetch falso: o nó responde o /api, o /embed e o prepare; decodifica o token assinado. */
function stubFetch({ noSrc = false } = {}) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith(`${NODE}/_adshield/r/`)) {
      const token = u.slice(`${NODE}/_adshield/r/`.length);
      const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
      const target = payload.u;
      if (target.endsWith('/api/movie/603')) {
        return new Response(JSON.stringify(noSrc ? {} : { src: '/embed/123?token=abc&expires=999' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (target.includes('/embed/123')) {
        return new Response(EMBED, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('x', { status: 404 });
    }
    if (u.startsWith(`${NODE}/_adshield/media/prepare`)) {
      return new Response(JSON.stringify({
        ok: true,
        kind: 'hls',
        url: `${NODE}/_adshield/media/m/signed`,
        contentType: 'application/vnd.apple.mpegurl'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('x', { status: 404 });
  };
  return { calls, restore: () => { global.fetch = original; } };
}

function withFallback(fn) {
  return async () => {
    const saved = {
      urls: process.env.ADSHIELD_FALLBACK_URLS,
      key: process.env.ADSHIELD_FALLBACK_KEY,
      off: process.env.ADSHIELD_FALLBACK
    };
    process.env.ADSHIELD_FALLBACK_URLS = NODE;
    process.env.ADSHIELD_FALLBACK_KEY = KEY;
    delete process.env.ADSHIELD_FALLBACK;
    vixsrc._reset();
    fallback._reset();
    try {
      await fn();
    } finally {
      for (const [name, value] of [['ADSHIELD_FALLBACK_URLS', saved.urls], ['ADSHIELD_FALLBACK_KEY', saved.key]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (saved.off === undefined) delete process.env.ADSHIELD_FALLBACK;
      else process.env.ADSHIELD_FALLBACK = saved.off;
    }
  };
}

test('parseEmbed monta a master com token/expires/h/lang (sem eles o VixSrc dá 403)', () => {
  assert.equal(vixsrc.parseEmbed(EMBED), MASTER);
  assert.equal(vixsrc.parseEmbed('<html>nada</html>'), null);
  assert.equal(vixsrc.parseEmbed('<script>window.streams = [];</script>'), null);
});

test('apiPath separa filme de série', () => {
  assert.equal(vixsrc.apiPath('movie', '603'), '/api/movie/603');
  assert.equal(vixsrc.apiPath('tv', '1399', 2, 3), '/api/tv/1399/2/3');
});

test('resolveVixSrc usa o MESMO nó para resolver e preparar a mídia', withFallback(async () => {
  const s = stubFetch();
  try {
    const r = await vixsrc.resolveVixSrc({ id: '603', type: 'movie' });
    assert.ok(r, 'resolver devolveu resultado');
    assert.equal(r.provider, 'VixSrc');
    assert.equal(r.url, `${NODE}/_adshield/media/m/signed`);
    assert.equal(r.proxyBase, NODE);
    assert.equal(r.isHls, true);

    const api = s.calls.find((u) => {
      if (!u.includes('/_adshield/r/')) return false;
      const token = u.slice(`${NODE}/_adshield/r/`.length);
      const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
      return payload.u.endsWith('/api/movie/603');
    });
    assert.ok(api, 'buscou o /api pelo nó');
    const prepare = s.calls.find((u) => u.includes('/_adshield/media/prepare'));
    assert.ok(prepare, 'preparou a mídia no nó');
    assert.equal(new URL(prepare).searchParams.get('u'), MASTER, 'a master foi para o nó que a resolveu');
    assert.equal(new URL(prepare).searchParams.get('r'), 'https://vixsrc.to/');
  } finally { s.restore(); }
}));

test('resolveVixSrc devolve null quando o título não está no catálogo', withFallback(async () => {
  const s = stubFetch({ noSrc: true });
  try {
    const notes = [];
    const r = await vixsrc.resolveVixSrc({ id: '603', type: 'movie', note: (m) => notes.push(m) });
    assert.equal(r, null);
    assert.ok(notes.some((n) => /sem src/.test(n)), notes.join('\n'));
  } finally { s.restore(); }
}));

test('resolveVixSrc devolve null sem AdFallback configurado (nada muda)', async () => {
  const saved = process.env.ADSHIELD_FALLBACK_URLS;
  delete process.env.ADSHIELD_FALLBACK_URLS;
  delete process.env.ADSHIELD_FALLBACK_BASE_URL;
  delete process.env.VIDSRC_PROXY_URLS;
  delete process.env.VIDSRC_PROXY_URL;
  vixsrc._reset();
  try {
    assert.equal(await vixsrc.resolveVixSrc({ id: '603', type: 'movie' }), null);
  } finally {
    if (saved !== undefined) process.env.ADSHIELD_FALLBACK_URLS = saved;
  }
});

test('cache: a segunda resolução não bate no nó de novo', withFallback(async () => {
  const s = stubFetch();
  try {
    const first = await vixsrc.resolveVixSrc({ id: '603', type: 'movie' });
    const callsAfterFirst = s.calls.length;
    const second = await vixsrc.resolveVixSrc({ id: '603', type: 'movie' });
    assert.deepEqual(second, first);
    assert.equal(s.calls.length, callsAfterFirst, 'cache evitou novas chamadas');
  } finally { s.restore(); }
}));
