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
const ENV_NODES = 'https://n1.containers.snapdeploy.app, https://n2.containers.snapdeploy.app/';
process.env.TORRENT_NODES = ENV_NODES;
process.env.TORRENT_NODE_QUOTA_GB = '10';
process.env.TORRENT_NODE_QUOTAS = 'https://n2.containers.snapdeploy.app=4';
process.env.TORRENT_NODE_HOURS = '100';
process.env.TORRENT_NODE_KEY = 'segredo-de-teste';

const nodes = require('../lib/torrentNodes');
nodes._setFetch(async () => { throw new Error('offline (teste)'); }); // nunca sai para a rede
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

  // Um terceiro nó (que está na env) esgota as HORAS (100 h) sem gastar banda.
  const N3 = 'https://n3.containers.snapdeploy.app';
  process.env.TORRENT_NODES = `${N1}, ${N2}, ${N3}`;
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
  process.env.TORRENT_NODES = ENV_NODES;
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
  process.env.TORRENT_NODES = `${ENV_NODES}, https://n9.containers.snapdeploy.app`;
  nodes.record('https://n9.containers.snapdeploy.app', { egressBytes: 1, name: '<script>alert(1)</script> conta' });
  const n = nodes.snapshot().nodes.find((x) => x.node === 'https://n9.containers.snapdeploy.app');
  assert.ok(!/[<>()]/.test(n.label));
  process.env.TORRENT_NODES = ENV_NODES;
});

test('SEM a env TORRENT_NODES vale o modo antigo: nós extras do navegador entram', () => {
  delete process.env.TORRENT_NODES;
  const snap = nodes.snapshot(['https://so-no-navegador.containers.snapdeploy.app', 'lixo']);
  assert.ok(snap.nodes.some((n) => n.node === 'https://so-no-navegador.containers.snapdeploy.app'));
  assert.ok(!snap.nodes.some((n) => n.node === 'lixo'));
  process.env.TORRENT_NODES = ENV_NODES;
});

// O bug: a lista de nós crescia todo dia. O nó se batizava pelo Host da 1ª requisição (sonda interna
// 10.0.11.x:8080, ou http em vez de https) e cada URL nova virava um nó novo no painel.
test('COM a env, o painel tem exatamente os nós da env, aconteça o que acontecer', () => {
  const before = nodes.snapshot().nodes.length;
  assert.equal(before, 2);
  for (const url of ['https://10.0.11.39:8080', 'http://10.0.11.48:8080', 'https://container-novo-7d2fb.containers.snapdeploy.app', 'https://n1.containers.snapdeploy.app:8443/x'.replace('/x', '')]) {
    nodes.record(url, { egressBytes: 5 * GB, awakeSeconds: 3600, streams: 1 });
  }
  const snap = nodes.snapshot(['https://so-no-navegador.containers.snapdeploy.app', 'https://outro.exemplo.com']);
  assert.deepEqual(snap.nodes.map((n) => n.node).sort(), [N1, N2].sort());
  assert.equal(snap.total.hoursQuota, 2 * 100, 'cota total = nº de envs x horas');
});

test('URL desconhecida não cria nó: o consumo fica retido e o painel avisa', () => {
  nodes._resetAliases();
  const r = nodes.record('https://10.0.11.7:8080', { egressBytes: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.held, true);
  const snap = nodes.snapshot();
  assert.equal(snap.nodes.length, 2);
  assert.deepEqual(snap.ignored.unresolved, ['https://10.0.11.7:8080']);
});

test('http e https do mesmo host são o MESMO nó (o consumo soma no da env)', () => {
  const base = nodes.snapshot().nodes.find((n) => n.node === N1).egressBytes;
  assert.equal(nodes.record('http://n1.containers.snapdeploy.app', { egressBytes: 2 * GB }).ok, true);
  assert.equal(nodes.record('https://N1.containers.snapdeploy.app:443'.replace(':443', ''), { egressBytes: 1 * GB }).ok, true);
  const snap = nodes.snapshot();
  assert.equal(snap.nodes.length, 2);
  assert.equal(snap.nodes.find((n) => n.node === N1).egressBytes, base + 3 * GB);
  assert.equal(nodes.resolveNode('http://n1.containers.snapdeploy.app'), N1);
  assert.equal(nodes.resolveNode('https://10.0.11.39:8080'), '');
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const usageReply = (url) => async () => ({ ok: true, json: async () => ({ url, name: null }) });
const asleepReply = async () => ({ ok: false, status: 503, json: async () => { throw new Error('html'); } });

// O caso real do dono: os nós antigos se anunciam com o IP interno (10.0.11.x:8080) e ele não consegue reenviá-los.
test('nó que se anuncia por IP interno: o servidor descobre de qual nó da env é e NADA se perde', async () => {
  nodes._resetAliases();
  const IP = 'https://10.0.11.39:8080';
  const asked = [];
  nodes._setFetch(async (url) => {
    asked.push(url);
    if (url.startsWith(N2)) return asleepReply();            // N2 dormindo: pula, não acorda
    return usageReply(IP)();                                 // N1 acordado e se anuncia com esse IP
  });
  const before = nodes.snapshot().nodes.find((n) => n.node === N1).egressBytes;
  assert.equal(nodes.record(IP, { egressBytes: 5 * GB, awakeSeconds: 120, streams: 1 }).held, true);
  await tick();
  const mid = nodes.snapshot();
  assert.equal(mid.nodes.length, 2, 'continua sendo só os nós da env');
  assert.equal(mid.nodes.find((n) => n.node === N1).egressBytes, before + 5 * GB, 'o que estava retido entrou no N1');
  assert.deepEqual(mid.ignored.unresolved, []);
  assert.ok(asked.every((u) => u.endsWith('/usage')), 'só leu /usage (GET não acorda nó dormindo)');

  // próximo relatório do mesmo IP já cai direto no N1, sem perguntar de novo
  asked.length = 0;
  assert.deepEqual(nodes.record(IP, { egressBytes: 1 * GB }), { ok: true });
  assert.equal(asked.length, 0);
  assert.equal(nodes.snapshot().nodes.find((n) => n.node === N1).egressBytes, before + 6 * GB);
  nodes._setFetch(async () => { throw new Error('offline (teste)'); });
});

test('todos os nós da env dormindo/fora: relatório fica retido, sem erro e sem nó novo', async () => {
  nodes._resetAliases();
  nodes._setFetch(asleepReply);
  const r = nodes.record('https://10.0.11.48:8080', { egressBytes: 2 * GB });
  assert.equal(r.ok, true);
  await tick();
  const snap = nodes.snapshot();
  assert.equal(snap.nodes.length, 2);
  assert.deepEqual(snap.ignored.unresolved, ['https://10.0.11.48:8080']);
  nodes._setFetch(async () => { throw new Error('offline (teste)'); });
});

test('o vínculo vence quando o nó some (o IP pode ser reaproveitado por outro container)', async (t) => {
  nodes._resetAliases();
  const IP = 'https://10.0.11.99:8080';
  nodes._setFetch(async (url) => (url.startsWith(N1) ? usageReply(IP)() : asleepReply()));
  nodes.record(IP, { egressBytes: 1 });
  await tick();
  assert.equal(nodes.record(IP, { egressBytes: 1 }).held, undefined, 'vinculado ao N1');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(25 * 60000); // 25 min sem relatório
  // agora o mesmo IP pertence ao N2
  nodes._setFetch(async (url) => (url.startsWith(N2) ? usageReply(IP)() : asleepReply()));
  assert.equal(nodes.record(IP, { egressBytes: 7 * GB }).held, true, 'vínculo velho não vale mais');
  t.mock.timers.reset();
  await tick();
  nodes._setFetch(async () => { throw new Error('offline (teste)'); });
});

// Histórico JÁ gravado no Supabase em produção: o mesmo nó com http://, IPs internos e um nó de teste.
test('pull do Supabase: junta http/https do mesmo host e descarta o que não está na env', async () => {
  const usageStore = require('../lib/usageStore');
  const day = new Date().toISOString().slice(0, 10);
  const row = (node, egress, awake) => ({ day, node, name: '', egress_bytes: egress, ingress_bytes: 0, awake_seconds: awake, streams: 1, reports: 1 });
  const rows = [
    row('http://n1.containers.snapdeploy.app', 88 * 1048576, 1800),
    row('https://n2.containers.snapdeploy.app', 10 * 1048576, 600),
    row('http://n2.containers.snapdeploy.app', 173 * 1048576, 1650),
    row('https://10.0.11.39:8080', 44 * 1048576, 1300),
    row('https://10.0.11.48:8080', 52 * 1048576, 2500),
    row('https://10.0.11.7:8080', 15 * 1048576, 1100),
    row('https://conta-teste-antiga.containers.snapdeploy.app', 1, 36)
  ];
  const real = { enabled: usageStore.enabled, call: usageStore.call };
  usageStore.enabled = () => true;
  usageStore.call = async (method, path) => (method === 'GET' ? rows : null);
  try {
    await nodes.pull();
  } finally {
    usageStore.enabled = real.enabled;
    usageStore.call = real.call;
  }
  const snap = nodes.snapshot();
  assert.deepEqual(snap.nodes.map((n) => n.node).sort(), [N1, N2].sort(), 'só os 2 nós da env, não 7');
  const n2 = snap.nodes.find((n) => n.node === N2);
  assert.ok(n2.egressBytes >= 183 * 1048576, 'http + https do n2 somados');
  assert.equal(snap.total.egressBytes, snap.nodes.reduce((a, n) => a + n.egressBytes, 0), 'total = só os nós da env');
  assert.ok(!snap.nodes.some((n) => /10\.0\.11|conta-teste/.test(n.node)), 'IP interno e nó de teste não aparecem');
});

test('ciclo mensal: dia de renovação respeita o dia configurado', () => {
  process.env.TORRENT_NODE_RESET_DAY = '10';
  assert.equal(nodes.currentCycle(new Date('2026-11-18T12:00:00Z')), '2026-11-10');
  assert.equal(nodes.currentCycle(new Date('2026-11-05T12:00:00Z')), '2026-10-10');
  assert.equal(nodes.daysUntilReset(new Date('2026-11-18T12:00:00Z')), 22);
  delete process.env.TORRENT_NODE_RESET_DAY;
});

test.after(() => { try { require('fs').unlinkSync(process.env.TORRENT_NODE_FILE); } catch (e) { /* ok */ } });

test('nós do admin são lembrados para o público (sem TORRENT_NODES); IP interno e localhost não entram', () => {
  const old = process.env.TORRENT_NODES;
  delete process.env.TORRENT_NODES;
  try {
    assert.equal(nodes.publicNodes().filter((u) => u.includes('meunode')).length, 0);
    const added = nodes.rememberNodes(['https://meunode.containers.snapdeploy.app/', 'https://10.0.11.39:8080', 'http://localhost:8091', 'lixo', 'https://semponto']);
    assert.equal(added, 1);
    assert.ok(nodes.publicNodes().includes('https://meunode.containers.snapdeploy.app'));
    assert.ok(!nodes.publicNodes().some((u) => u.includes('10.0.11.39') || u.includes('localhost')));
    process.env.TORRENT_NODES = 'https://daenv.example.com';
    assert.deepEqual(nodes.publicNodes(), ['https://daenv.example.com'], 'a env, quando existe, manda');
  } finally {
    if (old === undefined) delete process.env.TORRENT_NODES; else process.env.TORRENT_NODES = old;
  }
});
