'use strict';

/**
 * Canal Roku (.zip para instalar pelo modo desenvolvedor), gerado na hora.
 *
 * O app (roku/) é um cliente fino: lista, detalhe, busca e TV vêm da API; a escolha da fonte, a troca de
 * versão e a legenda ficam no servidor. Por isso o zip sai com o endereço DESTE servidor em config.json e
 * quase nada exige reinstalar: mudou a lógica, é só o deploy. (Só interface nova precisa de zip novo.)
 * Reaproveita o escritor de zip do poolKit (sem dependências).
 */

const fs = require('fs');
const path = require('path');
const { createZip } = require('./poolKit');

const ROKU_DIR = path.join(__dirname, '..', 'roku');
const SKIP = new Set(['node_modules', '.git', '.DS_Store', 'out', 'LEIA-ME.md']);

function kitAvailable() {
  return fs.existsSync(path.join(ROKU_DIR, 'manifest')) && fs.existsSync(path.join(ROKU_DIR, 'source', 'main.brs'));
}

function collect(dir, prefix = '') {
  const out = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(item.name)) continue;
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...collect(full, rel));
    else if (item.isFile()) out.push({ rel, full });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Versão do pacote: mesma data do build (yymmddHHMM), para o Roku aceitar a reinstalação por cima. */
function buildVersion(now) {
  const p = (v) => String(v).padStart(2, '0');
  return Number(`${p(now.getUTCFullYear() % 100)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}`) % 100000;
}

/**
 * @param {{api:string, key?:string, now?:Date}} opts  api = endereço público deste servidor.
 * @returns {{zip:Buffer, files:string[], filename:string, api:string}}
 */
function buildKit({ api, key = '', now = new Date() }) {
  if (!kitAvailable()) throw new Error('Pasta roku/ não encontrada neste servidor.');
  const base = String(api || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(base)) throw new Error('Endereço do servidor inválido (precisa começar com https://).');

  const entries = [];
  for (const file of collect(ROKU_DIR)) {
    let data = fs.readFileSync(file.full);
    if (file.rel === 'config.json') data = Buffer.from(JSON.stringify({ api: base, key: String(key || '') }, null, 2) + '\n');
    if (file.rel === 'manifest') {
      data = Buffer.from(
        data.toString('utf8').replace(/^build_version=.*$/m, `build_version=${buildVersion(now)}`)
      );
    }
    entries.push({ name: file.rel, data });
  }
  return { zip: createZip(entries, now), files: entries.map((e) => e.name), filename: 'fdsflix-roku.zip', api: base };
}

module.exports = { buildKit, kitAvailable, buildVersion };
