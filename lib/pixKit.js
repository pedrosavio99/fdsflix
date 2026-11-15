'use strict';

/**
 * Kit do nó do Pix (.zip) e script do Gmail, gerados na hora. A chave vai embutida no lib/config.js do nó e no .gs.
 * Reaproveita o escritor de zip do poolKit (sem dependências).
 */

const fs = require('fs');
const path = require('path');
const { createZip } = require('./poolKit');

const PIXKIT_DIR = path.join(__dirname, '..', 'pixkit');
const SKIP = new Set(['node_modules', '.git', '.DS_Store', '.env', 'test']);
const ANCHOR = "const EMBEDDED_SECRET = '';";
const SCRIPT_FILE = 'gmail-pix.gs';

function kitAvailable() {
  return fs.existsSync(path.join(PIXKIT_DIR, 'server.js'));
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

function readme(secret) {
  return [
    'fdsFlix - no do Pix',
    '====================',
    '',
    'Recebe do Gmail (via Apps Script) o aviso de "Pix recebido" do Nubank e entrega ao fdsFlix.',
    'Sem dependencias: so Node 18+. A chave ja vem embutida em lib/config.js.',
    '',
    '1. Suba esta pasta no Wasmer (Node) ou em qualquer VPS:  node server.js   (porta PORT, padrao 3000)',
    '2. Abra https://SEU-NO/health  -> deve responder {"ok":true,...}',
    '3. Copie a URL do no e cole na tela Pix do fdsFlix (modo admin) -> Salvar.',
    '4. Na mesma tela, baixe o "Script do Gmail" e siga o passo a passo dentro do arquivo.',
    '',
    'Chave (so para conferir; nao compartilhe): ' + secret.slice(0, 6) + '...' + secret.slice(-4),
    ''
  ].join('\n');
}

function buildKit({ secret, now = new Date() }) {
  if (!kitAvailable()) throw new Error('Pasta pixkit/ não encontrada neste servidor.');
  if (!/^[0-9a-f]{32,}$/i.test(String(secret || ''))) throw new Error('Chave do Pix inválida.');
  const entries = [];
  for (const file of collect(PIXKIT_DIR)) {
    if (file.rel === SCRIPT_FILE) continue; // o .gs só sai depois de salvar a URL do nó (baixado à parte)
    let data = fs.readFileSync(file.full);
    if (file.rel === 'lib/config.js') {
      const text = data.toString('utf8');
      if (!text.includes(ANCHOR)) throw new Error('lib/config.js do pixkit sem a âncora da chave.');
      data = Buffer.from(text.replace(ANCHOR, `const EMBEDDED_SECRET = '${secret}';`), 'utf8');
    }
    entries.push({ name: `pix-kit/${file.rel}`, data, mode: 0o644 });
  }
  entries.push({ name: 'pix-kit/LEIA-ME.txt', data: Buffer.from(readme(secret)), mode: 0o644 });
  return { zip: createZip(entries, now), filename: 'fdsflix-pix-kit.zip', files: entries.map((e) => e.name) };
}

/** Script do Gmail pronto para colar (URL do nó e chave já preenchidas). */
function buildGmailScript({ microUrl, secret }) {
  const url = String(microUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s'"\\]+$/i.test(url)) throw new Error('Salve antes a URL do nó do Pix.');
  if (!/^[0-9a-f]{32,}$/i.test(String(secret || ''))) throw new Error('Chave do Pix inválida.');
  const template = fs.readFileSync(path.join(PIXKIT_DIR, SCRIPT_FILE), 'utf8');
  return template.replace('__MICRO_URL__', url).replace('__PIX_SECRET__', secret);
}

module.exports = { buildKit, buildGmailScript, kitAvailable, ANCHOR };
