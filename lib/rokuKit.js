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
const os = require('os');
const path = require('path');
const { createZip } = require('./poolKit');

const ROKU_DIR = path.join(__dirname, '..', 'roku');
const SKIP = new Set(['node_modules', '.git', '.DS_Store', 'out', 'LEIA-ME.md']);

/**
 * Endereço do PC na rede local (para testar com o servidor rodando em casa: `localhost` não existe para a TV).
 * Prefere 192.168.x.x; ignora docker/VPN (172.17-31 só se não houver outro).
 */
function lanAddress(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const list of Object.values(interfaces || {})) {
    for (const info of list || []) {
      if ((info.family === 'IPv4' || info.family === 4) && !info.internal) found.push(info.address);
    }
  }
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return found.sort((a, b) => rank(a) - rank(b))[0] || '';
}

/** Se o endereço é do próprio PC (localhost), troca pelo IP da rede local; devolve `local: true` para avisar o admin. */
function resolveApi(base, port, interfaces) {
  let host = '';
  try { host = new URL(base).hostname; } catch (err) { /* inválido: buildKit recusa */ }
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/.test(host)) {
    const ip = lanAddress(interfaces);
    if (ip) return { api: `http://${ip}:${port}`, local: true };
    return { api: base, local: true };
  }
  return { api: base, local: /^http:/i.test(base) };
}

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
function buildKit({ api, key = '', debug = true, now = new Date() }) {
  if (!kitAvailable()) throw new Error('Pasta roku/ não encontrada neste servidor.');
  const base = String(api || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(base)) throw new Error('Endereço do servidor inválido (precisa começar com https://).');

  const entries = [];
  for (const file of collect(ROKU_DIR)) {
    let data = fs.readFileSync(file.full);
    if (file.rel === 'config.json') data = Buffer.from(JSON.stringify({ api: base, key: String(key || ''), debug: Boolean(debug) }, null, 2) + '\n');
    if (file.rel === 'manifest') {
      data = Buffer.from(
        data.toString('utf8').replace(/^build_version=.*$/m, `build_version=${buildVersion(now)}`)
      );
    }
    entries.push({ name: file.rel, data });
  }
  return { zip: createZip(entries, now), files: entries.map((e) => e.name), filename: 'fdsflix-roku.zip', api: base };
}

module.exports = { buildKit, kitAvailable, buildVersion, lanAddress, resolveApi };
