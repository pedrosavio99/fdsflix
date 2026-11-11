'use strict';

/**
 * Kit "Vercel extra": gera, na hora, um .zip com o projeto adproxy pronto para
 * subir em OUTRA conta Vercel (cada conta soma mais uma cota de banda ao pool).
 *
 * Sem dependências: o .zip é escrito à mão (zlib + CRC32). Não há variável de ambiente
 * para configurar: PROXY_SECRET e TARGET_ORIGIN vêm EMBUTIDOS em adproxy/lib/config.js.
 * O kit leva os arquivos de adproxy/ (menos node_modules, .env, testes, Docker) e um LEIA-ME.txt.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ADPROXY_DIR = path.join(__dirname, '..', 'adproxy');
const KIT_NAME = 'fdsflix-vercel-kit';

// Nomes que NUNCA entram no kit (segredos locais, dependências, lixo de deploy).
const SKIP_NAMES = new Set([
  'node_modules', 'test', '.vercel', '.git', '.DS_Store',
  'Dockerfile', '.dockerignore', '.env'
]);

function readmeText() {
  return [
    'fdsFlix - kit de Vercel extra',
    '==============================',
    '',
    'Nao ha variavel de ambiente para configurar: tudo ja vem embutido no codigo.',
    '',
    '1. Descompacte e entre na pasta:      cd adproxy-kit',
    '2. Entre na conta Vercel de destino:  npx vercel login   (logout antes, se estiver em outra)',
    '3. Rode o script:                     bash deploy-vercel.sh',
    '4. Copie a URL de producao que ele mostra e some em VIDSRC_PROXY_URLS no Render.',
    '',
    'Manual completo, problemas comuns e aviso sobre os termos da Vercel: POOL-MANUAL.md',
    '(o mesmo tutorial esta no botao Configs da pagina do fdsFlix).',
    ''
  ].join('\n');
}

/* ------------------------------ escritor de zip ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * entries: [{ name: 'a/b.txt', data: Buffer, mode?: 0o644 }]  ->  Buffer do .zip
 * Nomes em UTF-8; `mode` fica nos atributos Unix (deploy-vercel.sh sai executável).
 */
function createZip(entries, now = new Date()) {
  const { time, day } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const method = useDeflate ? 8 : 0;
    const mode = entry.mode || 0o644;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // versão necessária
    local.writeUInt16LE(0x0800, 6);       // flag: nome em UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // criado em Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

/* ------------------------------ montagem do kit ------------------------------ */

function shouldSkip(name) {
  if (SKIP_NAMES.has(name)) return true;
  // .env.example fica; .env.local, .env.production etc. não.
  return name.startsWith('.env.') && name !== '.env.example';
}

function collectFiles(dir, prefix = '') {
  const out = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (shouldSkip(item.name)) continue;
    const full = path.join(dir, item.name);
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...collectFiles(full, rel));
    else if (item.isFile()) out.push({ rel, full, mode: fs.statSync(full).mode & 0o777 });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function kitAvailable() {
  return fs.existsSync(path.join(ADPROXY_DIR, 'package.json'));
}

/** Devolve { zip: Buffer, files: [nomes], filename }. Lança se adproxy/ não existir. */
function buildKit(now = new Date()) {
  if (!kitAvailable()) throw new Error('Pasta adproxy/ não encontrada neste servidor.');
  const root = 'adproxy-kit';
  const entries = collectFiles(ADPROXY_DIR).map((file) => ({
    name: `${root}/${file.rel}`,
    data: fs.readFileSync(file.full),
    mode: file.rel.endsWith('.sh') ? 0o755 : (file.mode || 0o644)
  }));
  entries.push({ name: `${root}/LEIA-ME.txt`, data: Buffer.from(readmeText()), mode: 0o644 });
  const zip = createZip(entries, now);
  return { zip, files: entries.map((entry) => entry.name), filename: `${KIT_NAME}.zip` };
}

module.exports = {
  buildKit,
  createZip,
  crc32,
  kitAvailable
};
