'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { translateVtt, translateTexts, wrapText } = require('../lib/translate');
const { analyzeVtt } = require('../lib/subtitles');

const VTT = [
  'WEBVTT', '',
  '1', '00:00:01.000 --> 00:00:03.000', 'Hello there.', '',
  '2', '00:00:04.000 --> 00:00:06.500 line:90%', '- Get out!', '- No way.', '',
  '3', '00:00:07.000 --> 00:00:09.000', '<i>I never liked him,', 'to be honest.</i>', '',
  '4', '00:00:10.000 --> 00:00:11.000', '♪♪', '',
  '5', '00:00:12.000 --> 00:00:13.000', 'Hello there.', ''
].join('\n');

// "tradutor" falso: marca o texto, assim dá para ver exatamente o que foi enviado.
const fake = async (texts) => texts.map((t) => `PT(${t})`);

test('translateVtt troca só o texto: tempos, ids e settings ficam idênticos', async () => {
  const out = await translateVtt(VTT, { batch: fake });
  assert.equal(out.complete, true);
  const before = analyzeVtt(VTT);
  const after = analyzeVtt(out.vtt);
  assert.deepEqual(after, before);
  assert.match(out.vtt, /00:00:04\.000 --> 00:00:06\.500 line:90%/);
  assert.match(out.vtt, /PT\(Hello there\.\)/);
});

test('diálogo com travessão mantém uma fala por linha', async () => {
  const out = await translateVtt(VTT, { batch: fake });
  assert.match(out.vtt, /- PT\(Get out!\)\n- PT\(No way\.\)/);
});

test('itálico é preservado, linhas da mesma fala viram uma frase só na tradução', async () => {
  const out = await translateVtt(VTT, { batch: fake });
  assert.match(out.vtt, /<i>PT\(I never liked him, to be honest\.\)<\/i>/);
});

test('texto sem letras (♪) não é enviado e textos repetidos são traduzidos uma vez', async () => {
  const sent = [];
  await translateVtt(VTT, { batch: async (texts) => { sent.push(...texts); return texts; } });
  assert.ok(!sent.includes('♪♪'));
  assert.equal(sent.filter((t) => t === 'Hello there.').length, 1);
});

test('falha do provedor mantém o texto original e marca como incompleta', async () => {
  const out = await translateVtt(VTT, { batch: async () => { throw new Error('captcha'); } });
  assert.equal(out.complete, false);
  assert.match(out.vtt, /Hello there\./);
  assert.deepEqual(analyzeVtt(out.vtt), analyzeVtt(VTT));
});

test('translateTexts divide o lote quando a contagem não bate e isola a fala ruim', async () => {
  const texts = ['a', 'b', 'c', 'd'];
  const batch = async (items) => {
    if (items.includes('c') && items.length > 1) throw new Error('contagem de itens não bate');
    return items.map((t) => t.toUpperCase());
  };
  assert.deepEqual(await translateTexts(texts, { batch }), ['A', 'B', 'C', 'D']);
});

test('wrapText quebra frase longa em linhas balanceadas e deixa a curta quieta', () => {
  assert.equal(wrapText('Oi, tudo bem?'), 'Oi, tudo bem?');
  const wrapped = wrapText('Eu nunca gostei dele, para ser sincero com você, de verdade mesmo.');
  const lines = wrapped.split('\n');
  assert.ok(lines.length >= 2 && lines.length <= 3);
  assert.ok(lines.every((l) => l.length <= 50));
});
