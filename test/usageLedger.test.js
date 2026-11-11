'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { before, test } = require('node:test');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
process.env.USAGE_FILE = path.join(os.tmpdir(), `fdsflix-usage-${process.pid}.json`);
process.env.VIDSRC_PROXY_URLS = 'https://a.vercel.app/, https://b.vercel.app';
process.env.VIDSRC_PROXY_URL = 'https://a.vercel.app';
process.env.VERCEL_QUOTA_GB = '100';
process.env.USAGE_CAPABILITY_PROBE = '0'; // sem perguntar nada à internet nos testes

const ledger = require('../lib/usageLedger');
const GB = 1024 ** 3;
const A = 'https://a.vercel.app';
const B = 'https://b.vercel.app';

/** fetch falso do GET <base>/vidsrc/hls?cap=1: true = Edge, false = adproxy antigo, 'html' / 'down' = estranho. */
function fakeProbe(states) {
  return async (url) => {
    const state = states[String(url).replace(/\/vidsrc\/hls.*$/, '')];
    if (state === 'down') throw new Error('ECONNREFUSED');
    if (state === 'html') return new Response('<html>Login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (state === true) return new Response(JSON.stringify({ adproxy: 'edge', v: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: 'URL inválida' }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
}

// Os testes antigos abaixo falam de Vercels que entregam pelo Edge (cota cheia de 100 GB).
before(async () => {
  await ledger.refreshCapabilities(fakeProbe({ [A]: true, [B]: true }));
});

test('pool junta as duas variáveis, sem repetir e sem barra final', () => {
  assert.deepEqual(ledger.getPool(), ['https://a.vercel.app', 'https://b.vercel.app']);
});

test('só aceita consumo de Vercels da pool e limita envios absurdos', () => {
  assert.equal(ledger.record('https://intruso.example.com', GB, 10).ok, false);
  assert.equal(ledger.record('https://a.vercel.app', -5, 10).ok, false);
  assert.equal(ledger.record('https://a.vercel.app', 50 * GB, 10).ok, true);
  const used = ledger.snapshot().pool[0].usedBytes;
  assert.ok(used <= 600 * 1024 * 1024, 'um envio é limitado a 600 MB');
});

test('a Vercel mais folgada vem primeiro e a esgotada vai para o fim', () => {
  assert.equal(ledger.rankedPool()[0].base, 'https://b.vercel.app');
  ledger.calibrate('https://b.vercel.app', 99);
  ledger.calibrate('https://a.vercel.app', 10);
  const ranked = ledger.rankedPool();
  assert.equal(ranked[0].base, 'https://a.vercel.app');
  assert.equal(ranked[1].exhausted, true);
});

test('média real de GB/h só vale depois de 10 min de vídeo medidos (e a calibração não a distorce)', () => {
  const b = 'https://b.vercel.app';
  ledger.record(b, 0.5 * GB, 300);
  assert.equal(ledger.snapshot().pool[1].gbPerHourMeasured, false);
  ledger.record(b, 0.5 * GB, 3600);
  ledger.calibrate(b, 40); // acertar o total com a Vercel não pode mexer na média
  const item = ledger.snapshot().pool[1];
  assert.equal(item.gbPerHourMeasured, true);
  // 1 GB medido em 3900 s de vídeo = 0,92 GB/h (cada envio fica abaixo do teto de 600 MB)
  assert.ok(Math.abs(item.gbPerHour - 0.92) < 0.02, `média inesperada: ${item.gbPerHour}`);
  assert.ok(Math.abs(item.usedBytes - 40 * GB) < 1024, 'o total usado segue o número calibrado');
});

test('Vercel antiga (função Node) vale 10 GB; a nova (Edge) vale 100 GB; a pool soma cada uma', async () => {
  await ledger.refreshCapabilities(fakeProbe({ [A]: true, [B]: false }));
  assert.equal(ledger.isEdge(A), true);
  assert.equal(ledger.isEdge(B), false);
  assert.equal(ledger.quotaOf(A), 100 * GB);
  assert.equal(ledger.quotaOf(B), 10 * GB);
  const snap = ledger.snapshot();
  assert.deepEqual(snap.pool.map((p) => [p.edge, p.quotaBytes / GB]), [[true, 100], [false, 10]]);
  assert.equal(snap.total.quotaBytes / GB, 110);
  assert.equal(snap.quotaGb, 100);
  assert.equal(snap.fotQuotaGb, 10);
});

test('a antiga esgota aos 98% de 10 GB (não de 100) e vai para o fim; a Edge com mais sobra vem primeiro', async () => {
  await ledger.refreshCapabilities(fakeProbe({ [A]: true, [B]: false }));
  ledger.calibrate(A, 60);   // Edge: 60 de 100 GB (40 livres)
  ledger.calibrate(B, 9.9);  // antiga: 9,9 de 10 GB => esgotada
  let ranked = ledger.rankedPool();
  assert.equal(ranked[0].base, A);
  assert.equal(ranked[1].base, B);
  assert.equal(ranked[1].exhausted, true);
  assert.equal(ranked[1].usedPct, 99);
  assert.equal(ranked[0].exhausted, false);

  // com folga nas duas, vence a que tem MAIS sobra (a Edge, mesmo com mais gasto absoluto)
  ledger.calibrate(B, 2);    // antiga: 8 GB livres
  ledger.calibrate(A, 50);   // Edge: 50 GB livres
  ranked = ledger.rankedPool();
  assert.equal(ranked[0].base, A);
  assert.equal(ranked.every((r) => !r.exhausted), true);
});

test('classificação: HTML de login ou resposta estranha NÃO é Edge; queda de rede mantém o que já se sabia', async () => {
  await ledger.refreshCapabilities(fakeProbe({ [A]: true, [B]: true }));
  assert.equal(ledger.isEdge(A) && ledger.isEdge(B), true);

  await ledger.refreshCapabilities(fakeProbe({ [A]: 'down', [B]: 'html' }));
  assert.equal(ledger.isEdge(A), true, 'rede fora não derruba uma Vercel já classificada como Edge');
  assert.equal(ledger.isEdge(B), false, 'resposta que não é o JSON do adproxy Edge volta ao limite conservador');
});

test('VERCEL_FOT_QUOTA_GB ajusta o limite das Vercels antigas (ex.: conta Pro)', async () => {
  await ledger.refreshCapabilities(fakeProbe({ [A]: false, [B]: false }));
  process.env.VERCEL_FOT_QUOTA_GB = '1000';
  try {
    assert.equal(ledger.quotaOf(A), 100 * GB, 'nunca passa da cota cheia VERCEL_QUOTA_GB');
    process.env.VERCEL_FOT_QUOTA_GB = '25';
    assert.equal(ledger.quotaOf(A), 25 * GB);
  } finally {
    delete process.env.VERCEL_FOT_QUOTA_GB;
  }
  assert.equal(ledger.quotaOf(A), 10 * GB);
});
