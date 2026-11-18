'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

// Isola do ambiente real: sem Supabase, arquivo de cache temporário, config conhecida.
process.env.TORRENT_NODE_FILE = path.join(os.tmpdir(), `fdsflix-nodes-test-${process.pid}.json`);
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.TORRENT_NODES = 'https://n1.containers.snapdeploy.app, https://n2.containers.snapdeploy.app/';
process.env.TORRENT_NODE_QUOTA_GB = '10';
process.env.TORRENT_NODE_QUOTAS = 'https://n2.containers.snapdeploy.app=4';
process.env.TORRENT_NODE_HOURS = '100';
process.env.TORRENT_NODE_KEY = 'segredo-de-teste';

const nodes = require('../lib/torrentNodes');
const GB = 1024 ** 3;
const N1 = 'https://n1.containers.snapdeploy.app';
const N2 = 'https://n2.containers.snapdeploy.app';

test('chave dos nós: só a certa passa', () => {
  assert.equal(nodes.keyOK('segredo-de-teste'), true);
  assert.equal(nodes.keyOK('errada'), false);
  assert.equal(nodes.keyOK(''), false);
  assert.equal(nodes.keyOK(undefined), false);
});

test('chave derivada é estável e não é a senha de admin', () => {
  const saved = process.env.TORRENT_NODE_KEY;
  delete process.env.TORRENT_NODE_KEY;
  const a = nodes.nodeKey();
  const b = nodes.nodeKey();
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{40}$/);
  assert.notEqual(a, '118111');
  process.env.TORRENT_NODE_KEY = saved;
});

test('cota por nó: padrão, individual e horas', () => {
  assert.equal(nodes.quotaGb(N1), 10);
  assert.equal(nodes.quotaGb(N2), 4);
  assert.equal(nodes.hoursQuota(), 100);
});

test('valida a URL do nó e a normaliza', () => {
  assert.equal(nodes.validNode('https://a.b.c'), true);
  assert.equal(nodes.validNode('javascript:alert(1)'), false);
  assert.equal(nodes.validNode('https://a.b/c'), false);
  assert.equal(nodes.normalizeNode('HTTPS://A.B.C///'), 'https://a.b.c');
  assert.deepEqual(nodes.configuredNodes(), [N1, N2]);
});

test('relatório soma banda, entrada, horas e vídeos; snapshot calcula o que resta', () => {
  assert.equal(nodes.record(N1, { egressBytes: 2 * GB, ingressBytes: 1 * GB, awakeSeconds: 7200, streams: 3, name: 'conta-1' }).ok, true);
  assert.equal(nodes.record(N1, { egressBytes: 1 * GB, awakeSeconds: 3600, streams: 0 }).ok, true);
  const snap = nodes.snapshot();
  const n1 = snap.nodes.find((n) => n.node === N1);
  assert.equal(n1.egressBytes, 3 * GB);
  assert.equal(n1.ingressBytes, 1 * GB);
  assert.equal(n1.hoursUsed, 3);
  assert.equal(n1.streams, 3);
  assert.equal(n1.label, 'conta-1');
  assert.equal(n1.remainingBytes, 7 * GB);
  assert.equal(n1.pct, 30);
  assert.equal(n1.gbPerStreamMeasured, true);
  assert.equal(n1.gbPerStream, 1); // 3 GB / 3 vídeos
  assert.equal(n1.filmsLeft, 7);
  assert.equal(n1.exhausted, false);
  assert.equal(n1.asleep, false);
});

test('nó que nunca reportou aparece zerado e "dormindo"', () => {
  const n2 = nodes.snapshot().nodes.find((n) => n.node === N2);
  assert.equal(n2.egressBytes, 0);
  assert.equal(n2.quotaBytes, 4 * GB);
  assert.equal(n2.asleep, true);
  assert.equal(n2.lastSeenAt, null);
});

test('esgotado por banda ou por horas sai do rank; o mais folgado vem primeiro', () => {
  // N2 (cota 4 GB): gasta 4 GB -> esgotado por banda.
  nodes.record(N2, { egressBytes: 4 * GB, awakeSeconds: 60 });
  let snap = nodes.snapshot();
  const n2 = snap.nodes.find((n) => n.node === N2);
  assert.equal(n2.exhausted, true);
  assert.equal(n2.exhaustedBy, 'banda');
  assert.deepEqual(snap.rank, [N1]);

  // Um terceiro nó esgota as HORAS (100 h) sem gastar banda.
  const N3 = 'https://n3.containers.snapdeploy.app';
  nodes.record(N3, { egressBytes: 1, awakeSeconds: 24 * 3600 });
  nodes.record(N3, { awakeSeconds: 24 * 3600 });
  nodes.record(N3, { awakeSeconds: 24 * 3600 });
  nodes.record(N3, { awakeSeconds: 24 * 3600 });
  nodes.record(N3, { awakeSeconds: 24 * 3600 });
  snap = nodes.snapshot();
  const n3 = snap.nodes.find((n) => n.node === N3);
  assert.equal(n3.hoursUsed, 120);
  assert.equal(n3.exhausted, true);
  assert.equal(n3.exhaustedBy, 'horas');
  assert.ok(!snap.rank.includes(N3));
});

test('números absurdos ou negativos são ignorados/limitados', () => {
  const before = nodes.snapshot().nodes.find((n) => n.node === N1).egressBytes;
  nodes.record(N1, { egressBytes: -5, ingressBytes: 'abc', awakeSeconds: NaN });
  assert.equal(nodes.snapshot().nodes.find((n) => n.node === N1).egressBytes, before);
  nodes.record(N1, { egressBytes: 10 ** 18 });
  const after = nodes.snapshot().nodes.find((n) => n.node === N1).egressBytes;
  assert.ok(after - before <= 50 * GB, 'teto por relatório');
});

test('recusa URL inválida', () => {
  assert.equal(nodes.record('nao-e-url', { egressBytes: 1 }).ok, false);
  assert.equal(nodes.record('https://x.y/caminho', { egressBytes: 1 }).ok, false);
});

test('nome do nó é saneado', () => {
  nodes.record('https://n9.containers.snapdeploy.app', { egressBytes: 1, name: '<script>alert(1)</script> conta' });
  const n = nodes.snapshot().nodes.find((x) => x.node === 'https://n9.containers.snapdeploy.app');
  assert.ok(!/[<>()]/.test(n.label));
});

test('nós extras do navegador entram no snapshot', () => {
  const snap = nodes.snapshot(['https://so-no-navegador.containers.snapdeploy.app', 'lixo']);
  assert.ok(snap.nodes.some((n) => n.node === 'https://so-no-navegador.containers.snapdeploy.app'));
  assert.ok(!snap.nodes.some((n) => n.node === 'lixo'));
});

test('ciclo mensal: dia de renovação respeita o dia configurado', () => {
  process.env.TORRENT_NODE_RESET_DAY = '10';
  assert.equal(nodes.currentCycle(new Date('2026-11-18T12:00:00Z')), '2026-11-10');
  assert.equal(nodes.currentCycle(new Date('2026-11-05T12:00:00Z')), '2026-10-10');
  assert.equal(nodes.daysUntilReset(new Date('2026-11-18T12:00:00Z')), 22);
  delete process.env.TORRENT_NODE_RESET_DAY;
});

test.after(() => { try { require('fs').unlinkSync(process.env.TORRENT_NODE_FILE); } catch (e) { /* ok */ } });
