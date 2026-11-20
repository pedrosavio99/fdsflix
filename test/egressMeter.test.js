'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const egress = require('../lib/egressMeter');

const MB = 1048576;

function memoryStore() {
  const rows = new Map();
  return {
    kind: 'memoria',
    rows,
    enabled: () => true,
    async get(day) { return rows.has(day) ? JSON.parse(JSON.stringify(rows.get(day))) : null; },
    async put(day, v) { rows.set(day, JSON.parse(JSON.stringify(v))); },
    async list(n) { return [...rows.keys()].sort().reverse().slice(0, n).map((day) => ({ day, v: JSON.parse(JSON.stringify(rows.get(day))) })); }
  };
}

function fakeRes() {
  const handlers = {};
  return {
    write(chunk) { return true; },
    end(chunk) { return true; },
    on(ev, fn) { handlers[ev] = fn; },
    close() { if (handlers.close) handlers.close(); }
  };
}

function hit(path, bytes) {
  const res = fakeRes();
  egress.middleware({ path }, res, () => {});
  res.write(Buffer.alloc(bytes));
  res.end();
  res.close();
}

test('classify separa vídeo, legenda e páginas', () => {
  assert.equal(egress.classify('/api/proxy'), 'video: /api/proxy');
  assert.equal(egress.classify('/hls/abc/seg_00001.ts'), 'video: /hls (ffmpeg)');
  assert.equal(egress.classify('/api/subtitle.srt'), 'legendas');
  assert.equal(egress.classify('/api/home'), 'api: home');
  assert.equal(egress.classify('/vendor/hls.min.js'), 'estatico: vendor/cv');
  assert.equal(egress.classify('/'), 'estatico: pagina');
});

test('histórico por dia sobrevive ao reinício e não conta duas vezes', async () => {
  const store = memoryStore();
  let clock = Date.parse('2026-11-20T10:00:00Z');
  egress._reset({ store, now: () => clock });

  hit('/api/proxy', 3 * MB);
  hit('/', 1 * MB);
  await egress.flush();
  await egress.flush(); // nada mudou: não pode somar de novo
  assert.equal(store.rows.get('2026-11-20').http['video: /api/proxy'].b, 3 * MB);

  // "deploy": o processo novo começa do zero mas o dia gravado continua
  egress._reset({ store, now: () => clock });
  hit('/api/proxy', 2 * MB);
  const rep = await egress.report({ days: 31 });
  assert.equal(rep.today.videoMb, 5);
  assert.equal(rep.today.httpMb, 6);
  await egress.flush();
  assert.equal(store.rows.get('2026-11-20').http['video: /api/proxy'].b, 5 * MB);
  await egress.flush();
  assert.equal(store.rows.get('2026-11-20').http['video: /api/proxy'].b, 5 * MB);

  // virou o dia (UTC): outro registro, o anterior fica intacto
  clock = Date.parse('2026-11-21T00:05:00Z');
  hit('/', 1 * MB);
  await egress.flush();
  assert.equal(store.rows.get('2026-11-20').http['video: /api/proxy'].b, 5 * MB);
  const rep2 = await egress.report({ days: 31 });
  assert.deepEqual(rep2.days.map((d) => d.day), ['2026-11-20', '2026-11-21']);
  assert.equal(rep2.month.videoMb, 5);
  assert.equal(rep2.month.days, 2);
});

test('armazém fora do ar não apaga o histórico e tenta de novo', async () => {
  const store = memoryStore();
  const now = () => Date.parse('2026-11-20T10:00:00Z');
  await store.put('2026-11-20', { http: { 'video: /api/proxy': { b: 7 * MB, r: 1 } }, out: {} });
  let down = true;
  const realGet = store.get;
  store.get = async (d) => { if (down) throw new Error('Supabase fora'); return realGet(d); };
  egress._reset({ store, now });
  hit('/', 1 * MB);
  await egress.flush(); // falha ao ler a base: não pode sobrescrever só com o que o processo mediu
  assert.equal(store.rows.get('2026-11-20').http['video: /api/proxy'].b, 7 * MB);
  down = false;
  await egress.flush();
  assert.equal(store.rows.get('2026-11-20').http['video: /api/proxy'].b, 7 * MB);
  assert.equal(store.rows.get('2026-11-20').http['estatico: pagina'].b, 1 * MB);
});

test('mede o que o servidor ENVIA e RECEBE por conexão que ele mesmo abre, por host', async () => {
  const store = memoryStore();
  egress._reset({ store, trackLoopback: true });
  egress.install();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.end(Buffer.alloc(300 * 1024)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const r = await fetch(`http://127.0.0.1:${port}/x`, { method: 'POST', body: Buffer.alloc(120 * 1024) });
  assert.equal((await r.arrayBuffer()).byteLength, 300 * 1024);
  const snap = egress.snapshot();
  const row = snap.outbound.find((o) => o.host === '127.0.0.1');
  assert.ok(row, 'host 127.0.0.1 medido');
  assert.ok(row.sentMb >= 0.11 && row.sentMb < 0.2, 'enviado ~120 KB, veio ' + row.sentMb);
  assert.ok(row.recvMb >= 0.28 && row.recvMb < 0.4, 'recebido ~300 KB, veio ' + row.recvMb);
  assert.ok(row.conns >= 1);
  server.closeAllConnections();
  await new Promise((r2) => server.close(r2));
});

test('loopback não conta (o Render não cobra o que não sai da máquina)', async () => {
  egress._reset({ store: memoryStore() });
  egress.install();
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(egress.snapshot().outbound.length, 0);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

test('mais de 40 hosts viram "(outros)" ao gravar', async () => {
  const store = memoryStore();
  egress._reset({ store, now: () => Date.parse('2026-11-20T10:00:00Z'), trackLoopback: true });
  const day = '2026-11-20';
  const out = {};
  for (let i = 0; i < 60; i++) out['h' + i + '.exemplo.com'] = { s: (i + 1) * 1000, r: 10, c: 1 };
  await store.put(day, { http: {}, out });
  hit('/', 1);
  await egress.flush();
  const saved = store.rows.get(day).out;
  assert.equal(Object.keys(saved).length, 40);
  assert.ok(saved['(outros)']);
  assert.ok(saved['h59.exemplo.com'], 'o maior host é mantido');
});

test('trava de vídeo: contadores do diagnóstico', async () => {
  egress._reset({ store: memoryStore() });
  egress.noteGuard('rejected', { path: '/api/proxy', socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4' } });
  egress.noteGuard('internal', {});
  const rep = await egress.report();
  assert.equal(rep.videoGuard.rejected, 1);
  assert.equal(rep.videoGuard.allowedInternal, 1);
  assert.equal(rep.videoGuard.last.forwarded, true);
});
