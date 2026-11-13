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
    const node = [A, B, C, W1, W2, W3, V1].find((base) => u.startsWith(base));
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
      const node = [A, B, C, W1, W2, W3, V1].find((base) => u.startsWith(base));
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

const W1 = 'https://w1.wasmer.app';
const W2 = 'https://w2.wasmer.app';
const W3 = 'https://w3.wasmer.app';
const W4 = 'https://w4.wasmer.app';
const V1 = 'https://v1.vercel.app';
const V2 = 'https://v2.vercel.app';

test('orderNodes alterna famílias: 6 tentativas não podem ser todas do mesmo provedor', () => {
  const pool = [W1, W2, W3, W4, V1, V2].map((base) => ({ base }));
  const order = cascade.orderNodes(pool);
  assert.equal(order.length, 6);
  assert.notEqual(cascade.familyOf(order[0]), cascade.familyOf(order[1]), 'as duas primeiras de famílias diferentes');
  const firstFour = order.slice(0, 4).map(cascade.familyOf);
  assert.equal(new Set(firstFour).size, 2, 'as 4 primeiras misturam as duas famílias');
  assert.equal(firstFour.filter((f) => f === 'wasmer.app').length, 2);
});

test('família que falhou (possível bloqueio de faixa) vai para o fim do rodízio', withPool([W1, W2], async () => {
  // Só os Wasmers na pool: todos falham com 502 (extrator). A família inteira fica marcada.
  const s = stubFetch({ default: () => new Response('{"ok":false,"error":"CONFIG/apiToken ausente"}', { status: 502 }) });
  try {
    const r = await cascade.tryVidsrcProxy('603', 'movie', 1, 1, 'Matrix', ctx());
    assert.equal(r, null);
    assert.equal(cascade.familyCooling('wasmer.app'), true);
    assert.equal(cascade.familyCooling('vercel.app'), false);
  } finally {
    s.restore();
  }

  // W3 nunca foi tentado (não está em cooldown de nó), mas a família dele falhou: deve ir para o fim.
  const order = cascade.orderNodes([{ base: W3 }, { base: V1 }]);
  assert.deepEqual(order, [V1, W3]);
  cascade._resetVidsrcState();
}));

test('rodízio de chamadas: o nó menos chamado vai na frente e a chamada conta', () => {
  cascade._resetVidsrcState();
  const pool = [A, B, C].map((base) => ({ base, usedPct: 0 }));
  cascade.markNodeCall(A);
  cascade.markNodeCall(A);
  cascade.markNodeCall(B);
  assert.equal(cascade.callsInWindow(A), 2);
  assert.deepEqual(cascade.orderNodes(pool), [C, B, A], 'C (0 chamadas) primeiro, A (2) por último');
  cascade._resetVidsrcState();
});

test('rodízio de chamadas: duas extrações seguidas não batem no mesmo nó', withPool([A, B, C], async () => {
  const s = stubFetch({ default: 'ok' });
  try {
    const first = await cascade.tryVidsrcProxy('101', 'movie', 1, 1, 'Um', ctx());
    const second = await cascade.tryVidsrcProxy('102', 'movie', 1, 1, 'Dois', ctx());
    assert.ok(first && second);
    assert.notEqual(first.proxyBase, second.proxyBase, 'a segunda extração foi para outro IP');
    assert.equal(cascade.callsInWindow(first.proxyBase), 1);
    assert.equal(cascade.callsInWindow(second.proxyBase), 1);
  } finally {
    s.restore();
    cascade._resetVidsrcState();
  }
}));

test('mesmo título em menos de 8 min reusa o nó (cache do nó) em vez de rotacionar', withPool([A, B, C], async () => {
  const s = stubFetch({ default: 'ok' });
  try {
    const first = await cascade.tryVidsrcProxy('999', 'movie', 1, 1, 'Mesmo', ctx());
    const again = await cascade.tryVidsrcProxy('999', 'movie', 1, 1, 'Mesmo', ctx());
    assert.equal(again.proxyBase, first.proxyBase, 'mesmo título voltou no mesmo nó (sem nova cadeia no Vidsrc)');
  } finally {
    s.restore();
    cascade._resetVidsrcState();
  }
}));

test('disjuntor: erro sistêmico em 2+ nós abre o disjuntor e o próximo pedido nem chama a pool', withPool([A, B, C], async () => {
  cascade._resetVidsrcState();
  let s = stubFetch({
    default: () => new Response('{"ok":false,"error":"CONFIG/apiToken ausente"}', { status: 502 })
  });
  try {
    const c = ctx();
    const none = await cascade.tryVidsrcProxy('603', 'movie', 1, 1, 'X', c);
    assert.equal(none, null);
    assert.equal(cascade.breakerOpen(), true, 'disjuntor abriu com o mesmo erro em vários nós');
    assert.match(cascade.breakerState().reason, /CONFIG\/apiToken ausente/);
    assert.ok(c.notes.some((n) => /DISJUNTOR ABERTO por \d+ min/.test(n)), c.notes.join('\n'));
    // o RESUMO agora carrega o motivo real, não só o HTTP
    assert.ok(c.notes.some((n) => /HTTP 502: CONFIG\/apiToken ausente ×\d/.test(n)), c.notes.join('\n'));
  } finally { s.restore(); }

  // Com o disjuntor aberto, NENHUMA chamada sai: o pedido cai direto no próximo provedor.
  s = stubFetch({ default: 'ok' });
  try {
    const c = ctx();
    const none = await cascade.tryVidsrcProxy('604', 'movie', 1, 1, 'Y', c);
    assert.equal(none, null);
    assert.equal(s.calls.length, 0, 'não gastou nenhuma requisição com o disjuntor aberto');
    assert.ok(c.notes.some((n) => /DISJUNTOR ABERTO: .*Vidsrc pulado até/.test(n)));
  } finally { s.restore(); cascade._resetVidsrcState(); }
}));

test('saúde do Vidsrc: conta sucessos e falhas por nó e mostra o disjuntor', withPool([A, B], async () => {
  cascade._resetVidsrcState();
  let s = stubFetch({ default: 'ok' });
  try {
    await cascade.tryVidsrcProxy('700', 'movie', 1, 1, 'Bom', ctx());
  } finally { s.restore(); }

  s = stubFetch({ default: () => new Response('{"ok":false,"error":"embed HTTP 403"}', { status: 502 }) });
  try {
    await cascade.tryVidsrcProxy('701', 'movie', 1, 1, 'Ruim', ctx());
  } finally { s.restore(); }

  const health = cascade.vidsrcHealth();
  const byHost = Object.fromEntries(health.nodes.map((n) => [n.host, n]));
  const okNode = Object.values(byHost).find((n) => n.ok > 0);
  const failNode = Object.values(byHost).find((n) => n.fail > 0);
  assert.ok(okNode && okNode.ok >= 1);
  assert.ok(failNode && failNode.fail >= 1);
  assert.match(failNode.lastError, /embed HTTP 403/);
  assert.ok(failNode.consecutiveFailures >= 1, 'conta falhas seguidas');
  assert.equal(health.breaker.open, true);
  cascade._resetVidsrcState();
}));

test('disjuntor: reabrir sem sucesso entre as janelas dobra o tempo (5 → 10 → 20 → 30)', () => {
  cascade._resetVidsrcState();
  const reason = 'CONFIG/apiToken ausente';
  cascade.openBreaker(reason);
  assert.equal(cascade.breakerState().windowMinutes, 5);
  cascade.openBreaker(reason);
  assert.equal(cascade.breakerState().windowMinutes, 10);
  cascade.openBreaker(reason);
  assert.equal(cascade.breakerState().windowMinutes, 20);
  cascade.openBreaker(reason);
  assert.equal(cascade.breakerState().windowMinutes, 30, 'teto de 30 min');
  cascade.closeBreaker();
  assert.equal(cascade.breakerState().open, false);
  cascade.openBreaker(reason);
  assert.equal(cascade.breakerState().windowMinutes, 5, 'depois de um sucesso, volta à janela base');
  cascade._resetVidsrcState();
});
