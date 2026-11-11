'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
process.env.USAGE_FILE = path.join(os.tmpdir(), `fdsflix-usage-${process.pid}.json`);
process.env.VIDSRC_PROXY_URLS = 'https://a.vercel.app/, https://b.vercel.app';
process.env.VIDSRC_PROXY_URL = 'https://a.vercel.app';
process.env.VERCEL_QUOTA_GB = '100';

const ledger = require('../lib/usageLedger');
const GB = 1024 ** 3;

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
