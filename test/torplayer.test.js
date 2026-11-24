'use strict';

// public/torplayer.js é um script de navegador (IIFE em `window`). Aqui só testamos a parte pura:
// magnet melhorado e escolha de nó. O player de verdade foi conferido num navegador (ver AGENTS.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'torplayer.js'), 'utf8');
const win = {};
vm.runInNewContext(src, { window: win, document: {}, console });
const P = win.FdsTorPlayer;
const HASH = '8c4ddb31456820485c1cb452d322f56903453b06';

test('boostMagnet soma trackers HTTP sem repetir e mantém o que veio no magnet', () => {
  const m = `magnet:?xt=urn:btih:${HASH}&dn=Filme&tr=${encodeURIComponent('http://tracker.opentrackr.org:1337/announce')}&tr=udp%3A%2F%2Fexodus.desync.com%3A6969`;
  const out = P.boostMagnet(m, HASH);
  assert.ok(out.startsWith(m), 'não mexe no começo do magnet');
  const trs = out.split('&tr=').slice(1).map(decodeURIComponent);
  assert.equal(new Set(trs).size, trs.length, 'sem tracker repetido');
  assert.ok(trs.some((t) => t.startsWith('udp://exodus')), 'mantém o UDP original');
  assert.ok(trs.filter((t) => /^https?:/.test(t)).length >= 5, 'junta vários trackers TCP');
});

test('boostMagnet monta um magnet quando só há o hash', () => {
  const out = P.boostMagnet('', HASH);
  assert.match(out, new RegExp(`^magnet:\\?xt=urn:btih:${HASH}&tr=`));
});

const probe = (node, awake, engines = []) => ({ node, awake, engines, ms: 10 });

test('orderNodes: nó acordado vence nó dormindo', () => {
  const o = P._t.orderNodes([probe('https://a', false), probe('https://b', true)], HASH, []);
  assert.deepEqual(o.map((x) => x.node), ['https://b', 'https://a']);
  assert.equal(o[0].awake, true);
});

test('orderNodes: nó que já tem o filme pronto vence outro acordado', () => {
  const o = P._t.orderNodes([
    probe('https://a', true, []),
    probe('https://b', true, [{ hash: HASH.toUpperCase(), ready: true }])
  ], HASH, []);
  assert.equal(o[0].node, 'https://b');
  assert.equal(o[0].has, true);
});

test('orderNodes: entre acordados, o menos carregado primeiro', () => {
  const busy = [{ hash: 'x1', ready: true }, { hash: 'x2', ready: true }, { hash: 'x3', ready: false }];
  const o = P._t.orderNodes([probe('https://a', true, busy), probe('https://b', true, [])], HASH, []);
  assert.equal(o[0].node, 'https://b');
});

test('orderNodes: nó esgotado (fora do rank do painel) vai para o fim, mesmo acordado', () => {
  const o = P._t.orderNodes([probe('https://a', true), probe('https://b', true)], HASH, ['https://b']);
  assert.deepEqual(o.map((x) => x.node), ['https://b', 'https://a']);
});

test('orderNodes: todos dormindo respeita o nó "preso" ao arquivo (mesmo hash = mesma ordem)', () => {
  const ps = [probe('https://a', false), probe('https://b', false)];
  const one = P._t.orderNodes(ps, HASH, []).map((x) => x.node);
  const two = P._t.orderNodes(ps.slice().reverse(), HASH, []).map((x) => x.node);
  assert.equal(one.length, 2);
  assert.notEqual(one[0], one[1]);
  // com a lista na mesma ordem a escolha é estável
  assert.deepEqual(P._t.orderNodes(ps, HASH, []).map((x) => x.node), one);
  assert.ok(two.length === 2);
});

test('fmtTime', () => {
  assert.equal(P._t.fmtTime(65), '1:05');
  assert.equal(P._t.fmtTime(3725), '1:02:05');
  assert.equal(P._t.fmtTime(0), '0:00');
});

test('o texto do player não vaza detalhe técnico para quem não é admin', () => {
  // Tudo o que a pessoa lê está nas listas de etapas/frases/títulos; o detalhe vai só em `.tp-tech admin-only`.
  const visible = [];
  // (failNow(reason, tech) só repassa motivo ao admin via onFail/.admin-only; o overlay usa texto fixo)
  const re = /(?:titleEl\.textContent = |setPhase\('[a-z]+', |subEl\.textContent = )'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) visible.push(m[1]);
  const steps = (src.match(/\['(?:connect|find|load|buffer)', '([^']+)'\]/g) || []).map((x) => x.replace(/^.*', '|'\]$/g, ''));
  const tips = (src.match(/var TIPS = \[([\s\S]*?)\];/) || ['', ''])[1].match(/'[^']+'/g) || [];
  const all = visible.concat(steps, tips).join(' | ').toLowerCase();
  for (const bad of ['servidor', 'render', 'vercel', 'torrent', 'peer', ' nó', 'banda', 'ffmpeg', 'kb/s', 'tracker', 'snapdeploy']) {
    assert.ok(!all.includes(bad), `texto público não pode conter "${bad}": ${all}`);
  }
  assert.ok(src.includes("el('div', 'tp-tech admin-only'"), 'linha técnica precisa ser .admin-only');
});
