'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cascade = require('../lib/fallbackCascade');

const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n';
const A = 'https://a.example';
const B = 'https://b.example';
const C = 'https://c.example';

/** fetch falso: cada nó responde conforme o roteiro; guarda quem foi chamado. */
function stubFetch(script) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const node = [A, B, C].find((base) => u.startsWith(base));
    const mode = (script[node] || script.default || 'ok');
    if (u.includes('companion') || !node) return new Response('{}', { status: 200 });
    if (u.includes('/vidsrc/stream')) {
      if (typeof mode === 'function') return mode(u, init);
      if (mode === '429') return new Response('{"error":"vs_src HTTP 429"}', { status: 502 });
      if (mode === 'hang') return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' }))));
      if (mode === 'ok') return new Response(JSON.stringify({ ok: true, url: `${node}/master.m3u8`, title: 'Filme', sources: [] }), { status: 200 });
    }
    if (u.endsWith('/master.m3u8')) return new Response(script.masterOk === false ? 'nope' : MASTER, { status: 200 });
    return new Response('x', { status: 404 });
  };
  return { calls, restore: () => { global.fetch = original; } };
}

function withPool(bases, fn) {
  return async () => {
    const saved = process.env.VIDSRC_PROXY_URLS;
    process.env.VIDSRC_PROXY_URLS = bases.join(',');
    cascade._resetVidsrcState();
    try { await fn(); } finally { process.env.VIDSRC_PROXY_URLS = saved; if (saved === undefined) delete process.env.VIDSRC_PROXY_URLS; }
  };
}

const ctx = () => { const notes = []; return { notes, note: (m) => notes.push(m) }; };

test('infraFailure: castiga nó por tempo/rede/429/502-504, não por erro do título', () => {
  for (const why of ['tempo esgotado', 'fetch failed', 'HTTP 429', 'HTTP 502 (vs_src 429)', 'HTTP 504']) assert.equal(cascade.infraFailure(why), true, why);
  for (const why of ['HTTP 404', 'sem stream', 'HTTP 500', 'nenhum espelho tocou']) assert.equal(cascade.infraFailure(why), false, why);
});

test('Vidsrc Proxy: caminho normal usa só o primeiro nó (nada de corrida extra)', withPool([A, B, C], async () => {
  const s = stubFetch({ default: 'ok' });
  try {
    const c = ctx();
    const r = await cascade.tryVidsrcProxy('603', 'movie', 1, 1, 'Matrix', c);
    assert.equal(r.provider, 'Vidsrc');
    const stream = s.calls.filter((u) => u.includes('/vidsrc/stream'));
    assert.equal(stream.length, 1, 'um único nó consultado quando o primeiro responde');
  } finally { s.restore(); }
}));

test('Vidsrc Proxy: o primeiro falha (429) e o seguinte entrega; o nó ruim vai para o fim da fila', withPool([A, B, C], async () => {
  let first = '';
  const s = stubFetch({
    default: (u) => {
      const node = [A, B, C].find((base) => u.startsWith(base));
      if (!first) first = node; // o primeiro nó consultado falha; os outros respondem
      return node === first
        ? new Response('{"error":"vs_src HTTP 429"}', { status: 502 })
        : new Response(JSON.stringify({ ok: true, url: `${node}/master.m3u8`, title: 'Filme', sources: [] }), { status: 200 });
    }
  });
  try {
    const r = await cascade.tryVidsrcProxy('603', 'movie', 1, 1, 'Matrix', ctx());
    assert.ok(r && r.proxyBase !== first, 'entregou por outro nó');
    const reordered = cascade.orderNodes([{ base: A }, { base: B }, { base: C }]);
    assert.equal(reordered[reordered.length - 1], first, 'nó que falhou por 429 foi para o fim');
  } finally { s.restore(); }
}));

test('Vidsrc Proxy: todos falham -> null com RESUMO; depois reaproveita a última extração boa do título', withPool([A, B], async () => {
  let s = stubFetch({ default: 'ok' });
  try {
    const r1 = await cascade.tryVidsrcProxy('7', 'movie', 1, 1, 'X', ctx());
    assert.ok(r1);
  } finally { s.restore(); }

  s = stubFetch({ default: '429' });
  try {
    const c = ctx();
    const none = await cascade.tryVidsrcProxy('8', 'movie', 1, 1, 'Y', c); // título sem histórico
    assert.equal(none, null);
    assert.ok(c.notes.some((n) => /^RESUMO: 2 nó\(s\) tentados · .*429/.test(n)), c.notes.join('\n'));
  } finally { s.restore(); }

  cascade._resetVidsrcState();
  s = stubFetch({ default: 'ok' });
  try { await cascade.tryVidsrcProxy('9', 'movie', 1, 1, 'Z', ctx()); } finally { s.restore(); }
  s = stubFetch({ default: '429' }); // agora o upstream caiu, mas o título 9 tocou há pouco (a master ainda abre)
  try {
    const c = ctx();
    const again = await cascade.tryVidsrcProxy('9', 'movie', 1, 1, 'Z', c);
    assert.ok(again && again.provider === 'Vidsrc', 'reaproveitou a última extração');
    assert.ok(c.notes.some((n) => /reaproveitada a última extração boa/.test(n)));
  } finally { s.restore(); }
}));

test('raceNodes: nó lento não impede o seguinte de entregar depois da primeira falha; perdedores são cancelados', async () => {
  const aborted = [];
  const run = (base, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => { aborted.push(base); resolve(null); }, { once: true });
    if (base === 'n1') setTimeout(() => resolve(null), 10);          // falha rápido
    else if (base === 'n2') { /* fica pendurado */ }
    else if (base === 'n3') setTimeout(() => resolve({ ok: base }), 10);
  });
  const r = await cascade.raceNodes(['n1', 'n2', 'n3'], run, { hedgeMs: 20, deadlineMs: 2000 });
  assert.deepEqual(r, { ok: 'n3' });
  assert.ok(aborted.includes('n2'), 'o nó pendurado foi cancelado');
});

test('raceNodes: sem corrida enquanto o primeiro nó ainda responde (só entra depois de uma falha)', async () => {
  const started = [];
  const run = (base) => new Promise((resolve) => { started.push(base); setTimeout(() => resolve({ ok: base }), 120); });
  const r = await cascade.raceNodes(['n1', 'n2', 'n3'], run, { hedgeMs: 10, deadlineMs: 2000 });
  assert.deepEqual(r, { ok: 'n1' });
  assert.deepEqual(started, ['n1'], 'o primeiro nó teve todo o tempo, sem concorrentes');
});
