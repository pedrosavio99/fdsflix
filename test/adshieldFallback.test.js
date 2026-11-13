'use strict';

/**
 * AdFallback: rodízio dos nós que entregam a mídia fora do Render.
 * O nó é externo; aqui se confere a escolha do nó (folga, cooldown), o contrato HTTP e o contador
 * que o navegador alimenta. Sem rede de verdade (fetch é substituído).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const USAGE_FILE = path.join(os.tmpdir(), `fdsflix-fallback-${process.pid}.json`);
process.env.ADSHIELD_FALLBACK_FILE = USAGE_FILE;

const fallback = require('../lib/adshieldFallback');

const NODE_A = 'https://node-a.example';
const NODE_B = 'https://node-b.example';
const NODE_C = 'https://node-c.example';
const GB = 1024 ** 3;
const MB = 1024 ** 2;

function stubFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = original;
  };
}

function resetEnv() {
  delete process.env.ADSHIELD_FALLBACK_URLS;
  delete process.env.ADSHIELD_FALLBACK_BASE_URL;
  delete process.env.ADSHIELD_FALLBACK_KEY;
  delete process.env.ADSHIELD_FALLBACK;
  delete process.env.ADSHIELD_FALLBACK_QUOTAS;
  delete process.env.ADSHIELD_FALLBACK_QUOTA_GB;
  delete process.env.VIDSRC_PROXY_URLS;
  delete process.env.VIDSRC_PROXY_URL;
  delete process.env.RENDER_EXTERNAL_URL;
  fallback._reset();
  try { fs.unlinkSync(USAGE_FILE); } catch (error) { /* sem arquivo */ }
}

function okResponse(node, kind = 'hls') {
  return new Response(
    JSON.stringify({ ok: true, kind, url: `${node}/_adshield/media/m/token`, contentType: 'application/vnd.apple.mpegurl' }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

test('sem ADSHIELD_FALLBACK_URLS fica desligado e não chama nada', async () => {
  resetEnv();
  let called = 0;
  const restore = stubFetch(async () => {
    called += 1;
    return okResponse(NODE_A);
  });
  try {
    assert.equal(fallback.isEnabled(), false);
    const result = await fallback.prepare({ url: 'https://cdn.example/a.m3u8' });
    assert.equal(result.ok, false);
    assert.equal(called, 0);
  } finally {
    restore();
  }
});

test('ADSHIELD_FALLBACK_BASE_URL (uma URL) continua funcionando', async () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_BASE_URL = NODE_A;
  assert.equal(fallback.isEnabled(), true);
  assert.deepEqual(fallback.nodes(), [NODE_A]);
  resetEnv();
});

test('ADSHIELD_FALLBACK=0 desliga mesmo com nós definidos', async () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = `${NODE_A},${NODE_B}`;
  process.env.ADSHIELD_FALLBACK = '0';
  assert.equal(fallback.isEnabled(), false);
  resetEnv();
});

test('nó que aponta para o próprio Render é recusado (não gasta a banda dele)', () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = NODE_A;
  process.env.RENDER_EXTERNAL_URL = NODE_A;
  assert.equal(fallback.isEnabled(), false);
  resetEnv();
});

test('rodízio: o nó com mais folga é o primeiro', () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = `${NODE_A},${NODE_B},${NODE_C}`;
  try {
    fallback.record(NODE_A, 300 * MB);   // A já gastou 300 MB
    fallback.record(NODE_C, 600 * MB);   // C gastou 600 MB
    const order = fallback.order();
    assert.equal(order[0], NODE_B, 'B está zerado: deve ser o primeiro');
    assert.equal(order[2], NODE_C, 'C é o que gastou mais');
  } finally {
    resetEnv();
  }
});

test('empate de folga: o rodízio alterna o primeiro nó (round-robin)', () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = `${NODE_A},${NODE_B}`;
  try {
    const first = fallback.order()[0];
    const second = fallback.order()[0];
    assert.notEqual(first, second, 'com todos zerados, cada chamada deve começar num nó');
    assert.deepEqual([first, second].sort(), [NODE_A, NODE_B].sort());
  } finally {
    resetEnv();
  }
});

test('prepare escolhe o nó de mais folga e devolve o nó usado', async () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = `${NODE_A},${NODE_B}`;
  process.env.ADSHIELD_FALLBACK_KEY = 'segredo';
  fallback.record(NODE_A, 300 * MB); // A já gastou algo; B está zerado
  const calls = [];
  const restore = stubFetch(async (url, init) => {
    calls.push({ url: String(url), headers: init && init.headers });
    return okResponse(NODE_B);
  });
  try {
    const result = await fallback.prepare({ url: 'https://cdn.example/filme.mp4' });
    assert.equal(result.ok, true);
    assert.equal(result.node, NODE_B);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/node-b\.example\/_adshield\/media\/prepare\?/);
    assert.equal(calls[0].headers['x-media-key'], 'segredo');
  } finally {
    restore();
    resetEnv();
  }
});

test('nó que falha por infraestrutura vai para o fim (cooldown) e o próximo entrega', async () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = `${NODE_A},${NODE_B}`;
  fallback.record(NODE_A, 600 * MB); // força B primeiro (0,6 % × 0)
  const restore = stubFetch(async (url) => {
    if (String(url).startsWith(NODE_B)) return new Response('{"ok":false,"error":"boom"}', { status: 503 });
    return okResponse(NODE_A);
  });
  try {
    const first = await fallback.prepare({ url: 'https://cdn.example/a.m3u8' });
    assert.equal(first.ok, true);
    assert.equal(first.node, NODE_A);

    const snap = fallback.snapshot();
    const nodeB = snap.nodes.find((n) => n.base === NODE_B);
    assert.equal(nodeB.cooling, true, 'o nó que deu 503 deve estar em cooldown');
    assert.equal(fallback.order()[0], NODE_A);
  } finally {
    restore();
    resetEnv();
  }
});

test('erro do título (415) não castiga o nó, mas tenta o próximo', async () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = `${NODE_A},${NODE_B}`;
  fallback.record(NODE_A, 600 * MB);
  const restore = stubFetch(async (url) => {
    if (String(url).startsWith(NODE_B)) {
      return new Response('{"ok":false,"error":"é HTML"}', { status: 415 });
    }
    return okResponse(NODE_A, 'file');
  });
  try {
    const result = await fallback.prepare({ url: 'https://cdn.example/pagina.html' });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'file');
    const nodeB = fallback.snapshot().nodes.find((n) => n.base === NODE_B);
    assert.equal(nodeB.cooling, false, '415 não é falha de infraestrutura');
  } finally {
    restore();
    resetEnv();
  }
});

test('prepare repassa Referer/Origin/UA do perfil da ponte', async () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = NODE_A;
  let seen = null;
  const restore = stubFetch(async (url) => {
    seen = new URL(String(url));
    return okResponse(NODE_A);
  });
  try {
    await fallback.prepare({
      url: 'https://cdn.example/a.m3u8',
      headers: { Referer: 'https://animefire.example/', Origin: 'https://animefire.example', 'User-Agent': 'UA/1.0' }
    });
    assert.equal(seen.searchParams.get('r'), 'https://animefire.example/');
    assert.equal(seen.searchParams.get('o'), 'https://animefire.example');
    assert.equal(seen.searchParams.get('a'), 'UA/1.0');
  } finally {
    restore();
    resetEnv();
  }
});

test('preparo repetido usa o cache (o filme inteiro fica no mesmo nó)', async () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = `${NODE_A},${NODE_B}`;
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return okResponse(NODE_A);
  });
  try {
    const first = await fallback.prepare({ url: 'https://cdn.example/a.m3u8' });
    const second = await fallback.prepare({ url: 'https://cdn.example/a.m3u8' });
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
  } finally {
    restore();
    resetEnv();
  }
});

test('contador: aceita só nós configurados e soma por nó', () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = `${NODE_A},${NODE_B}`;
  try {
    assert.equal(fallback.record(NODE_A, 200 * MB).ok, true);
    assert.equal(fallback.record('https://intruso.example', 50 * MB).ok, false);
    assert.equal(fallback.record(NODE_A, -5).ok, false);
    assert.equal(fallback.usedBytes(NODE_A), 200 * MB);

    const snap = fallback.snapshot();
    assert.equal(snap.count, 2);
    assert.equal(snap.totalUsedGb, 0.195);
    const nodeA = snap.nodes.find((n) => n.base === NODE_A);
    assert.equal(nodeA.quotaGb, 100);
    assert.equal(nodeA.usedPct, 0.2);
  } finally {
    resetEnv();
  }
});

test('cota por nó (Wasmer): ADSHIELD_FALLBACK_QUOTAS=URL=GB', () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = `${NODE_A},${NODE_B}`;
  process.env.ADSHIELD_FALLBACK_QUOTAS = `${NODE_B}=150`;
  try {
    assert.equal(fallback.quotaGb(NODE_A), 100);
    assert.equal(fallback.quotaGb(NODE_B), 150);
  } finally {
    resetEnv();
  }
});

test('nó de build antigo (404 no /media/prepare) sem Referer é pulado e memorizado', async () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = 'https://legacy.example';
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return new Response('{"ok":false,"error":"MEDIA_PROXY desligado neste nó"}', {
      status: 404,
      headers: { 'content-type': 'application/json' }
    });
  });
  try {
    const first = await fallback.prepare({ url: 'https://cdn.example/a.mp4' });
    assert.equal(first.ok, false);
    assert.equal(calls, 1);
    const second = await fallback.prepare({ url: 'https://cdn.example/b.mp4' });
    assert.equal(second.ok, false);
    assert.equal(calls, 1, 'nó antigo não é chamado de novo quando a fonte não tem Referer');
  } finally {
    restore();
    resetEnv();
  }
});

test('nó antigo + fonte com Referer: usa o compat (/_adshield/r/<token>) sem tocar no Render', async () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = 'https://legacy.example';
  const seen = [];
  const restore = stubFetch(async (url, init) => {
    seen.push({ url: String(url), method: (init && init.method) || 'GET' });
    if (String(url).includes('/_adshield/media/prepare')) return new Response('{}', { status: 404 });
    if ((init && init.method) === 'HEAD') {
      return new Response('', { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
    }
    return new Response('', { status: 200 });
  });
  try {
    const out = await fallback.prepare({
      url: 'https://cdn.example/a.m3u8',
      headers: { Referer: 'https://site.example/' }
    });
    assert.equal(out.ok, true);
    assert.equal(out.compat, true);
    assert.equal(out.kind, 'hls');
    assert.match(out.url, /^https:\/\/legacy\.example\/_adshield\/r\//);
    assert.ok(seen.some((call) => call.method === 'HEAD'), 'confirmou com HEAD antes de entregar');
  } finally {
    restore();
    resetEnv();
  }
});

test('compat exige Referer (fonte sem perfil de ponte não tenta)', async () => {
  const out = await fallback.compatPrepare('https://legacy.example', { url: 'https://cdn.example/a.m3u8' });
  assert.equal(out.ok, false);
  assert.equal(out.compat, true);
  assert.match(out.error, /Referer/i);
});

test('nó antigo não consome o limite de tentativas: o nó novo ainda é alcançado', async () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = 'https://legacy.example,https://novo.example';
  process.env.ADSHIELD_FALLBACK_MAX_NODES = '1';
  const restore = stubFetch(async (url) => {
    if (String(url).startsWith('https://legacy.example')) {
      return new Response('{"ok":false,"error":"MEDIA_PROXY desligado neste nó"}', {
        status: 404,
        headers: { 'content-type': 'application/json' }
      });
    }
    return okResponse('https://novo.example');
  });
  try {
    const out = await fallback.prepare({ url: 'https://cdn.example/filme.mp4' });
    assert.equal(out.ok, true);
    assert.equal(out.node, 'https://novo.example');
  } finally {
    restore();
    delete process.env.ADSHIELD_FALLBACK_MAX_NODES;
    resetEnv();
  }
});


test('herda os nós do pool do Vidsrc automaticamente (nada para cadastrar à mão)', () => {
  resetEnv();
  process.env.ADSHIELD_FALLBACK_URLS = 'https://novo.example';
  process.env.VIDSRC_PROXY_URLS = 'https://a.wasmer.app,https://novo.example,https://b.vercel.app';
  try {
    assert.deepEqual(fallback.nodes(), ['https://novo.example', 'https://a.wasmer.app', 'https://b.vercel.app']);
  } finally {
    resetEnv();
  }
});

test('com só o pool do Vidsrc configurado, o AdFallback já fica ativo (herança)', () => {
  resetEnv();
  process.env.VIDSRC_PROXY_URLS = 'https://a.wasmer.app';
  try {
    assert.equal(fallback.isEnabled(), true);
    assert.deepEqual(fallback.nodes(), ['https://a.wasmer.app']);
  } finally {
    resetEnv();
  }
});
