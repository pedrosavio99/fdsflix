'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const live = require('../lib/liveTv');
const { probeSource, parsePlaylist, isPrivateIp, isPagePlayer } = require('../lib/liveProbe');
const { CHANNELS } = require('../lib/liveChannels');
const { verifyToken } = require('../adproxy/lib/urls');
const { loadConfig } = require('../adproxy/lib/config');

const TS = Buffer.alloc(376); TS[0] = 0x47; TS[188] = 0x47;

function fakeFetch(routes) {
  return async (url, init) => {
    const r = routes[url];
    if (!r) return new Response('nao', { status: 404 });
    if (r.redirect) return new Response(null, { status: 302, headers: { location: r.redirect } });
    if (r.hang) await new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('abort'), { name: 'AbortError' }))));
    return new Response(r.body, { status: r.status || 200, headers: r.headers || {} });
  };
}
const opts = (routes) => ({ fetchImpl: fakeFetch(routes), skipHostCheck: true, timeoutMs: 500 });

test.beforeEach(() => live._reset());

/* ------------------------------- probe -------------------------------- */

test('probe: playlist de mídia + segmento TS = fonte viva', async () => {
  const r = await probeSource('http://a.example/live/index.m3u8', opts({
    'http://a.example/live/index.m3u8': { body: '#EXTM3U\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nseg2.ts\n', headers: { 'access-control-allow-origin': '*' } },
    'http://a.example/live/seg2.ts': { body: TS }
  }));
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'hls');
  assert.equal(r.cors, true);
  assert.equal(r.https, false);
  assert.equal(r.port, '80');
});

test('probe: master escolhe variante do meio e confere o segmento dela', async () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nmid.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=8000000\nhigh.m3u8\n';
  const r = await probeSource('https://b.example/m.m3u8', opts({
    'https://b.example/m.m3u8': { body: master },
    'https://b.example/mid.m3u8': { body: '#EXTM3U\n#EXTINF:4,\nx.ts\n' },
    'https://b.example/x.ts': { body: TS }
  }));
  assert.equal(r.ok, true);
  assert.equal(r.variants, 3);
  assert.equal(r.bandwidth, 2000000);
});

test('probe: playlist 200 com segmento 403 é fonte morta (caso comum de IPTV)', async () => {
  const r = await probeSource('http://c.example/i.m3u8', opts({
    'http://c.example/i.m3u8': { body: '#EXTM3U\n#EXTINF:4,\nseg.ts\n' },
    'http://c.example/seg.ts': { status: 403, body: 'no' }
  }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /segmento HTTP 403/);
});

test('probe: segmento que é HTML, stream criptografado e playlist vazia são recusados', async () => {
  const html = await probeSource('http://d.example/i.m3u8', opts({
    'http://d.example/i.m3u8': { body: '#EXTM3U\n#EXTINF:4,\ns.ts\n' }, 'http://d.example/s.ts': { body: '<html>blocked</html>' }
  }));
  assert.match(html.reason, /não é MPEG-TS/);
  const enc = await probeSource('http://e.example/i.m3u8', opts({
    'http://e.example/i.m3u8': { body: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4,\ns.ts\n' }
  }));
  assert.match(enc.reason, /criptografado/);
  const empty = await probeSource('http://f.example/i.m3u8', opts({ 'http://f.example/i.m3u8': { body: '#EXTM3U\n' } }));
  assert.match(empty.reason, /sem segmentos/);
});

test('probe: segue redirecionamento (Xtream) e usa a URL final nos segmentos', async () => {
  const r = await probeSource('http://g.example/u/p/1.m3u8', opts({
    'http://g.example/u/p/1.m3u8': { redirect: 'http://edge.g.example/hls/z/index.m3u8?tk=1' },
    'http://edge.g.example/hls/z/index.m3u8?tk=1': { body: '#EXTM3U\n#EXTINF:4,\nc1.ts\n' },
    'http://edge.g.example/hls/z/c1.ts': { body: TS }
  }));
  assert.equal(r.ok, true);
});

test('probe: TS cru é reconhecido como "ts" (não toca ainda); outras respostas viram erro', async () => {
  const raw = await probeSource('http://h.example/Espn', opts({ 'http://h.example/Espn': { body: TS, headers: { 'content-type': 'video/mp2t' } } }));
  assert.equal(raw.ok, true);
  assert.equal(raw.kind, 'ts');
  const html = await probeSource('http://i.example/x', opts({ 'http://i.example/x': { body: '<html>Loading...</html>', headers: { 'content-type': 'text/html' } } }));
  assert.equal(html.ok, false);
  assert.match(html.reason, /não é vídeo/);
});

test('probe: página de player em host conhecido vira kind "page"', async () => {
  process.env.LIVE_PAGE_HOSTS = 'player.example';
  const url = 'https://player.example/live/ch.php?canal=X';
  assert.equal(isPagePlayer(url), true);
  assert.equal(isPagePlayer('https://outro.example/ch.php'), false);
  const r = await probeSource(url, opts({ [url]: { body: '<html><body>' + 'x'.repeat(400) + '</body></html>', headers: { 'content-type': 'text/html' } } }));
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'page');
  delete process.env.LIVE_PAGE_HOSTS;
});

test('probe: tempo esgotado e hosts privados', async () => {
  const slow = await probeSource('http://j.example/i.m3u8', opts({ 'http://j.example/i.m3u8': { hang: true } }));
  assert.equal(slow.ok, false);
  assert.equal(slow.reason, 'tempo esgotado');
  const priv = await probeSource('http://127.0.0.1:3000/i.m3u8', { fetchImpl: fakeFetch({}), timeoutMs: 500 });
  assert.equal(priv.ok, false);
  assert.match(priv.reason, /IP privado/);
  assert.equal(isPrivateIp('192.168.0.5'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
});

test('parsePlaylist: variantes só em master, segmentos só em mídia', () => {
  const m = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n', 'http://x/y/m.m3u8');
  assert.equal(m.isMaster, true);
  assert.equal(m.variants[0].url, 'http://x/y/v.m3u8');
  const p = parsePlaylist('#EXTM3U\n#EXTINF:4,\na.ts\n', 'http://x/y/p.m3u8');
  assert.equal(p.isMaster, false);
  assert.deepEqual(p.segments, ['http://x/y/a.ts']);
});

/* ------------------------------ catálogo ------------------------------ */

test('norm: tira qualidade, país e acentos mas não mistura ESPN com ESPN 2', () => {
  assert.equal(live.norm('BR: ESPN HD'), 'espn');
  assert.equal(live.norm('ESPN (1080p)'), 'espn');
  assert.equal(live.norm('ESPN 2 FHD'), 'espn 2');
  assert.equal(live.norm('Combate [Backup]'), 'combate');
  assert.notEqual(live.norm('ESPN 2'), live.norm('ESPN'));
});

test('parseM3u lê nome (tvg-name ou depois da vírgula) e ignora linhas que não são http', () => {
  const list = parseTxt();
  assert.deepEqual(live.parseM3u(list), [
    { name: 'ESPN', url: 'http://h/espn.m3u8' },
    { name: 'SporTV', url: 'https://h/sportv.m3u8' }
  ]);
  function parseTxt() {
    return '#EXTM3U\n#EXTINF:-1 tvg-name="ESPN",Qualquer\n#EXTVLCOPT:x=y\nhttp://h/espn.m3u8\n#EXTINF:-1,SporTV\nhttps://h/sportv.m3u8\n#EXTINF:-1,Ruim\nrtmp://h/x\n';
  }
});

test('xtreamVariant: sem extensão ganha .m3u8; o resto fica como está', () => {
  assert.equal(live.xtreamVariant('http://painel.x:25461/254126/254126/11006'), 'http://painel.x:25461/254126/254126/11006.m3u8');
  assert.equal(live.xtreamVariant('http://tv.x:25461/live/u/p/1.m3u8'), null);
  assert.equal(live.xtreamVariant('http://x/live/stream/chunks.m3u8'), null);
});

test('hlsVariants: Xtream ganha .m3u8 e /mpegts ganha /index.m3u8; o resto não ganha palpite', () => {
  assert.deepEqual(live.hlsVariants('http://p.x:25461/1/2/11006'), ['http://p.x:25461/1/2/11006.m3u8']);
  assert.deepEqual(live.hlsVariants('http://h:7779/ESPN/mpegts'), ['http://h:7779/ESPN/index.m3u8']);
  assert.deepEqual(live.hlsVariants('http://h:14432/Espn'), []);
  assert.deepEqual(live.hlsVariants('http://h/live/a/index.m3u8'), []);
});

test('candidatesFor: env primeiro, Xtream .m3u8 antes do cru, catálogo por último, sem repetição', () => {
  process.env.LIVE_SOURCES_JSON = JSON.stringify({
    sportv: ['https://env.example/s.m3u8', 'http://panel.example:25461/1/2/11006']
  });
  const seed = CHANNELS.find((c) => c.id === 'sportv').sources[0];
  live._catalog.index.set('sportv', ['https://cat.example/s.m3u8', seed]);
  const list = live.candidatesFor('sportv');
  delete process.env.LIVE_SOURCES_JSON;
  assert.equal(list[0].origin, 'env');
  const urls = list.map((c) => c.url);
  const raw = urls.indexOf('http://panel.example:25461/1/2/11006');
  assert.equal(urls[raw - 1], 'http://panel.example:25461/1/2/11006.m3u8');
  assert.equal(list[list.length - 1].url, 'https://cat.example/s.m3u8');
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.includes(seed), 'a semente continua como candidata');
});

test('catálogo: varre listas .m3u e liga cada nome ao canal certo', async () => {
  const m3u = '#EXTM3U\n#EXTINF:-1,BR: ESPN HD\nhttp://a/espn.m3u8\n#EXTINF:-1,ESPN 2\nhttps://b/espn2.m3u8\n#EXTINF:-1,Canal X\nhttp://c/x.m3u8\n';
  const fetchImpl = async () => new Response(m3u, { status: 200 });
  process.env.LIVE_CATALOG_URLS = 'https://lista.example/a.m3u';
  await live.loadCatalogs(fetchImpl);
  delete process.env.LIVE_CATALOG_URLS;
  assert.deepEqual(live._catalog.index.get('espn'), ['http://a/espn.m3u8']);
  assert.deepEqual(live._catalog.index.get('espn2'), ['https://b/espn2.m3u8']);
  assert.equal(live._catalog.index.has('globo'), false);
});

/* ------------------------------- cascata ------------------------------ */

function probeBy(table) {
  return async (url) => {
    const r = table[url] || { ok: false, reason: 'HTTP 404' };
    return { https: url.startsWith('https'), port: '80', cors: false, ms: 1, ...r };
  };
}

test('resolveChannel: usa a primeira fonte que toca e guarda no cache de saúde', async () => {
  process.env.LIVE_SCAN_CATALOGS = '0';
  const urls = live.candidatesFor('cultura').map((c) => c.url);
  const probe = probeBy({ [urls[0]]: { ok: true, kind: 'hls', cors: true } });
  const r = await live.resolveChannel('cultura', { probe });
  assert.equal(r.ok, true);
  assert.equal(r.source.url, urls[0]);
  assert.equal(live.channelsSnapshot().channels.find((c) => c.id === 'cultura').status, 'ok');
  delete process.env.LIVE_SCAN_CATALOGS;
});

test('resolveChannel: pula o que o cliente já tentou e o que falhou', async () => {
  process.env.LIVE_SCAN_CATALOGS = '0';
  const cands = live.candidatesFor('sportv');
  const good = cands[cands.length - 1];
  const probe = probeBy({ [good.url]: { ok: true, kind: 'hls' } });
  const r = await live.resolveChannel('sportv', { probe, skip: [cands[0].sid] });
  assert.equal(r.ok, true);
  assert.equal(r.source.sid, good.sid);
  delete process.env.LIVE_SCAN_CATALOGS;
});

test('resolveChannel: HLS ganha de página de player e TS cru só entra como último recurso', async () => {
  process.env.LIVE_SCAN_CATALOGS = '0';
  process.env.LIVE_PAGE_HOSTS = 'player.example';
  process.env.LIVE_SOURCES_JSON = JSON.stringify({
    sportv3: ['https://player.example/ch.php?canal=A', 'https://hls.example/s3/index.m3u8']
  });
  const page = 'https://player.example/ch.php?canal=A';
  const hls = 'https://hls.example/s3/index.m3u8';
  let r = await live.resolveChannel('sportv3', { probe: probeBy({ [page]: { ok: true, kind: 'page' }, [hls]: { ok: true, kind: 'hls' } }) });
  assert.equal(r.source.url, hls);
  live._reset();
  r = await live.resolveChannel('sportv3', { probe: probeBy({ [hls]: { ok: false, reason: 'x' }, [page]: { ok: true, kind: 'page' } }) });
  assert.equal(r.source.kind, 'page');
  live._reset();
  r = await live.resolveChannel('sportv3', { probe: probeBy({ [hls]: { ok: true, kind: 'ts' }, [page]: { ok: false, reason: 'x' } }) });
  assert.equal(r.ok, true, 'TS cru vivo é o último recurso');
  assert.equal(r.source.kind, 'ts');
  assert.equal(r.rawTs, 1);
  assert.equal(live.channelsSnapshot().channels.find((c) => c.id === 'sportv3').status, 'ok');
  delete process.env.LIVE_SCAN_CATALOGS;
  delete process.env.LIVE_PAGE_HOSTS;
  delete process.env.LIVE_SOURCES_JSON;
});

test('reportBad tira a fonte da rotação por alguns minutos', async () => {
  process.env.LIVE_SCAN_CATALOGS = '0';
  const cands = live.candidatesFor('cultura');
  const probe = probeBy({ [cands[0].url]: { ok: true, kind: 'hls' } });
  await live.resolveChannel('cultura', { probe });
  assert.equal(live.reportBad('cultura', cands[0].sid), true);
  const again = await live.resolveChannel('cultura', { probe });
  assert.equal(again.ok, false);
  assert.equal(live.reportBad('cultura', 'ffffffffff'), false);
  delete process.env.LIVE_SCAN_CATALOGS;
});

/* ----------------------- entrega: nada passa pelo Render ----------------------- */

const okFetch = (map) => async (url) => {
  const key = Object.keys(map).find((k) => url.startsWith(k));
  return new Response(JSON.stringify(map[key] || {}), { status: map[key] ? 200 : 404 });
};

test('planDelivery: HTTPS com CORS toca direto; HTTP vai pela Vercel; porta fora de 80/443 vai pela função Node', async () => {
  const pool = ['https://v1.vercel.app'];
  const fetchImpl = okFetch({ 'https://v1.vercel.app/live/hls': { live: 1 }, 'https://v1.vercel.app/live/np': { live: 1 } });
  const direct = await live.planDelivery({ url: 'https://x.example/a.m3u8', https: true, cors: true, kind: 'hls' }, { pool });
  assert.equal(direct.mode, 'direct');
  assert.equal(direct.url, 'https://x.example/a.m3u8');

  const edge = await live.planDelivery({ url: 'http://x.example/a.m3u8', https: false, cors: true, kind: 'hls' }, { pool, fetchImpl, now: 1000 });
  assert.equal(edge.mode, 'vercel');
  assert.match(edge.url, /^https:\/\/v1\.vercel\.app\/live\/hls\?u=http%3A%2F%2Fx\.example%2Fa\.m3u8&e=\d+&s=[\w-]{22}$/);

  const node = await live.planDelivery({ url: 'http://x.example:8081/a.m3u8', https: false, cors: false, kind: 'hls' }, { pool, fetchImpl, now: 1000 });
  assert.match(node.url, /\/live\/np\?u=/);

  const httpsNoCors = await live.planDelivery({ url: 'https://x.example:1443/a.m3u8', https: true, cors: false, kind: 'hls' }, { pool, fetchImpl });
  assert.match(httpsNoCors.url, /\/live\/np\?u=/);
});

test('planDelivery: sem Vercel pronta devolve "none" com motivo (nunca cai no Render)', async () => {
  const none = await live.planDelivery({ url: 'http://x.example/a.m3u8', https: false, cors: false, kind: 'hls' }, { pool: [] });
  assert.equal(none.mode, 'none');
  assert.match(none.reason, /Vercel/);
  const old = await live.planDelivery({ url: 'http://x.example/a.m3u8', https: false, cors: false, kind: 'hls' }, { pool: ['https://old.vercel.app'], fetchImpl: okFetch({}) });
  assert.equal(old.mode, 'none');
  assert.match(old.reason, /deploy-vercel|Reimplante/);
});

test('planDelivery: página de player vai pelo AdShield com token que o adproxy aceita', async () => {
  const url = 'https://player.example/live/ch.php?canal=COMBATE';
  const plan = await live.planDelivery({ url, kind: 'page' }, { pool: ['https://v1.vercel.app'] });
  assert.equal(plan.mode, 'page');
  const token = plan.url.split('/_adshield/r/')[1];
  const entry = verifyToken(token, loadConfig({}));
  assert.equal(entry.url, url);
  assert.equal(entry.referer, 'https://player.example/');
  assert.equal(verifyToken(token + 'x', loadConfig({})), null);
  const none = await live.planDelivery({ url, kind: 'page' }, { pool: [] });
  assert.equal(none.mode, 'none');
});

test('assinatura do Render é a mesma que o proxy da Vercel confere', async () => {
  const { handleLive } = await import('../adproxy/lib/liveHls.mjs');
  const target = 'http://iptv.example/live/c.m3u8';
  const now = Date.now();
  const path = live.signedPath('/live/hls', target, now);
  const res = await handleLive(new Request(`https://x.vercel.app${path}`), {
    now, fetch: async () => new Response('#EXTM3U\n#EXTINF:4,\ns.ts\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^#EXTM3U/);
  const tampered = path.replace('iptv.example', 'evil.example');
  assert.equal((await handleLive(new Request(`https://x.vercel.app${tampered}`), { now, fetch: async () => new Response('x') })).status, 403);
});

test('catálogo de canais: ids únicos, toda fonte é http(s) e há aliases', () => {
  const ids = CHANNELS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of CHANNELS) {
    assert.ok(c.sources.length > 0, c.id);
    assert.ok(c.aliases.length > 0, c.id);
    for (const u of c.sources) assert.match(u, /^https?:\/\//, `${c.id} ${u}`);
  }
});

/* ------------------------------ área nerd (admin) ------------------------------ */

test('maskUrl: tira usuário/senha de painel, tokens e query', () => {
  assert.equal(live.maskUrl('http://painel.x:25461/meuuser/minhasenha/11006'), 'http://painel.x:25461/…/…/11006');
  assert.equal(live.maskUrl('http://painel.x:25461/live/meuuser/minhasenha/11006.m3u8'), 'http://painel.x:25461/live/…/…/11006.m3u8');
  const m = live.maskUrl('https://h.example/live/AbCdEfGhIjKlMnOpQrStUv/index.m3u8?token=SEGREDO&x=1');
  assert.ok(!/SEGREDO|AbCdEfGhIjKlMnOpQrStUv/.test(m), m);
  assert.equal(live.maskUrl('https://a.b/live/livestream/chunklist.m3u8'), 'https://a.b/live/livestream/chunklist.m3u8');
  assert.equal(live.maskUrl('isso nao e url'), 'isso nao e url');
});

test('diagnostics: mostra teste de cada fonte, mascara URLs por padrão e registra eventos', async () => {
  process.env.LIVE_SCAN_CATALOGS = '0';
  process.env.LIVE_SOURCES_JSON = JSON.stringify({ cultura: ['http://painel.example:25461/usuario1/senha1/777'] });
  const url = 'http://painel.example:25461/usuario1/senha1/777.m3u8';
  const r = await live.resolveChannel('cultura', { probe: probeBy({ [url]: { ok: true, kind: 'hls', cors: true } }) });
  assert.equal(r.ok, true);
  const d = live.diagnostics();
  const ch = d.channels.find((c) => c.id === 'cultura');
  const src = ch.fontes.find((s) => s.teste && s.teste.ok);
  assert.ok(src, 'fonte testada aparece');
  assert.equal(src.teste.tipo, 'hls');
  assert.ok(!JSON.stringify(d).includes('senha1'), 'senha não vaza no modo normal');
  assert.ok(d.eventos.some((e) => e.tipo === 'cascata' && /tocou/.test(e.msg)));
  assert.ok(d.eventos.every((e) => !e.msg.includes('senha1')));
  assert.ok(JSON.stringify(live.diagnostics({ full: true })).includes('senha1'), 'full mostra a URL inteira');
  assert.ok(d.totais.testadas >= 1 && d.config.varrerListas === false);
  delete process.env.LIVE_SCAN_CATALOGS;
  delete process.env.LIVE_SOURCES_JSON;
});

test('canal sem sinal entra no registro de eventos', async () => {
  process.env.LIVE_SCAN_CATALOGS = '0';
  const r = await live.resolveChannel('cultura', { probe: probeBy({}) });
  assert.equal(r.ok, false);
  assert.ok(live.diagnostics().eventos.some((e) => e.tipo === 'cascata' && /sem sinal/.test(e.msg)));
  delete process.env.LIVE_SCAN_CATALOGS;
});

test('planDelivery com verify: pula a Vercel que recusa a fonte (403) e usa a próxima', async () => {
  const src = { url: 'http://cdn.example:8080/live/a.m3u8', kind: 'hls', https: false, cors: false };
  const calls = [];
  const fetchImpl = async (u) => {
    calls.push(u);
    if (u.includes('?cap=1')) return new Response(JSON.stringify({ live: true }), { status: 200 });
    if (u.startsWith('https://ruim.vercel.app/')) return new Response('{"error":"URL não assinada ou vencida"}', { status: 403 });
    return new Response('#EXTM3U\n#EXTINF:4,\ns.ts\n', { status: 200 });
  };
  const plan = await live.planDelivery(src, { pool: ['https://ruim.vercel.app', 'https://boa.vercel.app'], fetchImpl, verify: true });
  assert.equal(plan.mode, 'vercel');
  assert.match(plan.via, /^boa\.vercel\.app/);
  assert.ok(live.diagnostics().eventos.some((e) => e.tipo === 'vercel' && /403/.test(e.msg) && /ruim\.vercel\.app/.test(e.msg)));
  live._reset();
  const only = await live.planDelivery(src, { pool: ['https://ruim.vercel.app'], fetchImpl, verify: true });
  assert.equal(only.mode, 'none');
  assert.match(only.reason, /não conseguiu abrir.*403/);
});

test('warm: rodadas seguintes testam as fontes que ainda não foram testadas, não só as 12 primeiras', async () => {
  process.env.LIVE_SCAN_CATALOGS = '0';
  const seen = new Set();
  const probe = async (url) => { seen.add(url); return { ok: false, reason: 'HTTP 404', https: false, port: '80', cors: false, ms: 1 }; };
  const all = live.candidatesFor('espn').map((c) => c.url);
  assert.ok(all.length > 24, 'o seed do ESPN tem mais de 24 fontes');
  await live.warm({ probe });
  assert.equal(all.slice(0, 12).every((u) => seen.has(u)), true);
  assert.equal(seen.has(all[13]), false);
  await live.warm({ probe });
  assert.equal(all.slice(0, 24).every((u) => seen.has(u)), true);
  delete process.env.LIVE_SCAN_CATALOGS;
});

test('planDelivery com verify: se o Render tem outro segredo, aprende a assinatura embutida da Vercel e não erra de novo', async () => {
  const { BUILTIN_PROXY_SECRET } = require('../adproxy/lib/secret.js');
  process.env.PROXY_SECRET = 'segredo-so-do-render';
  const src = { url: 'http://cdn.example:8000/play/a/index.m3u8', kind: 'hls', https: false, cors: false };
  const hits = [];
  const fetchImpl = async (u) => {
    if (u.includes('?cap=1')) return new Response(JSON.stringify({ live: true }), { status: 200 });
    const q = new URL(u).searchParams;
    hits.push(u);
    const ok = q.get('s') === live.signLive(q.get('u'), q.get('e'), BUILTIN_PROXY_SECRET);
    return ok ? new Response('#EXTM3U\n#EXTINF:4,\ns.ts\n') : new Response('{"error":"URL não assinada ou vencida"}', { status: 403 });
  };
  const plan = await live.planDelivery(src, { pool: ['https://v.vercel.app'], fetchImpl, verify: true });
  assert.equal(plan.mode, 'vercel');
  assert.equal(hits.length, 2, 'primeira tentativa 403, segunda com a assinatura embutida');
  assert.ok(live.diagnostics().eventos.some((e) => e.tipo === 'vercel' && /embutida/.test(e.msg)));
  hits.length = 0;
  const again = await live.planDelivery(src, { pool: ['https://v.vercel.app'], fetchImpl, verify: true });
  assert.equal(again.mode, 'vercel');
  assert.equal(hits.length, 1, 'já sabe qual assinatura usar');
  delete process.env.PROXY_SECRET;
});

test('planDelivery: TS cru vai pela função Node (/live/np) e é conferido lendo o primeiro pacote', async () => {
  const src = { url: 'http://cdn.example:14438/Espn2', kind: 'ts', https: false, cors: false };
  const routes = [];
  const fetchImpl = async (u) => {
    if (u.includes('?cap=1')) return new Response(JSON.stringify({ live: true }), { status: 200 });
    routes.push(new URL(u).pathname);
    return new Response(new ReadableStream({ start(c) { c.enqueue(TS); } }), { status: 200 });
  };
  const plan = await live.planDelivery(src, { pool: ['https://v.vercel.app'], fetchImpl, verify: true });
  assert.equal(plan.mode, 'vercel');
  assert.match(plan.via, /\/live\/np$/);
  assert.deepEqual(routes, ['/live/np']);
  live._reset();
  const bad = await live.planDelivery({ ...src, url: 'http://cdn.example:80/x' }, {
    pool: ['https://v.vercel.app'], verify: true,
    fetchImpl: async (u) => (u.includes('?cap=1') ? new Response(JSON.stringify({ live: true })) : new Response('<html>')) });
  assert.equal(bad.mode, 'none');
  assert.match(bad.reason, /MPEG-TS/);
});

test('resolveChannel: responde assim que a primeira fonte boa aparece, sem esperar as lentas do mesmo lote', async () => {
  process.env.LIVE_SCAN_CATALOGS = '0';
  process.env.LIVE_SOURCES_JSON = JSON.stringify({ cultura: ['http://lenta1.example/a.m3u8', 'http://lenta2.example/b.m3u8', 'http://boa.example/c.m3u8'] });
  const probe = async (url) => {
    if (url.includes('lenta')) { await new Promise((r) => setTimeout(r, 1500)); return { ok: false, reason: 'tempo esgotado', https: false, port: '80', cors: false, ms: 1500 }; }
    return { ok: true, kind: 'hls', https: false, port: '80', cors: false, ms: 5 };
  };
  const t0 = Date.now();
  const r = await live.resolveChannel('cultura', { probe });
  assert.equal(r.ok, true);
  assert.equal(r.source.url, 'http://boa.example/c.m3u8');
  assert.ok(Date.now() - t0 < 700, `demorou ${Date.now() - t0} ms`);
  delete process.env.LIVE_SCAN_CATALOGS;
  delete process.env.LIVE_SOURCES_JSON;
});
