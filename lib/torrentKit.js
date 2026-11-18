'use strict';

/**
 * Kit do motor de torrents (.zip), gerado na hora — mesmo padrão do zip do Roku (lib/rokuKit).
 *
 * O zip leva o motor (lib/torrentSearch.js), o CLI (torrent.js) e o README, para o admin rodar no
 * próprio PC (IP residencial, onde os trackers respondem melhor). A aba "Torrents" no servidor usa
 * o mesmo motor; o kit é só o caminho local/offline.
 *
 * Reaproveita o escritor de zip do poolKit (sem dependências).
 */

const fs = require('fs');
const path = require('path');
const { createZip } = require('./poolKit');

const ROOT = path.join(__dirname, '..');

const FILES = [
  { from: 'lib/torrentSearch.js', to: 'lib/torrentSearch.js' },
  { from: 'scripts/torrent.js', to: 'torrent.js' },
  { from: 'scripts/torrent-README.md', to: 'README.md' }
];

function kitAvailable() {
  return FILES.every((f) => {
    try { return fs.statSync(path.join(ROOT, f.from)).isFile(); } catch (err) { return false; }
  });
}

function buildKit(now = new Date()) {
  const entries = FILES.map((f) => ({
    name: f.to,
    data: fs.readFileSync(path.join(ROOT, f.from))
  }));
  return { filename: 'fdsflix-torrent-kit.zip', zip: createZip(entries, now) };
}

module.exports = { kitAvailable, buildKit, FILES };
