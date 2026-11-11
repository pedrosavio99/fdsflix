'use strict';

const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { test } = require('node:test');

const kit = require('../lib/poolKit');

/** Leitor mínimo de zip (só para conferir o que o escritor gerou). */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'sem EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const csize = buf.readUInt32LE(pos + 20);
    const usize = buf.readUInt32LE(pos + 24);
    const nlen = buf.readUInt16LE(pos + 28);
    const elen = buf.readUInt16LE(pos + 30);
    const clen = buf.readUInt16LE(pos + 32);
    const attrs = buf.readUInt32LE(pos + 38) >>> 16;
    const offset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nlen);
    const lnlen = buf.readUInt16LE(offset + 26);
    const lelen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + lnlen + lelen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(data.length, usize, `tamanho de ${name}`);
    assert.equal(kit.crc32(data), crc, `crc de ${name}`);
    out[name] = { data, mode: attrs & 0o777 };
    pos += 46 + nlen + elen + clen;
  }
  return out;
}

test('crc32 bate com o valor conhecido', () => {
  assert.equal(kit.crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('createZip: ida e volta com UTF-8, vazio e conteúdo repetido', () => {
  const big = Buffer.from('abc'.repeat(5000));
  const zip = kit.createZip([
    { name: 'a/ç.txt', data: Buffer.from('olá') },
    { name: 'vazio', data: Buffer.alloc(0) },
    { name: 'big', data: big, mode: 0o755 }
  ]);
  const files = readZip(zip);
  assert.equal(files['a/ç.txt'].data.toString(), 'olá');
  assert.equal(files.vazio.data.length, 0);
  assert.ok(files.big.data.equals(big));
  assert.equal(files.big.mode, 0o755);
});

test('buildKit: leva o adproxy com as envs embutidas, sem segredos locais nem node_modules', () => {
  const built = kit.buildKit();
  const files = readZip(built.zip);
  const names = Object.keys(files);

  for (const must of ['api/index.js', 'api/hls.js', 'lib/edgeHls.mjs', 'lib/secret.js', 'lib/app.js', 'lib/vidsrc.js', 'lib/config.js', 'vercel.json',
    'package.json', 'POOL-MANUAL.md', 'deploy-vercel.sh', 'LEIA-ME.txt']) {
    assert.ok(files[`adproxy-kit/${must}`], `falta ${must}`);
  }
  assert.match(files['adproxy-kit/lib/secret.js'].data.toString(), /BUILTIN_PROXY_SECRET =\s*'[a-f0-9]{64}'/);
  // O vídeo sai pelo Edge: sem este rewrite (antes do catch-all) o kit voltaria a gastar Fast Origin Transfer.
  const vercelJson = JSON.parse(files['adproxy-kit/vercel.json'].data.toString());
  assert.deepEqual(vercelJson.rewrites[0], { source: '/vidsrc/hls', destination: '/api/hls' });
  assert.match(files['adproxy-kit/api/hls.js'].data.toString(), /runtime:\s*'edge'/);
  assert.equal(files['adproxy-kit/deploy-vercel.sh'].mode, 0o755);
  assert.ok(!names.some((n) => /ENVS\.txt/.test(n)), 'não deve haver ENVS.txt');
  assert.ok(!names.some((n) => /node_modules|\/test\/|Dockerfile/.test(n)), 'arquivo que não devia entrar');
  assert.ok(!names.some((n) => /\/\.env$|\.env\.(?!example)/.test(n)), '.env vazou para o zip');
});
