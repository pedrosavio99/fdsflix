'use strict';

// Catálogo no Supabase (banco falso em memória): leitura paginada, gravação, "não achei", remoção e status.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const catalog = require('../lib/catalog');
const harvest = require('../lib/catalogHarvest');

function fakeDb() {
  const rows = new Map();
  const calls = [];
  return {
    rows, calls,
    enabled: () => true,
    async call(method, pathAndQuery, body) {
      calls.push(`${method} ${pathAndQuery}`);
      if (method === 'GET') {
        const out = [...rows.entries()].filter(([k]) => k.startsWith('catalog')).map(([k, v]) => ({ k, v }));
        const m = /offset=(\d+)/.exec(pathAndQuery);
        return out.slice(m ? Number(m[1]) : 0, (m ? Number(m[1]) : 0) + 1000);
      }
      if (method === 'POST') { rows.set(body.k, body.v); return null; }
      if (method === 'DELETE') {
        const inList = /k=in\.\((.*)\)/.exec(pathAndQuery);
        const eq = /k=eq\.(.*)$/.exec(pathAndQuery);
        const keys = inList ? inList[1].split(',') : eq ? [eq[1]] : [];
        keys.forEach((k) => rows.delete(decodeURIComponent(k)));
        return null;
      }
      return null;
    }
  };
}

beforeEach(() => {
  process.env.CATALOG_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catstore-')), 'c.json');
});

test('grava no Supabase, lê de volta e serve pelo findStream', async () => {
  const db = fakeDb();
  catalog.setDb(db);
  const where = await catalog.putMovie(129, { title: 'Chihiro', year: '2001', entries: [{ source: 'manual', url: 'http://127.0.0.1:1/x.mp4', audioLang: 'por' }] });
  assert.equal(where, 'supabase');
  assert.ok(db.rows.has('catalog:129'));
  // outra instância (cache zerado) enxerga a linha
  catalog.setDb(db);
  await catalog.refreshRemote();
  assert.equal(catalog.size(), 1);
  const st = await catalog.status();
  assert.equal(st.storage, 'supabase');
  assert.equal(st.movies, 1);
  assert.equal(st.dubbed, 1);
  assert.equal(st.recent[0].id, '129');
});

test('"não achei" vai para catalogmiss e removeMovie apaga as duas linhas', async () => {
  const db = fakeDb();
  catalog.setDb(db);
  await catalog.putMiss(5);
  assert.ok(db.rows.has('catalogmiss:5'));
  await catalog.putMovie(5, { title: 'X', entries: [{ source: 'm', url: 'https://a.b/c.mp4' }] });
  assert.ok(!db.rows.has('catalogmiss:5'));
  await catalog.removeMovie(5);
  assert.ok(!db.rows.has('catalog:5'));
  assert.equal(catalog.size(), 0);
});

test('Supabase fora do ar: não derruba, o status mostra o erro e o arquivo continua valendo', async () => {
  catalog.setDb({ enabled: () => true, async call() { throw new Error('sem resposta'); } });
  fs.writeFileSync(process.env.CATALOG_FILE, JSON.stringify({ movies: { 7: { title: 'Arq', entries: [] } }, misses: {} }));
  const st = await catalog.status({ refresh: true });
  assert.equal(st.supabaseOk, false);
  assert.match(st.supabaseError, /sem resposta/);
  assert.equal(st.movies, 1);
});

test('sem Supabase grava no arquivo', async () => {
  catalog.setDb({ enabled: () => false });
  assert.equal(await catalog.putMovie(9, { title: 'Local', entries: [] }), 'arquivo');
  assert.ok(JSON.parse(fs.readFileSync(process.env.CATALOG_FILE, 'utf8')).movies['9']);
  catalog.setDb(null);
});

test('parseOptions limita o que o painel pode pedir', () => {
  const o = harvest.parseOptions({ pages: 999, delay: 1, lists: 'popular,hackeada', ids: '12,abc,34' });
  assert.equal(o.pages, 25);
  assert.equal(o.delay, 2500);
  assert.deepEqual(o.lists, ['popular']);
  assert.deepEqual(o.ids, ['12', '34']);
});
