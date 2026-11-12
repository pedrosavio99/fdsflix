#!/usr/bin/env node
'use strict';

/**
 * Empacota as fontes de TV ao vivo para o repositório.
 *
 *   node scripts/live-pack.js            lê lib/live-sources.plain.json  -> escreve lib/liveSources.packed.js
 *   node scripts/live-pack.js --unpack   lê lib/liveSources.packed.js    -> escreve lib/live-sources.plain.json
 *
 * O arquivo .plain.json (texto puro, para editar) NÃO vai para o Git (.gitignore). O .packed.js vai: é
 * JSON compactado (deflate) em base64, então as URLs não aparecem em busca nem a olho nu.
 * Isso é só ofuscação, não segurança: quem tem o código consegue decodificar.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LIB = path.join(__dirname, '..', 'lib');
const PLAIN = path.join(LIB, 'live-sources.plain.json');
const PACKED = path.join(LIB, 'liveSources.packed.js');

function pack(json) {
  const text = JSON.stringify(JSON.parse(json));
  const b64 = zlib.deflateRawSync(Buffer.from(text, 'utf8'), { level: 9 }).toString('base64');
  const lines = b64.match(/.{1,100}/g) || [];
  return `'use strict';\n\n// Gerado por scripts/live-pack.js. Não edite à mão.\nmodule.exports =\n  ${lines.map((l) => `'${l}'`).join(' +\n  ')};\n`;
}

function unpack(b64) {
  return JSON.stringify(JSON.parse(zlib.inflateRawSync(Buffer.from(b64, 'base64')).toString('utf8')), null, 2) + '\n';
}

if (require.main === module) {
  if (process.argv.includes('--unpack')) {
    fs.writeFileSync(PLAIN, unpack(require(PACKED)));
    console.log('Escrevi', PLAIN);
  } else {
    fs.writeFileSync(PACKED, pack(fs.readFileSync(PLAIN, 'utf8')));
    console.log('Escrevi', PACKED);
  }
}

module.exports = { pack, unpack };
