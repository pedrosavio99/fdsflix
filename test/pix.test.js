'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { test } = require('node:test');

const pixAuth = require('../lib/pixAuth');
const pixKit = require('../lib/pixKit');
const { verifyNubankPix } = require('../pixkit/lib/mail');
const { createServer, createStore } = require('../pixkit/server');

// Chave e nome FICTÍCIOS (nada do Pix real do dono entra no repositório).
const FAKE = { key: '11111111-2222-4333-8444-555555555555', name: 'Fulano de Tal Teste', city: 'SAO PAULO', txid: 'AbCd1234Ef', amountCents: 1 };
const KEY = 'a'.repeat(48);
const NOW = Date.parse('2026-11-14T08:31:00Z');

/** Cabeçalhos no formato do "Mostrar original" do Gmail, com endereços anonimizados. */
function headers(over = {}) {
  const auth = over.auth !== undefined ? over.auth
    : 'mx.google.com;\r\n       dkim=pass header.i=@nubank.com.br header.s=m1 header.b=abc;\r\n       spf=fail smtp.mailfrom=bounce@example.com;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=nubank.com.br';
  return [
    over.noAuth ? null : `Authentication-Results: ${auth}`,
    'Received: from mail.example.net (mail.example.net [203.0.113.5])',
    `From: ${over.from || 'Nubank <todomundo@nubank.com.br>'}`,
    'To: dono@example.com',
    `Date: ${over.date || 'Sat, 14 Nov 2026 08:30:45 +0000'}`,
    `Message-ID: ${over.id || '<ZjgdbsM9TR6aP7Co8TJnrw@geopod-ismtpd-59>'}`,
    'Authentication-Results: mx.google.com; dkim=pass header.i=@nubank.com.br; dmarc=pass header.from=nubank.com.br',
    'Content-Type: text/html; charset=utf-8'
  ].filter(Boolean).join('\r\n');
}

const msg = (over = {}) => ({
  headers: headers(over),
  subject: over.subject || 'Recebemos sua transferência via Pix',
  text: over.text !== undefined ? over.text : 'Olá, Fulano.\n\nRecebemos sua transferência via Pix.\nValor recebido:\nR$ 0,50\n14 NOV às 05:30'
});

/* ------------------------------ código Pix ------------------------------ */

test('pix: o gerador e o leitor de copia-e-cola dão a volta completa', () => {
  const code = pixAuth.buildPayload(FAKE);
  assert.ok(code.startsWith('000201'));
  assert.ok(!code.includes('010211'), 'sem a tag 01 (como o Nubank gera)');
  const parsed = pixAuth.parsePayload(code);
  assert.deepEqual(parsed, FAKE);
  assert.equal(pixAuth.buildPayload(parsed), code);
});

test('pix: o espaço do nome e da cidade é preservado e o CRC errado é recusado', () => {
  const code = pixAuth.buildPayload(FAKE);
  assert.equal(pixAuth.parsePayload(`${code.slice(0, 40)}\n${code.slice(40)}`).name, 'Fulano de Tal Teste');
  const bad = code.slice(0, -4) + (code.endsWith('0000') ? '1111' : '0000');
  assert.throws(() => pixAuth.parsePayload(bad), /CRC/);
  assert.throws(() => pixAuth.parsePayload('abc'), /Pix/);
});

/* ------------------------------ e-mail do Nubank ------------------------------ */

test('e-mail: aceita o Pix do Nubank com DKIM e DMARC do Gmail', () => {
  const r = verifyNubankPix(msg(), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 50);
  assert.equal(r.id, '<ZjgdbsM9TR6aP7Co8TJnrw@geopod-ismtpd-59>');
  assert.equal(r.at, Date.parse('2026-11-14T08:30:45Z'));
});

test('e-mail: valores com milhar e centavos', () => {
  assert.equal(verifyNubankPix(msg({ text: 'Valor recebido:\nR$ 1.234,56' }), NOW).amountCents, 123456);
  assert.equal(verifyNubankPix(msg({ text: 'Valor recebido: R$ 0,01' }), NOW).amountCents, 1);
});

test('e-mail: usa só o Authentication-Results MAIS ALTO (um falso embaixo não salva)', () => {
  const r = verifyNubankPix(msg({ auth: 'mx.google.com; dkim=fail header.i=@nubank.com.br; dmarc=fail header.from=nubank.com.br' }), NOW);
  assert.equal(r.ok, false);
  assert.match(r.reason, /DKIM/);
});

test('e-mail: recusa remetente de outro domínio, sem verificação ou de outro servidor', () => {
  assert.match(verifyNubankPix(msg({ from: 'Nubank <todomundo@nubank.com.br.golpe.com>' }), NOW).reason, /remetente/);
  assert.match(verifyNubankPix(msg({ from: 'x@gmail.com' }), NOW).reason, /remetente/);
  assert.match(verifyNubankPix(msg({ auth: 'mx.microsoft.com; dkim=pass header.i=@nubank.com.br; dmarc=pass header.from=nubank.com.br' }), NOW).reason, /Gmail/);
  const semAuth = { ...msg({ noAuth: true }), headers: headers({ noAuth: true }).replace(/Authentication-Results:.*$/gm, '') };
  assert.match(verifyNubankPix(semAuth, NOW).reason, /Authentication-Results/);
});

test('e-mail: DKIM de outro domínio não vale mesmo com "pass"', () => {
  const r = verifyNubankPix(msg({ auth: 'mx.google.com; dkim=pass header.i=@atacante.com; dmarc=pass header.from=nubank.com.br' }), NOW);
  assert.match(r.reason, /DKIM/);
});

test('e-mail: assunto, valor, data e idade são conferidos', () => {
  assert.match(verifyNubankPix(msg({ subject: 'Fatura disponível' }), NOW).reason, /assunto/);
  assert.match(verifyNubankPix(msg({ text: 'sem valor aqui' }), NOW).reason, /Valor recebido/);
  assert.match(verifyNubankPix(msg({ date: 'Sat, 14 Nov 2026 12:00:00 +0000' }), NOW).reason, /futuro/);
  assert.match(verifyNubankPix(msg({ date: 'Fri, 13 Nov 2026 01:00:00 +0000' }), NOW).reason, /antigo/);
  assert.match(verifyNubankPix({ headers: headers().replace(/^Message-ID:.*$/m, ''), subject: 'Recebemos sua transferência via Pix', text: 'Valor recebido: R$ 1,00' }, NOW).reason, /Message-ID/);
});

/* ------------------------------ nó (pixkit) ------------------------------ */

function request(server, method, path, { secret, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, host: '127.0.0.1', method, path, headers: {
      ...(secret ? { 'x-pix-secret': secret } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('nó: exige chave, aceita o e-mail, não duplica e mostra o motivo das recusas', async () => {
  const store = createStore(() => NOW);
  const server = createServer({ secret: KEY, store });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    assert.equal((await request(server, 'GET', '/health')).json.ok, true);
    assert.equal((await request(server, 'GET', '/pix/events')).status, 401);
    assert.equal((await request(server, 'POST', '/pix/mail', { secret: 'errada', body: { messages: [] } })).status, 401);

    const push = await request(server, 'POST', '/pix/mail', { secret: KEY, body: { messages: [msg(), msg(), msg({ id: '<outro@x>', from: 'x@gmail.com' })] } });
    assert.deepEqual(push.json, { ok: true, accepted: 1, duplicates: 1, refused: 1 });

    const list = await request(server, 'GET', '/pix/events?since=0', { secret: KEY });
    assert.equal(list.json.events.length, 1);
    assert.equal(list.json.events[0].amountCents, 50);
    assert.equal(list.json.rejected[0].reason, 'remetente não é do Nubank');

    const again = await request(server, 'GET', `/pix/events?since=${NOW}`, { secret: KEY });
    assert.equal(again.json.events.length, 0, 'since filtra pelo horário do e-mail');
  } finally { server.close(); }
});

test('nó: sem chave configurada ele nem sobe', () => {
  assert.throws(() => createServer({ secret: '' }), /Sem chave/);
});

/* ------------------------------ casamento ------------------------------ */

const charge = (id, at, over = {}) => ({ id, amountCents: 1, createdAt: at, expiresAt: at + pixAuth.VALID_MS, ...over });

test('casamento: valor, janela, ordem de chegada e e-mail já usado', () => {
  const t = NOW;
  const a = charge('a', t); const b = charge('b', t + 60000);
  const ev = (id, at, cents = 1) => ({ id, at, amountCents: cents });

  // dois e-mails, duas cobranças do mesmo valor: o mais antigo atende a primeira
  let m = pixAuth.matchEvents([a, b], [ev('e2', t + 90000), ev('e1', t + 70000)], new Set());
  assert.deepEqual(m.map((x) => [x.charge.id, x.event.id]), [['a', 'e1'], ['b', 'e2']]);

  assert.equal(pixAuth.matchEvents([a], [ev('x', t, 2)], new Set()).length, 0, 'valor diferente');
  assert.equal(pixAuth.matchEvents([a], [ev('x', t - 31000)], new Set()).length, 0, 'e-mail antes da cobrança');
  assert.equal(pixAuth.matchEvents([a], [ev('x', t - 20000)], new Set()).length, 1, 'tolerância de relógio');
  assert.equal(pixAuth.matchEvents([a], [ev('x', a.expiresAt + pixAuth.GRACE_MS + 1)], new Set()).length, 0, 'depois da validade');
  assert.equal(pixAuth.matchEvents([a], [ev('x', t + 1000)], new Set(['x'])).length, 0, 'Message-ID já usado');
  m = pixAuth.matchEvents([a], [ev('x', t + 1000), ev('y', t + 2000)], new Set());
  assert.equal(m.length, 1, 'um e-mail por cobrança');
});

/* ------------------------------ cobrança (estado) ------------------------------ */

function fakeDb(rows = {}) {
  const calls = [];
  return {
    calls,
    enabled: () => true,
    async call(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET' && path.startsWith('/pix_settings')) return rows.settings || [];
      if (method === 'GET' && path.startsWith('/pix_charges')) return rows.charges || [];
      return null;
    }
  };
}

function setup(over = {}) {
  let clock = NOW;
  const events = [];
  const db = over.db || { enabled: () => false };
  const pix = pixAuth.createPix({
    now: () => clock, db, secret: KEY,
    fetchEvents: async () => ({ events: events.slice(), lastPushAt: clock, rejected: [] })
  });
  return { pix, events, db, advance: (ms2) => { clock += ms2; }, now: () => clock };
}

const DEVICE = 'dev-aaaaaaaa-1';

test('cobrança: precisa do código Pix salvo antes', async () => {
  const { pix } = setup();
  await assert.rejects(pix.createCharge({ deviceId: DEVICE }), /código Pix/);
  await assert.rejects(pix.saveSettings({ microUrl: 'ftp://x' }), /https/);
  await assert.rejects(pix.saveSettings({ pixCode: 'lixo' }), /Pix/);
});

test('cobrança: paga por e-mail -> libera 10 min só para o aparelho que pediu', async () => {
  const { pix, events, advance, now } = setup();
  await pix.saveSettings({ microUrl: 'https://no.exemplo.app/', pixCode: pixAuth.buildPayload(FAKE) });
  const made = await pix.createCharge({ deviceId: DEVICE, device: 'Android · Chrome', visitor: '203.0.113.9' });
  assert.equal(made.charge.status, 'pending');
  assert.equal(pixAuth.parsePayload(made.code).amountCents, 1);

  assert.equal((await pix.createCharge({ deviceId: DEVICE })).reused, true, 'não duplica cobrança pendente do mesmo aparelho');
  assert.equal((await pix.poll(made.charge.id, DEVICE)).charge.status, 'pending');
  assert.equal((await pix.poll(made.charge.id, 'dev-outro-aparelho')), null, 'outro aparelho não enxerga');

  advance(20000);
  events.push({ id: '<m1>', at: now() - 2000, amountCents: 1 });
  advance(4000);
  const paid = await pix.poll(made.charge.id, DEVICE);
  assert.equal(paid.charge.status, 'paid');
  assert.equal(paid.charge.grantedUntil, paid.charge.paidAt + pixAuth.ACCESS_MS);
  assert.ok(paid.access && paid.access.remainingMs > 9 * 60000);
  assert.equal(pix.access('dev-outro-aparelho'), null);

  advance(10 * 60000 + 1000);
  assert.equal(pix.access(DEVICE), null, 'o acesso acaba em 10 min');
});

test('cobrança: o mesmo e-mail não paga duas cobranças', async () => {
  const { pix, events, advance, now } = setup();
  await pix.saveSettings({ microUrl: 'https://no.exemplo.app', pixCode: pixAuth.buildPayload(FAKE) });
  const a = await pix.createCharge({ deviceId: DEVICE });
  events.push({ id: '<m1>', at: now() + 1000, amountCents: 1 });
  advance(5000);
  assert.equal((await pix.poll(a.charge.id, DEVICE)).charge.status, 'paid');
  const b = await pix.createCharge({ deviceId: 'dev-bbbbbbbb-2' });
  advance(5000);
  assert.equal((await pix.poll(b.charge.id, 'dev-bbbbbbbb-2')).charge.status, 'pending');
});

test('cobrança: vence depois da validade + tolerância', async () => {
  const { pix, advance } = setup();
  await pix.saveSettings({ microUrl: 'https://no.exemplo.app', pixCode: pixAuth.buildPayload(FAKE) });
  const a = await pix.createCharge({ deviceId: DEVICE });
  advance(pixAuth.VALID_MS + 1000);
  assert.equal((await pix.poll(a.charge.id, DEVICE)).charge.status, 'pending', 'ainda na tolerância');
  advance(pixAuth.GRACE_MS);
  assert.equal((await pix.poll(a.charge.id, DEVICE)).charge.status, 'expired');
  assert.equal((await pix.createCharge({ deviceId: DEVICE })).reused, false);
});

test('cobrança: nó fora do ar aparece como erro, sem derrubar', async () => {
  const pix = pixAuth.createPix({ now: () => NOW, db: { enabled: () => false }, secret: KEY, fetchEvents: async () => { throw new Error('o nó respondeu HTTP 502'); } });
  await pix.saveSettings({ microUrl: 'https://no.exemplo.app', pixCode: pixAuth.buildPayload(FAKE) });
  const a = await pix.createCharge({ deviceId: DEVICE });
  assert.equal((await pix.poll(a.charge.id, DEVICE)).charge.status, 'pending');
  assert.match((await pix.getState(DEVICE)).micro.lastError, /502/);
});

test('Supabase: grava a cobrança com o aparelho e relê tudo ao reiniciar', async () => {
  const db = fakeDb();
  const { pix, events, advance, now } = setup({ db });
  await pix.saveSettings({ microUrl: 'https://no.exemplo.app', pixCode: pixAuth.buildPayload(FAKE) });
  const made = await pix.createCharge({ deviceId: DEVICE, device: 'iPhone · Safari', visitor: '203.0.113.9' });
  events.push({ id: '<m1>', at: now() + 500, amountCents: 1 });
  advance(4000);
  await pix.poll(made.charge.id, DEVICE);

  const writes = db.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/pix_charges'));
  assert.ok(writes.length >= 2);
  const last = writes[writes.length - 1].body;
  assert.equal(last.device_id, DEVICE);
  assert.equal(last.device, 'iPhone · Safari');
  assert.equal(last.status, 'paid');
  assert.equal(last.mail_id, '<m1>');
  assert.ok(db.calls.some((c) => c.path.startsWith('/pix_settings')));

  // reinício: carrega as linhas gravadas
  const fresh = pixAuth.createPix({ now: () => now(), db: fakeDb({ charges: [last], settings: [
    { k: 'micro_url', v: { url: 'https://no.exemplo.app' } }, { k: 'pix', v: { ...FAKE } }] }), secret: KEY });
  const st = await fresh.getState(DEVICE);
  assert.equal(st.history[0].status, 'paid');
  assert.ok(st.access, 'o acesso sobrevive ao reinício enquanto não vence');
  assert.equal(st.settings.microUrl, 'https://no.exemplo.app');
});

test('Supabase: tabelas ainda não criadas -> segue na memória e avisa', async () => {
  const db = { enabled: () => true, async call() { const e = new Error('tabelas não criadas'); e.tablesMissing = true; throw e; } };
  const { pix } = setup({ db });
  await pix.saveSettings({ microUrl: 'https://no.exemplo.app', pixCode: pixAuth.buildPayload(FAKE) });
  const made = await pix.createCharge({ deviceId: DEVICE });
  assert.equal(made.charge.status, 'pending');
  assert.equal((await pix.getState(DEVICE)).persist.tablesMissing, true);
});

test('chave do nó: derivada da chave secreta do Supabase, estável e sem ela vazia', () => {
  const a = pixAuth.deriveMailSecret({ SUPABASE_SECRET_KEY: 'sb_secret_x' });
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.equal(a, pixAuth.deriveMailSecret({ SUPABASE_SECRET_KEY: 'sb_secret_x' }));
  assert.notEqual(a, pixAuth.deriveMailSecret({ SUPABASE_SECRET_KEY: 'sb_secret_y' }));
  assert.equal(pixAuth.deriveMailSecret({}), '');
});

/* ------------------------------ kit .zip e script ------------------------------ */

function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20);
    const nlen = buf.readUInt16LE(pos + 28);
    const elen = buf.readUInt16LE(pos + 30);
    const clen = buf.readUInt16LE(pos + 32);
    const offset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nlen);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(raw) : raw;
    pos += 46 + nlen + elen + clen;
  }
  return out;
}

test('kit: o .zip leva o nó com a chave embutida e sem o script do Gmail', () => {
  const kit = pixKit.buildKit({ secret: KEY });
  const files = readZip(kit.zip);
  assert.ok(files['pix-kit/server.js'] && files['pix-kit/lib/mail.js'] && files['pix-kit/package.json'] && files['pix-kit/Dockerfile']);
  assert.ok(!files['pix-kit/gmail-pix.gs'], 'o .gs sai à parte, com a URL do nó');
  assert.ok(files['pix-kit/lib/config.js'].toString().includes(`const EMBEDDED_SECRET = '${KEY}';`));
  assert.ok(!files['pix-kit/LEIA-ME.txt'].toString().includes(KEY), 'o README só mostra um trecho da chave');
  assert.throws(() => pixKit.buildKit({ secret: '' }), /inválida/);
});

test('kit: o script do Gmail sai com URL e chave preenchidas', () => {
  const gs = pixKit.buildGmailScript({ microUrl: 'https://no.exemplo.app/', secret: KEY });
  assert.ok(gs.includes("var MICRO_URL = 'https://no.exemplo.app';"));
  assert.ok(gs.includes(`var SECRET = '${KEY}';`));
  assert.ok(!gs.includes('__MICRO_URL__') && !gs.includes('__PIX_SECRET__'));
  assert.throws(() => pixKit.buildGmailScript({ microUrl: '', secret: KEY }), /URL/);
  assert.throws(() => pixKit.buildGmailScript({ microUrl: "https://x.app/'; evil()", secret: KEY }), /URL/);
});
