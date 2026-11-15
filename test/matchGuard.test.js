'use strict';

// "Este upload é mesmo este filme?" — o caso real que deu errado: "La Odisea" (minissérie de 1997, publicada em 2023)
// casou com "A Odisseia" (2026) só por título parecido + duração parecida.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { check, norm, yearsIn } = require('../lib/matchGuard');

const odisseia = { year: 2026, releaseDate: '2026-07-16', runtimeSec: 10320, primary: ['A Odisseia', 'The Odyssey'] };
const clube = { year: 1999, releaseDate: '1999-10-15', runtimeSec: 8340, primary: ['Clube da Luta', 'Fight Club'] };

test('publicado antes do lançamento nunca é o filme (o bug da Odisseia)', () => {
  const r = check(odisseia, { label: 'La Odisea', description: '', publishedAt: '2023-12-27T18:43:21Z', durationSec: 10485 });
  assert.equal(r.ok, false);
  assert.match(r.why, /antes do lançamento/);
});

test('título com ano diferente é recusado', () => {
  assert.equal(check(clube, { label: 'Clube da Luta (2010)', durationSec: 8340 }).ok, false);
  assert.equal(check(clube, { label: 'Clube da Luta (1999)', durationSec: 8340 }).ok, true);
});

test('ano na descrição vale como prova', () => {
  const r = check(clube, { label: 'Clube da Luta', description: 'Fight Club - 1999 Um escriturário…', publishedAt: '2024-10-10T00:00:00Z', durationSec: 8348 });
  assert.equal(r.ok, true);
});

test('sem ano: só o nome principal exato, com duração apertada', () => {
  assert.equal(check(clube, { label: 'Clube da Luta Dublado', durationSec: 8340 }).ok, true);
  assert.equal(check(clube, { label: 'Fight Club', durationSec: 8340 }).ok, true);
  assert.equal(check(clube, { label: 'Fight Club Remastered Edit', durationSec: 8340 }).ok, false);
  assert.equal(check(clube, { label: 'Clube da Luta', durationSec: 8340 + 1500 }).ok, false); // 25 min a mais
});

test('nome alternativo de outro país não prova nada sem ano', () => {
  // mesmo publicado depois do lançamento, "La Odisea" sem ano não é nome principal de "A Odisseia"
  const r = check(odisseia, { label: 'La Odisea', publishedAt: '2026-09-01T00:00:00Z', durationSec: 10485 });
  assert.equal(r.ok, false);
});

test('sem ano do TMDB não dá para conferir: deixa passar (as outras regras da fonte seguem valendo)', () => {
  assert.equal(check({ year: 0, primary: [] }, { label: 'qualquer' }).ok, true);
});

test('norm e yearsIn', () => {
  assert.equal(norm('A Viagem de Chihiro (2001) Dublado 1080p'), 'a viagem de chihiro');
  assert.deepEqual(yearsIn('Filme 1080p de 1999 e [2001]'), [1999, 2001]);
});
