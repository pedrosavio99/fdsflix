'use strict';

// Histórico no Supabase, contra um PostgREST falso (nada de rede de verdade).

const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const GB = 1024 ** 3;
const A = 'https://a.vercel.app';

process.env.VIDSRC_PROXY_URLS = A;
process.env.USAGE_CAPABILITY_PROBE = '0';
process.env.VERCEL_QUOTA_GB = '100';
process.env.USAGE_RESET_DAY = '1';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_teste';

const db = { rows: new Map(), mode: 'ok', calls: [] }; // mode: ok | missing
let server;

const isoDay = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

function handle(req, res, body) {
  db.calls.push(`${req.method} ${req.url.split('?')[0]} key=${req.headers.apikey}`);
  const send = (code, json) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(json === undefined ? '' : JSON.stringify(json)); };
  if (db.mode === 'missing') return send(404, { code: 'PGRST205', message: 'Could not find the table' });
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/fdsflix_add_usage') {
    const p = JSON.parse(body);
    const key = `${p.p_day}|${p.p_base}`;
    const r = db.rows.get(key) || { day: p.p_day, base: p.p_base, measured_bytes: 0, adjust_bytes: 0, seconds: 0, reports: 0 };
    r.measured_bytes += p.p_measured; r.adjust_bytes += p.p_adjust; r.seconds += p.p_seconds; r.reports += p.p_reports;
    db.rows.set(key, r);
    return send(204);
  }
  if (req.method === 'GET' && url.pathname === '/rest/v1/vercel_usage_daily') {
    const since = String(url.searchParams.get('day') || '').replace('gte.', '');
    const rows = [...db.rows.values()].filter((r) => r.day >= since).sort((a, b) => a.day.localeCompare(b.day));
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 1000);
    return send(200, rows.slice(offset, offset + limit));
  }
  if (req.method === 'DELETE') return send(204);
  return send(404, { code: 'X', message: 'rota desconhecida' });
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handle(req, res, body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

let n = 0;
/** Ledger "novo processo": disco vazio, mesmo banco falso. */
function freshLedger() {
  for (const key of Object.keys(require.cache)) {
    if (/lib[\\/]usage(Ledger|Store)\.js$/.test(key)) delete require.cache[key];
  }
  n += 1;
  process.env.USAGE_FILE = path.join(os.tmpdir(), `fdsflix-usage-sb-${process.pid}-${n}.json`);
  const ledger = require('../lib/usageLedger');
  currentLedger = ledger;
  return ledger;
}
// Espera o pull inicial terminar de verdade (sob carga o setTimeout fixo de 80 ms virava teste instável).
let currentLedger = null;
const settle = async () => {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const status = currentLedger && currentLedger.storageStatus();
    if (status && status.hydrated) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('registra, envia ao Supabase em soma atômica e usa só a chave "apikey"', async () => {
  const ledger = freshLedger();
  await settle();
  ledger.record(A, 0.5 * GB, 300);
  ledger.record(A, 0.25 * GB, 100);
  assert.equal((await ledger.flush()).sent, 1, 'dois registros do mesmo dia viram uma linha');
  const row = db.rows.get(`${isoDay()}|${A}`);
  assert.equal(row.measured_bytes, 0.75 * GB);
  assert.equal(row.seconds, 400);
  assert.equal(row.reports, 2);
  assert.ok(db.calls.every((c) => c.endsWith('key=sb_secret_teste')));
  assert.equal(ledger.storageStatus().pendingRows, 0);
});

test('reinício do Render: um processo novo recupera o histórico do banco', async () => {
  const ledger = freshLedger(); // disco vazio
  await settle();
  await ledger.pull();
  assert.equal(ledger.snapshot().pool[0].usedBytes, 0.75 * GB);
  assert.equal(ledger.storageStatus().ok, true);
});

test('calibrar lança só a diferença como ajuste e não mexe na média medida', async () => {
  const ledger = freshLedger();
  await settle();
  await ledger.pull();
  ledger.calibrate(A, 40);
  await ledger.flush();
  const row = db.rows.get(`${isoDay()}|${A}`);
  assert.equal(row.measured_bytes, 0.75 * GB);
  assert.equal(row.adjust_bytes, 40 * GB - 0.75 * GB);
  const snap = ledger.snapshot();
  assert.ok(Math.abs(snap.pool[0].usedBytes - 40 * GB) < 1024);
  assert.ok(Math.abs(snap.stats.last30Gb - 0.75) < 0.01, 'a média usa só o medido');
});

test('tabelas ausentes: nada se perde, avisa o motivo e envia tudo quando existirem', async () => {
  db.rows.clear();
  db.mode = 'missing';
  const ledger = freshLedger();
  await settle();
  ledger.record(A, 0.5 * GB, 600); // cada envio é limitado a 600 MB
  await assert.rejects(ledger.flush(), /tabelas não criadas/);
  const st = ledger.storageStatus();
  assert.equal(st.tablesMissing, true);
  assert.equal(st.pendingRows, 1);
  assert.match(st.error, /usage-schema\.sql/);
  assert.equal(ledger.snapshot().pool[0].usedBytes, 0.5 * GB, 'o contador local continua funcionando');

  db.mode = 'ok';
  const out = await ledger.syncNow();
  assert.equal(out.ok, true, out.error);
  assert.equal(db.rows.get(`${isoDay()}|${A}`).measured_bytes, 0.5 * GB);
  assert.equal(ledger.storageStatus().pendingRows, 0);
  assert.equal(ledger.snapshot().pool[0].usedBytes, 0.5 * GB, 'sem contar duas vezes');
});

test('banco novo e vazio recebe o histórico local sem duplicar o que já estava na fila', async () => {
  db.rows.clear();
  db.mode = 'missing';
  const ledger = freshLedger();
  await settle();
  ledger.record(A, 0.5 * GB, 100);   // entra no local e na fila
  db.mode = 'ok';
  await ledger.syncNow();          // pull com banco vazio: semeia, mas sem repetir a fila
  assert.equal(db.rows.get(`${isoDay()}|${A}`).measured_bytes, 0.5 * GB);
  assert.equal(ledger.snapshot().pool[0].usedBytes, 0.5 * GB);
});

test('estatísticas: média pelos dias com dado, ritmo dos últimos 7 dias e previsão do ciclo', async () => {
  db.rows.clear();
  for (let i = 0; i < 10; i += 1) {
    db.rows.set(`${isoDay(-i)}|${A}`, { day: isoDay(-i), base: A, measured_bytes: 10 * GB, adjust_bytes: 0, seconds: 18000, reports: 5 });
  }
  const ledger = freshLedger();
  // esta conta de previsão assume uma Vercel que entrega pelo Edge (cota cheia de 100 GB)
  await ledger.refreshCapabilities(async () => new Response(JSON.stringify({ adproxy: 'edge', v: 1 }), { status: 200 }));
  await settle();
  await ledger.pull();
  const s = ledger.analytics(30).summary;
  assert.equal(s.last30Gb, 100);
  assert.equal(s.avgGbPerDay, 10, 'média = 100 GB / 10 dias com dado (não / 30)');
  assert.equal(s.rateGbPerDay, 10);
  assert.equal(s.gbPerHour, 2, '100 GB em 50 h de vídeo');
  assert.equal(s.peakDay.gb, 10);
  // previsão = usado do ciclo + ritmo * dias que faltam
  assert.ok(Math.abs(s.projectedCycleGb - (s.usedGb + 10 * s.daysLeft)) < 0.02);
  assert.equal(s.willExhaustBeforeReset, s.projectedCycleGb > 100 && s.remainingGb / 10 < s.daysLeft);
  assert.equal(s.extraVercelsNeeded, s.projectedCycleGb > 100 ? Math.ceil((s.projectedCycleGb - 100) / 100) : 0);
  assert.ok(ledger.toCsv(10).startsWith('dia,total_gb,a'));
});

test('pouco histórico não engana: 1 dia de dado não vira "gasta 1/30 por dia"', async () => {
  db.rows.clear();
  const ledger = freshLedger();
  await settle();
  ledger.record(A, 0.5 * GB, 60);
  const s = ledger.analytics(30).summary;
  assert.equal(s.avgGbPerDay, 0.5);
  assert.equal(s.rateGbPerDay, 0.5);
});
