'use strict';

const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const reports = require('../lib/playReports');

const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const T0 = Date.now();
const MIN = 60000;
const headers = (ip) => ({ 'user-agent': UA, 'cf-connecting-ip': ip });
const names = { aaaaaa: 'VidLink Pro', bbbbbb: 'VixSrc' };
const opts = { nameOfSrc: (id) => names[id] || '' };
const movie = { type: 'movie', id: '603', title: 'Matrix' };
const search = (ip, extra, now = T0, query = movie) => reports.onStreamResponse({ query, headers: headers(ip) }, { nameOfSrc: opts.nameOfSrc, ...extra }, now);
const client = (ip, body, now = T0) => reports.onClientReport({ body: { ...movie, ...body }, headers: headers(ip) }, opts, now);

beforeEach(() => reports.reset());

test('busca sem vídeo vira falha com as fontes tentadas, sem token no motivo', async () => {
  search('177.1.1.1', {
    status: 404,
    body: { error: 'Nenhuma fonte' },
    play: { error: 'Nenhuma fonte encontrou', trace: [{ provider: 'VixSrc', outcome: 'erro', ms: 1200, notes: ['HTTP 403 em https://x.test/p.m3u8?token=segredo123'] }] }
  });
  const r = await reports.report({ days: 7 });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].stage, 'busca');
  assert.equal(r.errors[0].title, 'Matrix');
  assert.equal(r.errors[0].reason, 'Nenhuma fonte encontrou este título');
  assert.equal(r.errors[0].trace[0].p, 'VixSrc');
  assert.equal(JSON.stringify(r).includes('segredo123'), false);
  assert.equal(r.titles[0].unresolved, 1);
});

test('a mesma falha repetida em seguida conta uma vez; quem pegou carona herda o motivo', async () => {
  const play = { error: 'fontes fora', trace: [{ provider: 'VidLink Pro', outcome: 'PULADA' }] };
  search('177.1.1.1', { status: 503, body: {}, play });
  search('177.1.1.1', { status: 503, body: {}, play }, T0 + 9000);
  search('177.1.1.2', { status: 503, body: {} }, T0 + 9100); // carona: não rodou o handler
  const r = await reports.report({});
  assert.equal(r.errors.length, 2);
  assert.equal(r.errors.find((e) => e.visitor === '177.1.1.2').trace[0].p, 'VidLink Pro');
});

test('503 depois de "Outra versão" diz que não havia segunda opção', async () => {
  search('177.1.1.1', { status: 503, body: {} }, T0, { ...movie, skip: 'aaaaaa' });
  const r = await reports.report({});
  assert.equal(r.errors[0].reason, 'Não havia outra versão além da descartada');
});

test('uso por fonte em porcentagem; recarregar não infla; via nó aparece separado', async () => {
  client('177.1.1.1', { event: 'ok', src: 'aaaaaa' });
  client('177.1.1.1', { event: 'ok', src: 'aaaaaa' }, T0 + MIN);
  client('177.1.1.2', { event: 'ok', src: 'bbbbbb' });
  client('177.1.1.3', { event: 'ok', src: 'bbbbbb' });
  client('177.1.1.4', { event: 'ok', src: 'aaaaaa', via: 'adshield' });
  const r = await reports.report({});
  const by = Object.fromEntries(r.sources.map((s) => [s.source, s]));
  assert.equal(r.totals.plays, 4);
  assert.equal(by.VixSrc.pct, 50);
  assert.equal(by['VidLink Pro'].pct, 25);
  assert.equal(by['VidLink Pro · via nó'].plays, 1);
  assert.equal(r.visitors['177.1.1.2'].sources[0].source, 'VixSrc');
  assert.equal(r.visitors['177.1.1.2'].sources[0].pct, 100);
});

test('falha do player conta contra a fonte e é marcada quando outra versão toca', async () => {
  search('177.1.1.1', { status: 200, body: { url: 'https://v.test/a.m3u8', src: 'aaaaaa' } });
  client('177.1.1.1', { event: 'fail', stage: 'troca', src: 'aaaaaa', reason: 'A pessoa pediu outra versão' }, T0 + MIN);
  client('177.1.1.1', { event: 'ok', src: 'bbbbbb' }, T0 + 2 * MIN);
  const r = await reports.report({});
  assert.equal(r.errors[0].source, 'VidLink Pro');
  assert.equal(r.errors[0].resolvedBy, 'VixSrc');
  const vidlink = r.sources.find((s) => s.source === 'VidLink Pro');
  assert.deepEqual([vidlink.delivered, vidlink.fails, vidlink.plays], [1, 1, 0]);
  assert.equal(r.totals.unresolved, 0);
});

test('torrent resolve a busca que falhou; iframe externo conta uso mas não resolve', async () => {
  search('177.1.1.1', { status: 404, body: {} });
  client('177.1.1.1', { event: 'embed', embed: 'VidSrc <b>' }, T0 + 1000);
  let r = await reports.report({});
  assert.equal(r.errors[0].resolvedBy, '');
  assert.equal(r.sources[0].source, 'Player externo: VidSrc b');
  client('177.1.1.1', { event: 'ok', engine: 'torrent' }, T0 + 2000);
  r = await reports.report({});
  assert.equal(r.errors[0].resolvedBy, 'Torrent');
});

test('robô, dados inválidos e excesso de avisos são recusados', async () => {
  assert.equal(reports.onClientReport({ body: { ...movie, event: 'ok', src: 'aaaaaa' }, headers: { 'user-agent': 'curl/8.5.0 (x86_64)' } }, opts).ok, false);
  assert.equal(client('177.9.9.9', { event: 'fail', stage: 'busca', reason: 'forjado' }).ok, false);
  assert.equal(client('177.9.9.9', { event: 'fail', stage: 'player', id: 'abc' }).ok, false);
  assert.equal(client('177.9.9.9', { event: 'ok', src: 'ffffff' }).ignored, true);
  let limited = false;
  for (let i = 0; i < 100; i += 1) limited = limited || client('177.8.8.8', { event: 'fail', stage: 'player', reason: `r${i}` }).limited === true;
  assert.equal(limited, true);
});
