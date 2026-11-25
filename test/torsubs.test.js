'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'torsubs.js'), 'utf8');
const window = {};
vm.runInNewContext(src, { window });
const { startsOn, fmtOffset } = window.FdsTorSubs._t;

test('legenda opcional: a escolha da pessoa manda; sem escolha, só o original liga', () => {
  assert.equal(startsOn(null, false), true);
  assert.equal(startsOn(null, true), false);
  assert.equal(startsOn('off', false), false);
  assert.equal(startsOn('pt', true), true);
});

test('ajuste de tempo é mostrado em português', () => {
  assert.equal(fmtOffset(0), 'no tempo');
  assert.equal(fmtOffset(1.5), '+1,5 s');
  assert.equal(fmtOffset(-0.5), '−0,5 s');
});
