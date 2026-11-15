'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const site = require('../lib/siteStatus');

const NOW = 1_800_000_000_000;
const memDb = { enabled: () => false };

function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    enabled: () => true,
    async call(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET') return rows || [];
      return null;
    }
  };
}

test('site: valida e limpa o que o admin envia', () => {
  const v = site.normalize({ maintenance: { on: true, message: '  Já <b>volto</b>\n\n  em breve  ' }, moved: { on: false, url: '' } }, NOW);
  assert.deepEqual(v.maintenance, { on: true, message: 'Já bvolto/b em breve' });
  assert.equal(v.updatedAt, NOW);
  assert.equal(site.normalize({ maintenance: { message: 'x'.repeat(500) } }, NOW).maintenance.message.length, 200);
  assert.equal(site.normalize({}, NOW).maintenance.on, false, 'só true liga (nada de "false" em string ligar)');
  assert.equal(site.normalize({ maintenance: { on: 'false' } }, NOW).maintenance.on, false);
});

test('site: a URL nova é obrigatória ao ligar e só aceita http(s) sem senha', () => {
  assert.throws(() => site.normalize({ moved: { on: true, url: '' } }), /endereço novo/);
  assert.throws(() => site.normalize({ moved: { on: true, url: 'javascript:alert(1)' } }), /http/);
  assert.throws(() => site.normalize({ moved: { on: true, url: 'https://user:pass@a.com' } }), /usuário/);
  assert.throws(() => site.normalize({ moved: { on: true, url: 'semponto' } }), /domínio/);
  assert.equal(site.normalize({ moved: { on: true, url: 'novo.exemplo.com' } }).moved.url, 'https://novo.exemplo.com');
  assert.equal(site.normalize({ moved: { on: true, url: 'https://novo.exemplo.com/app/?a=1' } }).moved.url, 'https://novo.exemplo.com/app/?a=1');
  assert.equal(site.normalize({ moved: { on: false, url: '' } }).moved.url, '');
});

test('site: a manutenção bloqueia /api e /hls dos visitantes, mas não o admin nem o essencial', () => {
  const on = { maintenance: { on: true } };
  const off = { maintenance: { on: false } };
  assert.equal(site.blockedByMaintenance('/api/search', on, false), true);
  assert.equal(site.blockedByMaintenance('/api/stream/vidsrc', on, false), true);
  assert.equal(site.blockedByMaintenance('/hls/abc/index.m3u8', on, false), true);
  assert.equal(site.blockedByMaintenance('/api/search', on, true), false, 'admin passa');
  assert.equal(site.blockedByMaintenance('/api/search', off, false), false);
  assert.equal(site.blockedByMaintenance('/api/site/status', on, false), false, 'o estado nunca é bloqueado');
  assert.equal(site.blockedByMaintenance('/api/health', on, false), false, 'saúde (Render) nunca é bloqueada');
  assert.equal(site.blockedByMaintenance('/api/admin/check', on, false), false);
  assert.equal(site.blockedByMaintenance('/index.html', on, false), false, 'a página em si carrega (o aviso é desenhado por ela)');
  assert.equal(site.blockedByMaintenance('/api/healthz-fake', on, false), false, 'prefixo de /api/health é isento');
});

test('site: visão pública traz mensagem padrão e esconde a URL quando o aviso está desligado', async () => {
  const s = site.createSiteStatus({ now: () => NOW, db: memDb });
  await s.set({ maintenance: { on: true, message: '' }, moved: { on: false, url: 'https://guardada.exemplo.com' } });
  const pub = s.publicView();
  assert.equal(pub.maintenance.on, true);
  assert.equal(pub.maintenance.message, site.DEFAULT_MESSAGE);
  assert.equal(pub.moved.url, '');
  assert.equal(s.adminView().moved.url, 'https://guardada.exemplo.com', 'o admin continua vendo o rascunho');
  await s.set({ moved: { on: true, url: 'https://guardada.exemplo.com' } });
  assert.equal(s.publicView().moved.url, 'https://guardada.exemplo.com');
});

test('site: grava no Supabase (tabela pix_settings, chave site_status) e relê ao acordar', async () => {
  const db = fakeDb();
  const s = site.createSiteStatus({ now: () => NOW, db });
  await s.set({ maintenance: { on: true, message: 'Volto já' }, moved: { on: false, url: '' } });
  const w = db.calls.find((c) => c.method === 'POST');
  assert.match(w.path, /^\/pix_settings\?on_conflict=k/);
  assert.equal(w.body.k, 'site_status');
  assert.equal(w.body.v.maintenance.on, true);

  const fresh = site.createSiteStatus({ now: () => NOW, db: fakeDb([{ v: w.body.v }]) });
  await fresh.ready();
  assert.equal(fresh.snapshot().maintenance.on, true);
  assert.equal(fresh.snapshot().maintenance.message, 'Volto já');
});

test('site: renova do Supabase em segundo plano quando o cache está velho (outra instância mudou)', async () => {
  let clock = NOW;
  let stored = { maintenance: { on: false, message: '' }, moved: { on: false, url: '' } };
  const db = { enabled: () => true, async call(m) { return m === 'GET' ? [{ v: stored }] : null; } };
  const s = site.createSiteStatus({ now: () => clock, db });
  await s.ready();
  assert.equal(s.snapshot().maintenance.on, false);
  stored = { maintenance: { on: true, message: 'x' }, moved: { on: false, url: '' } };
  clock += 25000;
  await s.ready();                     // dispara a renovação
  await s._state.loading;              // espera ela terminar
  assert.equal(s.snapshot().maintenance.on, true);
});

test('site: Supabase fora ou sem tabela não derruba: segue na memória e avisa', async () => {
  const missing = { enabled: () => true, async call() { const e = new Error('tabelas não criadas'); e.tablesMissing = true; throw e; } };
  const s = site.createSiteStatus({ now: () => NOW, db: missing });
  await s.set({ maintenance: { on: true } });
  assert.equal(s.snapshot().maintenance.on, true);
  assert.equal(s.adminView().persist.tablesMissing, true);

  const down = { enabled: () => true, async call() { throw new Error('sem resposta do Supabase'); } };
  const s2 = site.createSiteStatus({ now: () => NOW, db: down });
  await s2.ready();                    // não lança
  assert.equal(s2.snapshot().maintenance.on, false, 'falha de leitura = site normal (não bloqueia por engano)');
});
