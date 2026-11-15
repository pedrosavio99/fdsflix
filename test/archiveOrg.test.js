'use strict';

// Fonte "Internet Archive": só as regras de escolha (sem rede).

const assert = require('node:assert/strict');
const { test } = require('node:test');

const archive = require('../lib/archiveOrg');

test('duração: aceita segundos e hh:mm:ss', () => {
  assert.equal(archive.lengthSec('7475.92'), 7475.92);
  assert.equal(archive.lengthSec('02:04:35'), 7475);
  assert.equal(archive.lengthSec('1:00'), 60);
  assert.equal(archive.lengthSec(''), 0);
  assert.equal(archive.lengthSec('abc'), 0);
});

test('sequência não vale como o filme pedido', () => {
  const names = ['Toy Story', 'Toy Story'];
  assert.equal(archive.sameTitle(names, 'Toy Story 2 VHS Captures'), false);
  assert.equal(archive.sameTitle(['Fight Club'], 'Fight Club FULL MOVIE'), true);
  assert.equal(archive.sameTitle(['Fight Club'], 'Fight Club (1999)'), true);
  assert.equal(archive.sameTitle(['A Viagem de Chihiro'], 'A Viagem de Chihiro (R4BR DVDISO)'), true);
  assert.equal(archive.sameTitle(['The Godfather'], 'The Godfather II'), false);
  assert.equal(archive.sameTitle(['Alien'], 'Alien vs Predator'), false);
});

test('pt-BR é detectado por metadado ou pelo título', () => {
  assert.equal(archive.hasPtHint({ language: 'por', title: 'x' }), true);
  assert.equal(archive.hasPtHint({ title: 'Filme (R4BR DVDISO)' }), true);
  assert.equal(archive.hasPtHint({ language: 'eng', title: 'Movie' }), false);
});

test('10-bit e HEVC são descartados (o navegador não toca)', () => {
  assert.equal(archive.unplayableHint('[X] Spirited Away 1080p Hi10 AAC'), true);
  assert.equal(archive.unplayableHint('Movie.x265.mp4'), true);
  assert.equal(archive.unplayableHint('Movie 720p'), false);
});
