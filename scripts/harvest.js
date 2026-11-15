#!/usr/bin/env node
'use strict';

/**
 * Colheita do catálogo pelo terminal (o mesmo job do painel do admin: lib/catalogHarvest.js).
 * Grava no Supabase se SUPABASE_URL/SUPABASE_SECRET_KEY estiverem no .env; senão em data/catalog.json.
 *
 *   npm run harvest                         # popular + top_rated, 3 páginas de cada
 *   npm run harvest -- --pages=10
 *   npm run harvest -- --lists=popular,now_playing,upcoming,top_rated
 *   npm run harvest -- --ids=129,238,550    # títulos específicos (id do TMDB)
 *   npm run harvest -- --force              # refaz mesmo o que já está no catálogo
 *   npm run harvest -- --delay=4000         # pausa (ms) entre títulos (mín. 2500)
 *
 * O normal é colher pelo painel (Admin → Outras fontes → Catálogo); este script serve para rodar em casa.
 */

require('dotenv').config({ quiet: true });

const harvest = require('../lib/catalogHarvest');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

process.on('SIGINT', () => { console.log('\nParando…'); harvest.stop(); });

const r = harvest.start(args, { onLog: (line) => console.log(line) });
if (!r.started) { console.error('Já há uma colheita rodando.'); process.exit(1); }
harvest.wait().then(() => process.exit(0));
