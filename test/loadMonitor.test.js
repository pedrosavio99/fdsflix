'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoadMonitor, evaluate, readLimits, readContainer, readProc, percentile } = require('../lib/loadMonitor');

const fakeFs = (files) => (file) => { if (file in files) return files[file]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };

test('lê o limite do Render Free (0,1 CPU e 512 MB) no cgroup v2', () => {
  const l = readLimits(fakeFs({ '/sys/fs/cgroup/cpu.max': '10000 100000\n', '/sys/fs/cgroup/memory.max': '536870912\n' }), { cpus: 8, mem: 16e9 });
  assert.equal(l.cores, 0.1);
  assert.equal(l.memBytes, 536870912);
  assert.equal(l.cpuSource, 'cgroup');
});

test('cgroup v1 e "max" (sem limite) caem para o que existe', () => {
  const v1 = readLimits(fakeFs({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '50000', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000', '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824' }), { cpus: 4, mem: 8e9 });
  assert.equal(v1.cores, 0.5);
  assert.equal(v1.memBytes, 1073741824);
  const none = readLimits(fakeFs({ '/sys/fs/cgroup/cpu.max': 'max 100000', '/sys/fs/cgroup/memory.max': 'max' }), { cpus: 4, mem: 8e9 });
  assert.equal(none.cores, 4);
  assert.equal(none.memBytes, 8e9);
  assert.equal(none.cpuSource, 'máquina');
});

test('lê memória atual e "throttle" do contêiner; sem cgroup devolve null', () => {
  const c = readContainer(fakeFs({ '/sys/fs/cgroup/memory.current': '300000000', '/sys/fs/cgroup/cpu.stat': 'usage_usec 5\nnr_throttled 7\nthrottled_usec 123456\n' }));
  assert.equal(c.memBytes, 300000000);
  assert.equal(c.throttledUs, 123456);
  assert.equal(c.throttledCount, 7);
  const empty = readContainer(fakeFs({}));
  assert.equal(empty.memBytes, null);
  assert.equal(empty.throttledUs, null);
});

test('lê CPU e memória do processo filho (CinePro) em /proc; nome do processo com espaço não atrapalha', () => {
  const stat = '123 (node cine) S 1 1 1 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 5 0 100 1000 1 18446744073709551615';
  const read = fakeFs({ '/proc/123/stat': stat, '/proc/123/status': 'Name:\tnode\nVmRSS:\t  153600 kB\n' });
  const p = readProc(123, read);
  assert.equal(p.cpuSec, 3); // (250 + 50) ticks / 100
  assert.equal(p.rssBytes, 153600 * 1024);
  assert.equal(readProc(null, read), null);
  assert.equal(readProc(999, read), null);
});

test('percentil simples', () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 6);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

test('alertas: tudo calmo = verde; cada sinal sobe o nível e vem com explicação em português', () => {
  const calm = { cpuPct: 20, throttledPct: 0, lagP99Ms: 10, memPct: 40, streamP95Ms: 1500, streamN60: 10, streamFailPct: 0, guard: { waiting: 0, queueTimeoutsLastMin: 0 }, breaker: { open: false } };
  assert.equal(evaluate(calm).level, 'ok');
  assert.equal(evaluate(calm).items.length, 0);

  assert.equal(evaluate({ ...calm, cpuPct: 75 }).level, 'warn');
  assert.equal(evaluate({ ...calm, cpuPct: 95 }).level, 'bad');
  assert.equal(evaluate({ ...calm, throttledPct: 30 }).level, 'warn');
  assert.equal(evaluate({ ...calm, throttledPct: 60 }).level, 'bad');
  assert.equal(evaluate({ ...calm, lagP99Ms: 250 }).level, 'warn');
  assert.equal(evaluate({ ...calm, lagP99Ms: 900 }).level, 'bad');
  assert.equal(evaluate({ ...calm, memPct: 80 }).level, 'warn');
  assert.equal(evaluate({ ...calm, memPct: 93 }).level, 'bad');
  assert.equal(evaluate({ ...calm, streamP95Ms: 8000 }).level, 'warn');
  assert.equal(evaluate({ ...calm, streamP95Ms: 20000 }).level, 'bad');
  assert.equal(evaluate({ ...calm, streamFailPct: 30 }).level, 'warn');
  assert.equal(evaluate({ ...calm, streamFailPct: 70 }).level, 'bad');
  assert.equal(evaluate({ ...calm, guard: { waiting: 3, queueTimeoutsLastMin: 0 } }).level, 'warn');
  assert.equal(evaluate({ ...calm, guard: { waiting: 20, queueTimeoutsLastMin: 0 } }).level, 'bad');
  assert.equal(evaluate({ ...calm, breaker: { open: true, reason: 'x' } }).level, 'warn');

  const many = evaluate({ ...calm, cpuPct: 95, memPct: 80 });
  assert.equal(many.level, 'bad');
  assert.equal(many.items[0].level, 'bad', 'o mais grave vem primeiro');
  assert.ok(many.items.every((i) => i.title && i.detail));
});

test('sem poucos plays no minuto não dispara alerta de lentidão nem de falha (evita falso alarme)', () => {
  const r = evaluate({ cpuPct: 5, lagP99Ms: 5, memPct: 30, streamP95Ms: 30000, streamN60: 2, streamFailPct: 100, guard: null, breaker: null });
  assert.equal(r.level, 'ok');
});

function monitor(extra = {}) {
  let t = 1_000_000;
  const m = createLoadMonitor({
    now: () => t, read: fakeFs({ '/sys/fs/cgroup/cpu.max': '10000 100000', '/sys/fs/cgroup/memory.max': '536870912', '/sys/fs/cgroup/memory.current': '268435456' }),
    visitorOf: (req) => req.ip, isBot: (ua) => /bot/.test(String(ua || '')), ...extra
  });
  return { m, advance: (ms) => { t += ms; }, tick: () => { t += 5000; m.sample(); } };
}

function fakeReq(ip, path, headers = {}) { return { ip, path, url: path, headers: { 'user-agent': 'Mozilla/5.0 browser', ...headers } }; }
function fakeRes(status) {
  const handlers = {};
  return { statusCode: status, once(ev, fn) { handlers[ev] = fn; }, end() { (handlers.finish || (() => {}))(); } };
}
function hit(m, ip, path, status = 200, headers = {}) {
  const res = fakeRes(status);
  m.middleware(fakeReq(ip, path, headers), res, () => {});
  res.end();
}

test('conta online (último minuto), assistindo e plays; ignora admin, bot e rotas internas', () => {
  const { m, tick } = monitor();
  hit(m, '1.1.1.1', '/');
  hit(m, '2.2.2.2', '/api/stream', 200);
  hit(m, '3.3.3.3', '/api/stream', 503);
  hit(m, '4.4.4.4', '/api/site/status');
  hit(m, '9.9.9.9', '/api/stream', 200, { 'x-stats-key': '118111' }); // admin: não conta como visitante
  hit(m, '8.8.8.8', '/', 200, { 'user-agent': 'Googlebot/2.1 bot' });  // bot
  hit(m, '7.7.7.7', '/api/health');                                  // interno
  hit(m, '7.7.7.7', '/api/admin/load');
  tick();
  const c = m.current();
  assert.equal(c.online, 4);
  assert.equal(c.watching, 1);
  assert.equal(c.playsPerMin, 2, 'admin conta como play de servidor, não como visitante; mas 200 do visitante + 200 do admin = 2');
  assert.equal(c.streamN60, 3);
  assert.ok(Math.abs(c.streamFailPct - 100 / 3) < 0.01);
});

test('visitante some do "online" depois de 1 minuto sem falar com a API', () => {
  const { m, advance, tick } = monitor();
  hit(m, '1.1.1.1', '/');
  tick();
  assert.equal(m.current().online, 1);
  for (let i = 0; i < 13; i += 1) tick(); // 65 s
  assert.equal(m.current().online, 0);
  assert.equal(m.current().online5, 1);
  advance(0);
});

test('memória do contêiner contra o limite e histórico limitado', () => {
  const { m, tick } = monitor();
  tick();
  const c = m.current();
  assert.equal(c.memPct, 50);
  for (let i = 0; i < 400; i += 1) tick();
  assert.ok(m._series.length <= 360);
  const snap = m.snapshot();
  assert.equal(snap.limits.cpuCores, 0.1);
  assert.equal(snap.limits.memMB, 512);
  assert.equal(snap.series.t.length, m._series.length);
  assert.equal(m.snapshot({ lite: true }).series, undefined);
  m.stop();
});

test('projeção de teto de online só aparece com amostra suficiente', () => {
  const { m, tick } = monitor();
  for (let i = 0; i < 3; i += 1) { hit(m, `10.0.0.${i}`, '/'); }
  tick();
  assert.equal(m.current().projectedMaxOnline, null, 'poucos online: não projeta');
  m.stop();
});

test('estado do streamGuard e do disjuntor entram no resumo e nos alertas', () => {
  const { m, tick } = monitor({
    getGuard: () => ({ waiting: 4, active: 30, queueTimeouts: 0, coalesced: 10 }),
    getBreaker: () => ({ open: true, reason: 'apiToken ausente' })
  });
  tick();
  const c = m.current();
  assert.equal(c.guard.waiting, 4);
  assert.equal(c.level, 'warn');
  assert.ok(c.alerts.some((a) => /Fila/.test(a.title)));
  assert.ok(c.alerts.some((a) => /disjuntor/i.test(a.title)));
  m.stop();
});
