'use strict';

// Cascata em paralelo: tempo = o da fonte mais lenta que importa (não a soma), prioridade respeitada,
// fonte pesada só entra se as leves não entregarem, e "sem resultado" recente é lembrado.

const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');

const cascade = require('../lib/fallbackCascade');
const providerMiss = require('../lib/providerMiss');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hit = (name, ms, extra = {}) => ({ name, fn: async () => { await wait(ms); return { url: `https://x/${name}.mp4`, ...extra }; } });
const nada = (name, ms) => ({ name, fn: async () => { await wait(ms); return null; } });
let n = 0;
const args = (over = {}) => ({ id: String(++n), type: 'movie', title: 't', trace: [], ...over });

beforeEach(() => providerMiss.clear());
after(() => cascade._setProviders(null));

test('soma virou máximo: 3 fontes de 300 ms sem resultado + uma boa de 100 ms entrega em ~0,4 s', async () => {
  cascade._setProviders([nada('A', 300), nada('B', 300), nada('C', 300), hit('D', 100)]);
  const t = Date.now();
  const r = await cascade.getFallbackStream(args());
  assert.equal(r.provider, 'D');
  assert.ok(Date.now() - t < 700, `levou ${Date.now() - t} ms`); // em série seriam ~1000 ms
});

test('prioridade: a primeira da lista vence se chegar dentro da tolerância', async () => {
  cascade._setProviders([hit('Alta', 400), hit('Baixa', 50)]);
  const r = await cascade.getFallbackStream(args());
  assert.equal(r.provider, 'Alta');
});

test('fonte de prioridade maior que trava não segura as outras para sempre', async () => {
  cascade._setProviders([{ name: 'Trava', fn: () => new Promise(() => {}) }, hit('Boa', 50)]);
  const t = Date.now();
  const r = await cascade.getFallbackStream(args());
  assert.equal(r.provider, 'Boa');
  const ms = Date.now() - t;
  assert.ok(ms >= 2800 && ms < 4500, `levou ${ms} ms (esperado ~3 s de tolerância)`);
});

test('fonte pesada não parte se uma leve entrega logo', async () => {
  let heavyRan = false;
  cascade._setProviders([hit('Leve', 50), { name: 'CinePro', fn: async () => { heavyRan = true; return null; } }]);
  const r = await cascade.getFallbackStream(args());
  assert.equal(r.provider, 'Leve');
  await wait(50);
  assert.equal(heavyRan, false);
});

test('pesada entra quando as leves acabam sem nada', async () => {
  cascade._setProviders([nada('Leve', 20), hit('CinePro', 20)]);
  const r = await cascade.getFallbackStream(args());
  assert.equal(r.provider, 'CinePro');
});

test('tudo sem resultado => null; erro de uma fonte não derruba as outras', async () => {
  cascade._setProviders([{ name: 'Quebra', fn: async () => { throw new Error('boom'); } }, nada('B', 10)]);
  const a = args();
  assert.equal(await cascade.getFallbackStream(a), null);
  assert.equal(a.trace.find((t) => t.provider === 'Quebra').outcome, 'erro');
});

test('"sem resultado" recente é pulado na próxima busca, e fresh ignora a memória', async () => {
  let calls = 0;
  cascade._setProviders([{ name: 'Vazia', fn: async () => { calls += 1; return null; } }]);
  const a = args();
  await cascade.getFallbackStream(a);
  await cascade.getFallbackStream({ ...a, trace: [] });
  assert.equal(calls, 1);
  await cascade.getFallbackStream({ ...a, trace: [], fresh: true });
  assert.equal(calls, 2);
});

test('skip respeita a lista e o trace registra o vencedor como USADO', async () => {
  cascade._setProviders([hit('Pula', 10), hit('Fica', 10)]);
  const a = args({ skip: ['Pula'] });
  const r = await cascade.getFallbackStream(a);
  assert.equal(r.provider, 'Fica');
  assert.equal(a.trace.find((t) => t.provider === 'Fica').outcome, 'USADO');
});
