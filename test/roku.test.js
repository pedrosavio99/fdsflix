'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { buildKit, kitAvailable, buildVersion, resolveApi, lanAddress } = require('../lib/rokuKit');
const { vttToSrt } = require('../lib/subtitles');

/** Lê o diretório central do zip (nomes + dados) sem dependências. */
function readZip(buf) {
  const out = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const raw = buf.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(raw) : raw;
    p += 46 + nlen + elen + clen;
  }
  return out;
}

test('canal Roku: o pacote está na pasta roku/', () => {
  assert.equal(kitAvailable(), true);
});

test('canal Roku: o zip tem manifest na RAIZ e embute o endereço do servidor', () => {
  const kit = buildKit({ api: 'https://exemplo.onrender.com/', key: 'abc', now: new Date('2026-11-15T10:00:00Z') });
  const files = readZip(kit.zip);
  assert.ok(files['manifest'], 'manifest precisa estar na raiz do zip');
  assert.ok(files['source/main.brs']);
  assert.ok(files['components/MainScene.xml']);
  for (const img of ['images/icon_hd.png', 'images/icon_sd.png', 'images/splash_hd.png']) assert.ok(files[img], img);
  const cfg = JSON.parse(files['config.json'].toString('utf8'));
  assert.deepEqual(cfg, { api: 'https://exemplo.onrender.com', key: 'abc', debug: true });
  assert.match(files['manifest'].toString('utf8'), /^build_version=\d+$/m);
  assert.equal(kit.filename, 'fdsflix-roku.zip');
});

test('canal Roku: endereço inválido não gera pacote', () => {
  assert.throws(() => buildKit({ api: 'fdsflix.onrender.com' }), /inválido/);
  assert.throws(() => buildKit({ api: '' }), /inválido/);
});

test('canal Roku: build_version cabe em 5 dígitos e muda com a hora', () => {
  const a = buildVersion(new Date('2026-11-15T10:00:00Z'));
  const b = buildVersion(new Date('2026-11-15T11:00:00Z'));
  assert.ok(a < 100000 && b < 100000);
  assert.notEqual(a, b);
});

test('canal Roku: o app não cita servidor, fonte ou provedor ao público', () => {
  const kit = buildKit({ api: 'https://exemplo.onrender.com' });
  const files = readZip(kit.zip);
  for (const name of Object.keys(files)) {
    if (!/\.(brs|xml)$/.test(name)) continue;
    const text = files[name].toString('utf8');
    // textos entre aspas que o usuário vê: nada técnico
    const shown = (text.match(/"[^"\n]*"/g) || []).filter((t) => /\s/.test(t) && !/https?:|pkg:|\/api\//.test(t))
      // textos do rodapé de diagnóstico: só aparecem com debug=true (zip do admin), ver MainScene.init
      .filter((t) => !/servidor: |CONFIG NAO LIDO/.test(t));
    for (const s of shown) {
      assert.doesNotMatch(s, /render|vercel|provedor|ffmpeg|servidor|fonte/i, `${name}: ${s}`);
    }
  }
});

test('vttToSrt: converte tempos, tira cabeçalho/NOTE/tags e numera', () => {
  const vtt = [
    'WEBVTT', '', 'NOTE comentário', '',
    '00:00:01.000 --> 00:00:03.500', 'Olá <c.yellow>mundo</c>', '',
    'x1', '01:02.250 --> 01:04.000 align:start', '<v Ana>Tudo bem?', ''
  ].join('\n');
  const srt = vttToSrt(vtt);
  assert.equal(srt, '1\n00:00:01,000 --> 00:00:03,500\nOlá mundo\n\n2\n00:01:02,250 --> 00:01:04,000\nTudo bem?\n');
});

test('vttToSrt: vazio devolve vazio', () => {
  assert.equal(vttToSrt('WEBVTT\n\n'), '');
});

test('canal Roku: localhost vira o IP da rede local (a TV não enxerga localhost)', () => {
  const ifs = { docker: [{ family: 'IPv4', address: '172.17.0.1', internal: false }], wifi: [{ family: 'IPv4', address: '192.168.1.66', internal: false }], lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] };
  assert.equal(lanAddress(ifs), '192.168.1.66');
  assert.deepEqual(resolveApi('http://localhost:3000', 3000, ifs), { api: 'http://192.168.1.66:3000', local: true });
  assert.deepEqual(resolveApi('http://127.0.0.1:8080', 8080, ifs), { api: 'http://192.168.1.66:8080', local: true });
  assert.deepEqual(resolveApi('https://fdsflix.onrender.com', 3000, ifs), { api: 'https://fdsflix.onrender.com', local: false });
});

test('canal Roku: debug pode ser desligado (build para o público)', () => {
  const kit = buildKit({ api: 'https://exemplo.onrender.com', debug: false });
  const cfg = JSON.parse(readZip(kit.zip)['config.json'].toString('utf8'));
  assert.equal(cfg.debug, false);
});

test('canal Roku: os arquivos que o app referencia existem no zip', () => {
  const files = readZip(buildKit({ api: 'https://exemplo.onrender.com' }).zip);
  const refs = new Set();
  for (const name of Object.keys(files)) {
    if (!/\.(brs|xml)$/.test(name)) continue;
    for (const m of files[name].toString('utf8').matchAll(/pkg:\/([A-Za-z0-9_\-./]+)/g)) refs.add(m[1]);
  }
  assert.ok(refs.size > 10);
  for (const r of refs) assert.ok(files[r], `referenciado e ausente no zip: ${r}`);
});

// Regressões de bugs reais achados ao RODAR o app num emulador (brs-node), que o compilador não pega.
test('canal Roku: main.brs não tira o foco da cena (scene.setFocus deixava o controle morto)', () => {
  const main = readZip(buildKit({ api: 'https://exemplo.onrender.com' }).zip)['source/main.brs'].toString('utf8');
  assert.doesNotMatch(main.replace(/'.*$/gm, ''), /scene\.setFocus/);
});

test('canal Roku: Dialog.message é texto (o Dialog clássico não aceita lista) e o config não depende de type()', () => {
  const files = readZip(buildKit({ api: 'https://exemplo.onrender.com' }).zip);
  assert.doesNotMatch(files['components/MainScene.brs'].toString('utf8'), /\.message\s*=\s*\[/);
  const main = files['source/main.brs'].toString('utf8').replace(/'.*$/gm, '');
  assert.doesNotMatch(main, /type\(parsed\./);
});

test('canal Roku: logo de canal da TV é objeto { u, a, d } (não texto)', () => {
  const scene = readZip(buildKit({ api: 'https://exemplo.onrender.com' }).zip)['components/MainScene.brs'].toString('utf8');
  assert.match(scene, /lg\.u/);
  const logos = require('../lib/liveLogos.json');
  const first = Object.values(logos)[0];
  assert.equal(typeof first.u, 'string');
});
