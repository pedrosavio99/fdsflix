#!/usr/bin/env node
'use strict';

/**
 * CLI do motor de torrents (mesmo motor da aba admin "Torrents").
 *
 *   node torrent.js "Matrix" --year=1999
 *   node torrent.js "Dragon Ball Z"
 *
 * Só imprime os links (magnet/.torrent). Nada é baixado aqui.
 */

const { search } = require('../lib/torrentSearch');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : '';
}

const title = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim();
const year = arg('year');

if (!title) {
  console.error('Uso: node torrent.js "Título" [--year=1999]');
  process.exit(1);
}

search({ title, year }).then((r) => {
  console.log('fontes:', r.sources.map((s) => s.id + '=' + (s.ok ? s.count : '!' + s.error)).join(' '));
  if (!r.results.length) {
    console.log(r.note || 'Nada encontrado.');
    return;
  }
  for (const x of r.results) {
    console.log(`[${x.audio}/${x.quality}] ${x.seeds}s ${x.title}`);
    if (x.magnet) console.log('   ' + x.magnet);
    else if (x.torrent) console.log('   ' + x.torrent);
  }
}).catch((err) => {
  console.error('ERRO', err.message);
  process.exit(1);
});
