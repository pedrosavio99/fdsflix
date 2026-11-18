'use strict';

/**
 * Kit do streamer de torrent (.zip) — sobe no Koyeb free (ou qualquer Docker).
 *
 * Leva deploy/torrent-streamer/ (Dockerfile + index.js + package.json + README). O fdsFlix
 * aponta o "tocar aqui" para a URL desse nó; o vídeo sai por ele, não pelo Render.
 */

const fs = require('fs');
const path = require('path');
const { createZip } = require('./poolKit');

const DIR = path.join(__dirname, '..', 'deploy', 'torrent-streamer');
const FILES = ['Dockerfile', 'index.js', 'package.json', 'README.md'];

function kitAvailable() {
  return FILES.every((f) => {
    try { return fs.statSync(path.join(DIR, f)).isFile(); } catch (err) { return false; }
  });
}

function buildKit(now = new Date()) {
  const entries = FILES.map((f) => ({ name: f, data: fs.readFileSync(path.join(DIR, f)) }));
  return { filename: 'fdsflix-torrent-streamer.zip', zip: createZip(entries, now) };
}

module.exports = { kitAvailable, buildKit, FILES };
