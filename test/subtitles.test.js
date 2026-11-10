'use strict';

const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { test } = require('node:test');
const { analyzeVtt, decodeSubtitle, shiftVtt, srtToVtt, stripSpamCues } = require('../lib/subtitles');

const SRT = [
  '1', '00:00:06,000 --> 00:00:12,074', 'api.OpenSubtitles.org is deprecated, please', 'implement REST API from OpenSubtitles.com', '',
  '2', '00:02:10,468  -->  00:02:12,190', 'Veio para me matar? Eu sei o que isto é.', '',
  '3', '01:00:00,000 --> 01:00:02,000', 'Fala no meio do filme.', ''
].join('\r\n');

test('decodeSubtitle recupera acentos de .srt em Windows-1252 (não é UTF-8 válido)', () => {
  const text = decodeSubtitle(Buffer.from(SRT, 'latin1'), 'pt');
  assert.match(text, /isto é\./);
  assert.doesNotMatch(text, /�/);
});

test('decodeSubtitle respeita UTF-8, BOM, UTF-16 e gzip', () => {
  assert.match(decodeSubtitle(Buffer.from('﻿' + SRT, 'utf8'), 'pt'), /^1\r\n00:00:06/);
  assert.match(decodeSubtitle(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SRT, 'utf16le')]), 'pt'), /isto é/);
  assert.match(decodeSubtitle(zlib.gzipSync(Buffer.from(SRT, 'utf8')), 'en'), /isto é/);
});

test('decodeSubtitle usa a página de código do idioma (árabe em Windows-1256)', () => {
  const arabic = Buffer.concat([Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n', 'latin1'), Buffer.from([0xc7, 0xe1, 0xda, 0xd1, 0xc8, 0xed, 0xc9])]);
  assert.match(decodeSubtitle(arabic, 'ar'), /العربية/);
});

test('stripSpamCues tira propaganda do começo e preserva falas', () => {
  const vtt = srtToVtt(decodeSubtitle(Buffer.from(SRT, 'latin1'), 'pt'));
  const { vtt: clean, removed } = stripSpamCues(vtt);
  assert.equal(removed, 1);
  assert.doesNotMatch(clean, /OpenSubtitles/);
  assert.match(clean, /Veio para me matar/);
  assert.match(clean, /Fala no meio do filme/);
});

test('analyzeVtt informa onde a legenda termina e quanto está corrompido', () => {
  const info = analyzeVtt(srtToVtt('1\n00:00:01,000 --> 00:00:02,000\nab��\n\n2\n00:10:00,000 --> 00:10:05,500\nok\n'));
  assert.equal(info.cues, 2);
  assert.equal(info.lastEnd, 605.5);
  assert.ok(info.garbled > 0.2 && info.garbled < 0.4);
});

test('shiftVtt aplica atraso e escala (hora * escala + atraso)', () => {
  const vtt = srtToVtt('1\n00:10:00,000 --> 00:10:02,000\nx\n');
  const out = shiftVtt(vtt, 2, 1.1);
  assert.match(out, /00:11:02\.000 --> 00:11:04\.200/);
  assert.equal(shiftVtt(vtt, 0, 1), vtt);
  // escala absurda é ignorada
  assert.equal(shiftVtt(vtt, 0, 9), vtt);
});
