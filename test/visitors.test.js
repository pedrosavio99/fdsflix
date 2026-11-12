'use strict';

const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.GEO_API_URL = 'off'; // nenhum teste vai à internet, a menos que ele mesmo injete um fetch falso

const visitors = require('../lib/visitors');
const geo = require('../lib/geo');
const usageStore = require('../lib/usageStore');

const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const UA_WIN_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
const DAY = 86400000;
const T0 = Date.parse('2026-11-11T12:00:00Z');

function req(ip, path = '/', opts = {}) {
  return {
    method: opts.method || 'GET',
    path,
    query: opts.query || {},
    headers: { 'user-agent': opts.ua || UA_ANDROID, 'cf-connecting-ip': ip }
  };
}

beforeEach(() => {
  visitors.reset();
  geo.reset();
  delete process.env.VISITORS_HASH_IP;
  delete process.env.VISITORS_OFF;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
});

test('IP do visitante: cabeçalho da borda vence; IPv6-mapeado vira IPv4; lixo é ignorado', () => {
  const h = (headers, extra = {}) => visitors.clientIp({ headers, ...extra });
  assert.equal(h({ 'cf-connecting-ip': '177.12.34.56', 'x-forwarded-for': '9.9.9.9' }), '177.12.34.56');
  assert.equal(h({ 'true-client-ip': '177.12.34.57' }), '177.12.34.57');
  assert.equal(h({ 'x-forwarded-for': '200.1.2.3, 10.0.0.1' }), '200.1.2.3');
  assert.equal(h({}, { ip: '::ffff:200.9.9.9' }), '200.9.9.9');
  assert.equal(h({ 'cf-connecting-ip': 'não-é-ip', 'x-forwarded-for': '201.2.3.4' }), '201.2.3.4');
  assert.equal(h({ 'cf-connecting-ip': '2804:14D:5C80::1' }), '2804:14d:5c80::1');
  assert.equal(h({}), '');
});

test('aparelho e bots', () => {
  assert.equal(visitors.parseDevice(UA_ANDROID), 'Android · Chrome');
  assert.equal(visitors.parseDevice(UA_IPHONE), 'iPhone · Safari');
  assert.equal(visitors.parseDevice(UA_WIN_EDGE), 'Windows · Edge');
  assert.equal(visitors.parseDevice('Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 Chrome/94 TV Safari/537.36'), 'TV · Chrome');
  assert.equal(visitors.isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
  assert.equal(visitors.isBot('UptimeRobot/2.0'), true);
  assert.equal(visitors.isBot('curl/8.5.0'), true);
  assert.equal(visitors.isBot(''), true);
  assert.equal(visitors.isBot(UA_ANDROID), false);
  assert.equal(visitors.isBot('Mozilla/5.0 (Linux; Android 12; CUBOT_X30) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'), false, 'Cubot é aparelho, não robô');
});

test('o que conta como acesso: página, API e vídeo; health, usage e bots não', () => {
  const c = visitors.classify;
  assert.deepEqual(c(req('1.1.1.1', '/')), { count: true, watch: '' });
  assert.deepEqual(c(req('1.1.1.1', '/api/search')), { count: true, watch: '' });
  assert.equal(c(req('1.1.1.1', '/api/health')), null);
  assert.equal(c(req('1.1.1.1', '/api/visitors')), null);
  assert.equal(c(req('1.1.1.1', '/api/usage/stats')), null);
  assert.equal(c(req('1.1.1.1', '/logo.png')), null, 'arquivo estático não é acesso');
  assert.equal(c(req('1.1.1.1', '/api/search', { method: 'HEAD' })), null);
  assert.deepEqual(c(req('1.1.1.1', '/api/usage', { method: 'POST' })), { count: false, watch: '', touch: true });
  assert.equal(c(req('1.1.1.1', '/api/stream', { method: 'POST' })), null);

  const movie = c(req('1.1.1.1', '/api/stream', { query: { id: '603', type: 'movie', title: 'Matrix <b>' } }));
  assert.equal(movie.watch, 'Matrix b', 'o título é limpo de < > e aspas');
  const ep = c(req('1.1.1.1', '/api/stream', { query: { id: '1396', type: 'tv', title: 'Breaking Bad', s: '2', e: '5' } }));
  assert.equal(ep.watch, 'Breaking Bad T2E5');
  assert.equal(c(req('1.1.1.1', '/api/stream', { query: { id: '7', type: 'movie' } })).watch, 'TMDB 7');
});

test('contagem: soma por IP e por dia, ignora bot, e a localização conhecida entra na linha', () => {
  geo.seed('177.12.34.56', { country: 'BR', region: 'Rio de Janeiro', city: 'Niterói', isp: 'Algar' });
  visitors.record(req('177.12.34.56', '/'), T0);
  visitors.record(req('177.12.34.56', '/api/search'), T0 + 1000);
  const row = visitors.record(req('177.12.34.56', '/api/stream', { query: { id: '603', type: 'movie', title: 'Matrix' } }), T0 + 2000);
  assert.equal(row.requests, 3);
  assert.equal(row.watches, 1);
  assert.equal(row.last_watch, 'Matrix');
  assert.equal(row.city, 'Niterói');
  assert.equal(row.device, 'Android · Chrome');

  assert.equal(visitors.record(req('8.8.8.8', '/', { ua: 'Googlebot/2.1 (+http://www.google.com/bot.html)' }), T0), null);
  const next = visitors.record(req('177.12.34.56', '/'), T0 + DAY);
  assert.equal(next.requests, 1, 'outro dia, outra linha');
  assert.equal(visitors.record(req('127.0.0.1', '/api/search'), T0), null, 'o próprio servidor não é visitante');
  assert.equal(visitors.record(req('10.0.3.4', '/'), T0), null, 'rede privada não é visitante');
  visitors.reset();
  process.env.VISITORS_OFF = '1';
  assert.equal(visitors.record(req('177.12.34.56', '/'), T0), null, 'VISITORS_OFF desliga a coleta');
});

test('estatísticas: únicos, voltaram, países, cidades, aparelhos e quem está online', async () => {
  geo.seed('177.12.34.56', { country: 'BR', region: 'RJ', city: 'Niterói', isp: 'Algar' });
  geo.seed('200.1.2.3', { country: 'BR', region: 'SP', city: 'São Paulo', isp: 'Vivo' });
  geo.seed('8.8.8.8', { country: 'US', region: 'California', city: 'San Jose', isp: 'Google' });

  visitors.record(req('177.12.34.56', '/', { ua: UA_ANDROID }), T0 - DAY);   // ontem
  visitors.record(req('177.12.34.56', '/', { ua: UA_ANDROID }), T0);         // e hoje: voltou
  visitors.record(req('200.1.2.3', '/api/stream', { ua: UA_IPHONE, query: { id: '603', type: 'movie', title: 'Matrix' } }), T0);
  visitors.record(req('8.8.8.8', '/', { ua: UA_WIN_EDGE }), T0 - 2 * DAY);   // há 2 dias, fora de "hoje"
  visitors.record(req('200.1.2.3', '/api/usage', { method: 'POST', ua: UA_IPHONE }), T0 + 60000); // só marca online

  const s = await visitors.stats({ days: 7, now: T0 + 60000 });
  assert.equal(s.today.visitors, 2);
  assert.equal(s.period.visitors, 3);
  assert.equal(s.period.returning, 1);
  assert.equal(s.period.watches, 1);
  assert.equal(s.period.requests, 4, 'quatro acessos reais; o heartbeat do player não soma');
  assert.deepEqual(s.countries, [{ country: 'BR', visitors: 2 }, { country: 'US', visitors: 1 }]);
  assert.equal(s.cities.some((c) => c.city === 'Niterói, RJ, BR'), true);
  assert.deepEqual(s.devices.map((d) => d.device).sort(), ['Android · Chrome', 'Windows · Edge', 'iPhone · Safari']);
  assert.equal(s.online.count, 2, 'hoje: o de Niterói (T0) e o de São Paulo (heartbeat), dentro de 5 min');
  assert.equal(s.series.length, 7);
  assert.equal(s.hours.length, 24);
  assert.equal(s.hours[9], 4, '12:00Z = 9h em Brasília; as quatro visitas (visitante+dia) chegaram nessa hora');
  assert.equal(s.hours.reduce((x, y) => x + y, 0), 4);
  assert.equal(s.series[s.series.length - 1].visitors, 2);
  const sp = s.visitors.find((v) => v.visitor === '200.1.2.3');
  assert.equal(sp.lastWatch, 'Matrix');
  assert.equal(sp.online, true);
  assert.equal(sp.location, 'São Paulo, SP, BR');
  assert.match(s.storage.note, /Sem Supabase/);

  const today = await visitors.stats({ days: 1, now: T0 + 60000 });
  assert.equal(today.period.visitors, 2, 'janela de 1 dia = só hoje');
});

test('VISITORS_HASH_IP=1: guarda hash, não o IP, e a contagem de pessoas continua certa', async () => {
  process.env.VISITORS_HASH_IP = '1';
  visitors.record(req('177.12.34.56', '/'), T0);
  visitors.record(req('177.12.34.56', '/api/search'), T0 + 1);
  visitors.record(req('200.1.2.3', '/'), T0);
  const s = await visitors.stats({ days: 1, now: T0 + 5 });
  assert.equal(s.period.visitors, 2);
  assert.equal(s.hashed, true);
  assert.equal(s.visitors.every((v) => /^h_[0-9a-f]{20}$/.test(v.visitor)), true);
  assert.equal(JSON.stringify(s).includes('177.12.34.56'), false);
});

test('geo: lê ipwho.is (e formato ip-api), não consulta IP privado e não repete consulta', async () => {
  delete process.env.GEO_API_URL; // padrão: ligado
  try {
    let calls = 0;
    const fake = async (url) => {
      calls += 1;
      assert.match(String(url), /^https:\/\/ipwho\.is\/177\.12\.34\.56\?/);
      return new Response(JSON.stringify({ success: true, country_code: 'BR', region: 'Rio de Janeiro', city: 'Rio de Janeiro', connection: { isp: 'Predlink' } }), { status: 200 });
    };
    const g = await geo.lookup('177.12.34.56', fake);
    assert.deepEqual(g, { country: 'BR', region: 'Rio de Janeiro', city: 'Rio de Janeiro', isp: 'Predlink' });
    assert.deepEqual(await geo.lookup('177.12.34.56', fake), g);
    assert.equal(calls, 1, 'segunda vez vem do cache');
    assert.equal(await geo.lookup('192.168.0.10', fake), null);
    assert.equal(await geo.lookup('127.0.0.1', fake), null);
    assert.equal(calls, 1, 'IP privado nem sai para a rede');

    assert.deepEqual(geo.parse({ status: 'success', countryCode: 'br', regionName: 'SP', city: 'Santos', isp: 'Claro' }),
      { country: 'BR', region: 'SP', city: 'Santos', isp: 'Claro' });
    assert.equal(geo.parse({ success: false, message: 'Invalid IP' }), null);
    assert.equal(geo.isPrivate('10.1.2.3'), true);
    assert.equal(geo.isPrivate('172.20.0.1'), true);
    assert.equal(geo.isPrivate('8.8.8.8'), false);
  } finally {
    process.env.GEO_API_URL = 'off';
  }
  assert.equal(await geo.lookup('8.8.8.8', async () => { throw new Error('não devia chamar'); }), null, 'GEO_API_URL=off desliga');
});

test('Supabase: envia em lote, não perde nada se falhar e não suja o estado do painel de consumo', async () => {
  process.env.SUPABASE_URL = 'http://127.0.0.1:9';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_teste';
  const realFetch = globalThis.fetch;
  const sent = [];
  let failNext = true;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null, method: init && init.method });
    if (String(url).includes('/rpc/fdsflix_add_visits') && failNext) {
      failNext = false;
      return new Response(JSON.stringify({ code: 'PGRST202', message: 'função inexistente' }), { status: 404 });
    }
    return new Response('', { status: 200 });
  };
  try {
    const statusBefore = JSON.stringify(usageStore.getStatus());
    geo.seed('177.12.34.56', { country: 'BR', region: 'RJ', city: 'Niterói', isp: 'Algar' });
    visitors.record(req('177.12.34.56', '/'), T0);
    visitors.record(req('177.12.34.56', '/api/stream', { query: { id: '603', type: 'movie', title: 'Matrix' } }), T0 + 1000);

    const bad = await visitors.flush();
    assert.equal(bad.ok, false);
    assert.equal(JSON.stringify(usageStore.getStatus()), statusBefore, 'falha dos visitantes não vira erro do consumo');

    visitors.record(req('177.12.34.56', '/api/search'), T0 + 2000); // chegou mais um depois da falha
    const ok = await visitors.flush();
    assert.equal(ok.ok, true);
    const rpc = sent.filter((c) => c.url.endsWith('/rpc/fdsflix_add_visits'));
    assert.equal(rpc.length, 2);
    const rows = rpc[1].body.p_rows;
    assert.equal(rows.length, 1, 'uma linha por dia/visitante');
    assert.equal(rows[0].requests, 3, 'a primeira tentativa que falhou foi somada de volta');
    assert.equal(rows[0].watches, 1);
    assert.equal(rows[0].visitor, '177.12.34.56');
    assert.equal(rows[0].city, 'Niterói');
    assert.equal(rows[0].last_watch, 'Matrix');
    assert.equal(rows[0].day, '2026-11-11');
    const clean = await visitors.flush();
    assert.equal(clean.sent, 0, 'nada pendente depois do sucesso');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
  }
});
