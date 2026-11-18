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

/**
 * `opts.fdsflixUrl` + `opts.nodeKey` entram em node.config.json: o nó lê isso no boot e passa a reportar o
 * consumo ao fdsFlix SEM variável de ambiente. Assim o MESMO .tar serve para todas as contas. As variáveis
 * FDSFLIX_URL / NODE_KEY / NODE_NAME / NODE_URL, se existirem, mandam mais que o arquivo.
 */
function buildKit(opts = {}, now = new Date()) {
  if (opts instanceof Date) { now = opts; opts = {}; }
  const entries = FILES.map((f) => ({ name: f, data: fs.readFileSync(path.join(DIR, f)) }));
  if (opts.fdsflixUrl && opts.nodeKey) {
    entries.push({ name: 'node.config.json', data: Buffer.from(JSON.stringify({ fdsflixUrl: opts.fdsflixUrl, nodeKey: opts.nodeKey }, null, 2) + '\n') });
  }
  return { filename: 'fdsflix-torrent-streamer.zip', zip: createZip(entries, now) };
}

module.exports = { kitAvailable, buildKit, FILES };
