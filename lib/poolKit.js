'use strict';

/**
 * Kits .zip do AdShield, gerados na hora (sem dependências: o .zip é escrito à mão com zlib + CRC32).
 *
 *   kind "vercel"   -> fdsflix-vercel-kit.zip    kit do pool do Vidsrc (uma conta Vercel = mais cota).
 *   kind "fallback" -> fdsflix-adfallback-kit.zip nó do AdFallback (MEDIA_PROXY=1): entrega a mídia
 *                      das OUTRAS fontes quando a pool inteira falha. Vem com a chave de mídia e o
 *                      MEDIA_PROXY=1 já embutidos em lib/config.js (zero variável para configurar) e
 *                      com o Dockerfile (Wasmer/VPS) além do deploy-vercel.sh.
 *
 * Os arquivos vêm de adproxy/ menos node_modules, .env, testes e lixo de deploy. O LEIA-ME.txt é
 * específico de cada kit e o deploy-fallback.sh só entra no kit do AdFallback.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { BUILTIN_PROXY_SECRET } = require('../adproxy/lib/secret');

const ADPROXY_DIR = path.join(__dirname, '..', 'adproxy');

// Nomes que NUNCA entram nos kits (segredos locais, dependências, lixo de deploy).
const SKIP_NAMES = new Set([
  'node_modules', 'test', '.vercel', '.git', '.DS_Store', '.env'
]);

// O kit do AdFallback leva o Dockerfile (Wasmer/VPS) e NÃO leva o deploy-vercel.sh (tem o de fallback).
const FALLBACK_ONLY = new Set(['deploy-fallback.sh']);
const VERCEL_ONLY = new Set(['deploy-vercel.sh']);

// Âncora trocada no config.js publicado no kit do AdFallback (ver adproxy/lib/config.js).
const MEDIA_KIT_ANCHOR = "const MEDIA_KIT = { enabled: false, key: '' };";

function vercelReadme() {
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

/**
 * Chave do AdFallback: DETERMINÍSTICA (a mesma em todos os nós e em todo download), para o rodízio
 * funcionar com uma única ADSHIELD_FALLBACK_KEY no Render. Deriva do segredo público do projeto — a
 * mesma decisão já tomada para PROXY_SECRET; serve só para o nó não virar proxy aberto para estranhos.
 * Para trocar: defina MEDIA_PROXY_KEY nos nós e a mesma ADSHIELD_FALLBACK_KEY no Render.
 */
function fallbackMediaKey() {
  return crypto.createHash('sha256').update(`fdsflix-adfallback-v1|${BUILTIN_PROXY_SECRET}`).digest('hex').slice(0, 48);
}

function fallbackReadme(mediaKey) {
  return [
    'fdsFlix - AdFallback (no de fallback dos filmes)',
    '================================================',
    '',
    'Este no NAO e o pool do Vidsrc. Ele so entra em cena quando a pool inteira falha:',
    'pega o filme que o VidLink Pro (ou outra fonte) achou e entrega a playlist/arquivo',
    'direto ao navegador. ZERO bytes de video no Render.',
    '',
    'Ja vem pronto: MEDIA_PROXY=1 e a chave abaixo estao embutidos em lib/config.js.',
    'A chave e a MESMA em todos os nos do AdFallback (pode subir quantos quiser com ela).',
    '',
    '  CHAVE (vai no Render como ADSHIELD_FALLBACK_KEY):',
    `  ${mediaKey}`,
    '',
    '--- Opcao A: Vercel (mais simples) ---',
    '1. Descompacte e entre na pasta:  cd adfallback-kit',
    '2. npx vercel logout   (se estiver em outra conta)   e   npx vercel login',
    '3. bash deploy-fallback.sh',
    '4. Anote a URL de producao curta (Project > Domains). Se vier pagina de login:',
    '   Project > Settings > Deployment Protection > desligue para Production.',
    '',
    '--- Opcao B: Wasmer / VPS / Docker ---',
    '1. docker build -t adfallback .',
    '2. docker run -p 3000:3000 adfallback',
    '3. Aponte o dominio/porta publica para o no.',
    '',
    '--- No Render (fdsFlix) ---',
    'ADSHIELD_FALLBACK_URLS=https://SEU-NO.vercel.app',
    'ADSHIELD_FALLBACK_KEY=' + mediaKey,
    '',
    'Varios nos (rodizio): separe as URLs por virgula em ADSHIELD_FALLBACK_URLS.',
    'Cada conta/nó soma outra cota; o fdsFlix escolhe o de mais folga e manda o filme inteiro por ele.',
    '',
    '--- Testar ---',
    'curl -s -H "x-media-key: ' + mediaKey + '" \\',
    '  "https://SEU-NO/_adshield/media/prepare?u=https%3A%2F%2Fexemplo.com%2Fmaster.m3u8"',
    'Deve responder {"ok":true,"kind":"hls","url":"..."}.',
    '',
    'No seu PC:  npm run fallback:check -- https://SEU-NO https://exemplo.com/master.m3u8 ' + mediaKey,
    '',
    'Observacao: como o segredo do projeto e publico por decisao do dono, esta chave so impede',
    'que estranhos usem o no como proxy aberto. Para trocar, defina MEDIA_PROXY_KEY no host.',
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
 * Nomes em UTF-8; `mode` fica nos atributos Unix (deploy-*.sh sai executável).
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

function shouldSkip(name, kind) {
  // O kit do AdFallback pode ir para Wasmer/VPS: leva o Dockerfile. O do pool é só Vercel.
  if (name === 'Dockerfile' || name === '.dockerignore') return kind !== 'fallback';
  if (SKIP_NAMES.has(name)) return true;
  // .env.example fica; .env.local, .env.production etc. não.
  return name.startsWith('.env.') && name !== '.env.example';
}

function collectFiles(dir, prefix = '', kind = 'vercel') {
  const out = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (shouldSkip(item.name, kind)) continue;
    const full = path.join(dir, item.name);
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...collectFiles(full, rel, kind));
    else if (item.isFile()) out.push({ rel, full, mode: fs.statSync(full).mode & 0o777 });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function kitAvailable() {
  return fs.existsSync(path.join(ADPROXY_DIR, 'package.json'));
}

/** Troca a âncora MEDIA_KIT em lib/config.js pelo kit do AdFallback (liga e embute a chave). */
function patchFallbackConfig(source, mediaKey) {
  if (!source.includes(MEDIA_KIT_ANCHOR)) {
    throw new Error('lib/config.js não tem a âncora MEDIA_KIT; o kit do AdFallback não pode ser gerado.');
  }
  return source.replace(
    MEDIA_KIT_ANCHOR,
    `const MEDIA_KIT = { enabled: true, key: '${mediaKey}' };`
  );
}

/**
 * @param {{kind?: 'vercel'|'fallback', now?: Date}} [options]
 * @returns {{zip: Buffer, files: string[], filename: string, mediaKey?: string}}
 */
function buildKit(input = {}) {
  const options = input instanceof Date ? { now: input } : input;
  const kind = options.kind === 'fallback' ? 'fallback' : 'vercel';
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());

  if (!kitAvailable()) throw new Error('Pasta adproxy/ não encontrada neste servidor.');

  const mediaKey = kind === 'fallback' ? fallbackMediaKey() : null;
  const root = kind === 'fallback' ? 'adfallback-kit' : 'adproxy-kit';
  const filename = kind === 'fallback' ? 'fdsflix-adfallback-kit.zip' : 'fdsflix-vercel-kit.zip';

  const entries = [];
  for (const file of collectFiles(ADPROXY_DIR, '', kind)) {
    if (kind === 'fallback' && VERCEL_ONLY.has(file.rel)) continue;
    if (kind !== 'fallback' && FALLBACK_ONLY.has(file.rel)) continue;

    let data = fs.readFileSync(file.full);
    if (kind === 'fallback' && file.rel === 'lib/config.js') {
      data = Buffer.from(patchFallbackConfig(data.toString('utf8'), mediaKey), 'utf8');
    }

    entries.push({
      name: `${root}/${file.rel}`,
      data,
      mode: file.rel.endsWith('.sh') ? 0o755 : (file.mode || 0o644)
    });
  }

  const readme = kind === 'fallback' ? fallbackReadme(mediaKey) : vercelReadme();
  entries.push({ name: `${root}/LEIA-ME.txt`, data: Buffer.from(readme), mode: 0o644 });

  const zip = createZip(entries, now);
  return {
    zip,
    files: entries.map((entry) => entry.name),
    filename,
    ...(mediaKey ? { mediaKey } : {})
  };
}

module.exports = {
  buildKit,
  createZip,
  crc32,
  kitAvailable,
  fallbackMediaKey,
  MEDIA_KIT_ANCHOR
};
