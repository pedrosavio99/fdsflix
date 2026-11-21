'use strict';

const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { test, beforeEach } = require('node:test');
const brain = require('../lib/subtitleBrain');
const plan = require('../lib/captionPlan');
const { parseCues } = require('../lib/subtitles');

/* ---------- material sintético (nada de legenda real no repositório) ---------- */

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Linha do tempo "do filme": início/fim de cada fala, ~1400 falas em ~2h10.
function timeline(seed, n, span) {
  const r = rng(seed);
  const out = [];
  let t = 20;
  for (let i = 0; i < n && t < span; i += 1) {
    const dur = 1.2 + r() * 2.8;
    out.push({ s: t, e: t + dur });
    t += dur + 0.8 + r() * 7.5;
  }
  return out;
}

const TEXT = {
  br: ['Você não sabe o que está dizendo, cara.', 'Pra onde a gente vai agora?', 'Eu não tenho tempo pra isso, você entendeu?',
    'Ela está esperando a gente lá na tela do celular.', 'Estou fazendo o que você pediu, ainda não terminei.', 'Valeu, foi muito legal ver vocês aqui.',
    'Então me diz o que você quer que eu faça.', 'Nós já vimos isso antes, e não deu certo.', 'Tudo bem, vou pegar o ônibus mais tarde.'],
  pt: ['Tu não sabes o que estás a dizer, pá.', 'Para onde é que vamos agora, miúdo?', 'Eu não tenho tempo para isso, tu percebeste?',
    'Ela está à espera no ecrã do telemóvel.', 'Estou a fazer o que pediste, ainda não acabei.', 'Fixe, foi muito giro ver-vos aqui.',
    'Então diz-me o que queres que eu faça.', 'Nós já vimos isto antes, e não correu bem.', 'Está bem, vou apanhar o autocarro mais tarde.'],
  es: ['Usted no sabe lo que está diciendo, señor.', 'Pero para dónde vamos ahora, yo no entiendo.', 'No tengo tiempo para esto, ¿usted entendió?',
    'Ella está esperando en la pantalla del móvil.', 'Estoy haciendo lo que usted pidió, muy bien.', 'Gracias, fue muy bueno verlos a todos aquí.'],
  en: ['You do not know what you are saying, man.', 'Where are we going now, and what is this?', 'I have no time for this, you understand that?',
    'She is waiting for us there with the phone.', 'I am doing what you asked, but I have not finished.', 'Thanks, it was really good to see you all.',
    'Then tell me what you want me to do about it.', 'We have seen this before, and it did not work.']
};

function vttOf(cues, lang) {
  const lines = TEXT[lang];
  const f = (x) => {
    const ms = Math.round(x * 1000);
    const p = (n, w) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor((ms % 3600000) / 60000), 2)}:${p(Math.floor((ms % 60000) / 1000), 2)}.${p(ms % 1000, 3)}`;
  };
  return 'WEBVTT\n\n' + cues.map((c, i) => `${f(c.s)} --> ${f(c.e)}\n${lines[i % lines.length]}`).join('\n\n') + '\n';
}

const jitter = (cues, seed, amp) => { const r = rng(seed); return cues.map((c) => ({ s: c.s + (r() - 0.5) * 2 * amp, e: c.e + (r() - 0.5) * 2 * amp })); };
const shifted = (cues, d, ratio = 1) => cues.map((c) => ({ s: c.s * ratio + d, e: c.e * ratio + d }));

const RUNTIME = 8000;
const FILM = timeline(7, 1500, 7800);
const OTHER = timeline(99, 1500, 7800);
const FILM_ENDS = FILM[FILM.length - 1].e;

function stats(vtt) { return brain.analyze(vtt, RUNTIME); }
function cand(id, vtt, extra) {
  const c = { id, source: 'os-legacy', region: 'br', meta: { downloads: 1000, rating: 8, trusted: false, hi: false, cds: 1 }, vtt, info: {}, stats: stats(vtt), ...extra };
  return c;
}

beforeEach(() => brain._reset());

/* ---------- idioma ---------- */

test('parseLabel entende pt-BR em todas as formas (era o bug: virava "und")', () => {
  for (const l of ['pt-BR', 'pt-br', 'pt_BR', 'pob', 'Portuguese - Brazilian', 'Brazilian Portuguese', 'Português (Brasil)', 'Português (OpenSubtitles)']) {
    assert.equal(brain.parseLabel(l, '').lang, 'pt', l);
  }
  assert.equal(brain.parseLabel('pt-BR', '').region, 'br');
  assert.equal(brain.parseLabel('Portuguese - Brazilian', '').region, 'br');
  assert.equal(brain.parseLabel('pt-PT', '').region, 'pt');
  assert.equal(brain.parseLabel('European Portuguese', '').region, 'pt');
  assert.equal(brain.parseLabel('Portuguese', '').region, '');
  assert.equal(brain.parseLabel('English', '').lang, 'en');
  assert.equal(brain.parseLabel('Spanish', '').lang, 'es');
  assert.equal(brain.parseLabel('', 'eng').lang, 'en');
  assert.notEqual(brain.parseLabel('Arabic', '').lang, 'pt');
});

test('normalizeLang do servidor reconhece pt-BR (rótulos do provedor e do OpenSubtitles)', () => {
  for (const l of ['pt-BR', 'Portuguese - Brazilian', 'Brazilian Portuguese', 'Portuguese', 'pt']) assert.equal(plan.normalizeLang(l), 'pt', l);
  assert.equal(plan.normalizeLang('English'), 'en');
  assert.equal(plan.normalizeLang('xx-yy-zz'), 'und');
});

test('detectText separa pt-BR, pt-PT, espanhol e inglês pelo TEXTO (não pelo rótulo)', () => {
  const lang = (l) => brain.detectText(parseCues(vttOf(FILM.slice(0, 400), l)));
  assert.deepEqual([lang('br').lang, lang('br').variant], ['pt', 'br']);
  assert.deepEqual([lang('pt').lang, lang('pt').variant], ['pt', 'pt']);
  assert.equal(lang('es').lang, 'es');
  assert.equal(lang('en').lang, 'en');
  assert.equal(brain.detectText(parseCues('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOi\n')).lang, 'other');
});

/* ---------- alinhamento de tempos ---------- */

test('alignOnsets: mesma linha do tempo, atraso de 2 s e outro fps (25 / 23,976)', () => {
  const a = Float64Array.from(FILM.map((c) => c.s));
  const same = brain.alignOnsets(a, Float64Array.from(jitter(FILM, 3, 0.25).map((c) => c.s).sort((x, y) => x - y)));
  assert.ok(same.ok && same.ratio === 1 && Math.abs(same.offset) < 0.2 && same.frac > 0.8, JSON.stringify(same));

  const late = brain.alignOnsets(a, Float64Array.from(shifted(jitter(FILM, 4, 0.25), 2.0).map((c) => c.s).sort((x, y) => x - y)));
  assert.ok(late.ok && Math.abs(late.offset - 2) < 0.25, JSON.stringify(late));

  const fps = brain.alignOnsets(a, Float64Array.from(shifted(jitter(FILM, 5, 0.2), 0, 25 / 23.976).map((c) => c.s)));
  assert.ok(fps.ok && Math.abs(fps.ratio - 25 / 23.976) < 1e-9 && Math.abs(fps.offset) < 0.5, JSON.stringify(fps));
});

test('alignOnsets: falas de OUTRO filme não alinham (nada de falso positivo)', () => {
  const al = brain.alignOnsets(Float64Array.from(FILM.map((c) => c.s)), Float64Array.from(OTHER.map((c) => c.s)));
  assert.equal(al.ok, false, JSON.stringify(al));
});

/* ---------- escolha ---------- */

test('rank: pt-BR inteira ganha de Portugal, espanhol, incompleta, quebrada e inglês', () => {
  const good = cand('good', vttOf(jitter(FILM, 11, 0.1), 'br'));
  const peer = cand('peer', vttOf(jitter(FILM, 12, 0.1), 'br'), { meta: { downloads: 50, rating: 0, trusted: false, hi: false, cds: 1 } });
  const ptpt = cand('ptpt', vttOf(FILM, 'pt'));
  const es = cand('es', vttOf(FILM, 'es'));
  const en = cand('en', vttOf(FILM, 'en'));
  const half = cand('half', vttOf(FILM.slice(0, 500), 'br'));
  const garbled = cand('garbled', vttOf(FILM, 'br').replace(/ã/g, 'Ã£').replace(/ç/g, 'Ã§').replace(/é/g, '\uFFFD'));
  const r = brain.rank([ptpt, es, half, garbled, en, peer, good], { runtimeSec: RUNTIME });
  assert.deepEqual(r.ptbr.map((c) => c.id), ['good', 'peer']);
  assert.deepEqual(r.ptpt.map((c) => c.id), ['ptpt']);
  const why = Object.fromEntries(r.rejected.map((x) => [x.id, x.reason]));
  assert.match(why.es, /espanhol/);
  assert.match(why.en, /inglês/);
  assert.match(why.half, /incompleta/);
  assert.match(why.garbled, /quebrados/);
  assert.match(why.ptpt, /Portugal/);
});

test('rank: quem concorda com as outras (mesma linha do tempo) passa a que destoa', () => {
  const a = cand('a', vttOf(jitter(FILM, 21, 0.1), 'br'), { meta: { downloads: 100, rating: 5, cds: 1 } });
  const b = cand('b', vttOf(jitter(FILM, 22, 0.1), 'br'), { meta: { downloads: 100, rating: 5, cds: 1 } });
  const lone = cand('lone', vttOf(shifted(jitter(FILM, 23, 0.1), 4.5), 'br'), { meta: { downloads: 100, rating: 5, cds: 1 } });
  const r = brain.rank([lone, a, b], { runtimeSec: RUNTIME });
  assert.ok(['a', 'b'].includes(r.ptbr[0].id), r.ptbr.map((c) => `${c.id}:${c.score}`).join(' '));
  assert.equal(r.ptbr[2].id, 'lone');
});

test('rank: com referência do PRÓPRIO vídeo corrige atraso e fps; sem confiança, não mexe', () => {
  const ref = stats(vttOf(jitter(FILM, 31, 0.2), 'en'));
  const late = cand('late', vttOf(shifted(jitter(FILM, 32, 0.15), -3.2), 'br'));
  const trusted = brain.rank([late], { runtimeSec: RUNTIME, reference: ref, referenceTrusted: true });
  assert.ok(Math.abs(trusted.ptbr[0].sync.shift - 3.2) < 0.3 && trusted.ptbr[0].sync.scale === 1, JSON.stringify(trusted.ptbr[0].sync));

  const fps = cand('fps', vttOf(shifted(jitter(FILM, 33, 0.15), 0, 23.976 / 25), 'br'));
  const rf = brain.rank([fps], { runtimeSec: RUNTIME, reference: ref, referenceTrusted: true });
  assert.ok(Math.abs(rf.ptbr[0].sync.scale - 25 / 23.976) < 1e-9, JSON.stringify(rf.ptbr[0].sync));

  const untrusted = brain.rank([cand('late2', vttOf(shifted(jitter(FILM, 34, 0.15), -3.2), 'br'))], { runtimeSec: RUNTIME, reference: ref, referenceTrusted: false });
  assert.deepEqual(untrusted.ptbr[0].sync, { shift: 0, scale: 1, basis: '' });
});

test('rank: referência de OUTRO corte derruba a candidata que não casa', () => {
  const ref = stats(vttOf(OTHER, 'en'));
  const c = cand('c', vttOf(FILM, 'br'));
  const r = brain.rank([c], { runtimeSec: RUNTIME, reference: ref });
  assert.ok(r.ptbr[0].why.some((w) => /não casa com a referência/.test(w)));
});

/* ---------- prepare (rede simulada) ---------- */

function mockNet(t, { legacy = [], stremio = [], files = {}, calls = [] } = {}) {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => body });
  brain._deps.imdbIdOf = async () => 'tt0000001';
  brain._deps.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://rest.opensubtitles.org/search/')) return ok(legacy);
    if (/strem/.test(String(url)) && String(url).endsWith('.json')) return ok({ subtitles: stremio });
    if (files[url] !== undefined) return ok(files[url]);
    return { ok: false, status: 404 };
  };
  t.after(() => { brain._deps.fetch = (...a) => fetch(...a); brain._deps.store = null; brain._deps.imdbIdOf = (...a) => require('../lib/streamExtractor').imdbIdOf(...a); });
  return calls;
}

const legacyRow = (n, extra = {}) => ({ IDSubtitleFile: String(n), SubDownloadLink: `https://dl.test/${n}.gz`, SubFormat: 'srt', SubLastTS: '02:09:00', SubDownloadsCnt: String(1000 * n), SubRating: '8', SubFromTrusted: '0', SubSumCD: '1', MovieReleaseName: `rel${n}`, MovieFPS: '23.976', ...extra });
const srtBuf = (vtt) => Buffer.from(vtt.replace(/^WEBVTT\n\n/, '').replace(/(\d\d:\d\d:\d\d)\.(\d{3})/g, '$1,$2'), 'utf8');
const gz = (vtt) => zlib.gzipSync(srtBuf(vtt));

test('prepare: baixa só as melhores, descarta idioma errado e NÃO usa a API com cota quando há o suficiente', async (t) => {
  const calls = [];
  const files = {
    'https://dl.test/1.gz': gz(vttOf(jitter(FILM, 41, 0.1), 'br')),
    'https://dl.test/2.gz': gz(vttOf(jitter(FILM, 42, 0.1), 'br')),
    'https://dl.test/3.gz': gz(vttOf(jitter(FILM, 43, 0.1), 'br')),
    'https://dl.test/4.gz': gz(vttOf(FILM, 'es'))   // rotulado pob, mas é espanhol
  };
  mockNet(t, { legacy: [1, 2, 3, 4].map((n) => legacyRow(n)), files, calls });
  let apiCalls = 0;
  brain._deps.osApi = () => ({ searchRaw: async () => { apiCalls += 1; return []; }, download: async () => { apiCalls += 1; return ''; }, quota: {} });
  const prep = await brain.prepare({ id: '1', type: 'movie', runtimeSec: RUNTIME });
  assert.equal(apiCalls, 0, 'a API com cota não pode ser usada quando o catálogo grátis já deu 3 boas');
  const r = await brain.choose(prep, { runtimeSec: RUNTIME, extras: [] });
  assert.equal(r.ptbr.length, 3);
  assert.ok(r.ptbr.every((c) => c.stats.lang === 'pt'), 'o arquivo em espanhol (rotulado pob) ficou de fora');
  assert.ok(prep.notes.some((n) => /4 baixada\(s\), 3 útil/.test(n)), prep.notes.join(' | '));
  assert.equal(calls.filter((u) => u.endsWith('.gz')).length, 4, 'baixou no máximo as 4 melhores');
});

test('prepare: pré-filtra pelos metadados (CD 2, tradução automática e última fala curta nem são baixados)', async (t) => {
  const calls = [];
  const files = { 'https://dl.test/1.gz': gz(vttOf(FILM, 'br')) };
  mockNet(t, {
    legacy: [legacyRow(1), legacyRow(2, { SubSumCD: '2' }), legacyRow(3, { SubAutoTranslation: '1' }), legacyRow(4, { SubLastTS: '00:50:00', SubDownloadsCnt: '999999' })],
    files, calls
  });
  const prep = await brain.prepare({ id: '2', type: 'movie', runtimeSec: RUNTIME });
  const downloaded = calls.filter((u) => u.endsWith('.gz'));
  assert.ok(downloaded.includes('https://dl.test/1.gz'));
  assert.ok(!downloaded.includes('https://dl.test/2.gz') && !downloaded.includes('https://dl.test/3.gz'), downloaded.join());
  assert.equal(prep.cands.length >= 1, true);
});

test('prepare: cai para o Stremio quando o legado falha e só então para a API com cota', async (t) => {
  const calls = [];
  const files = {
    'https://subs.strem.test/a': srtBuf(vttOf(jitter(FILM, 51, 0.1), 'br')),
    'https://subs.strem.test/b': srtBuf(vttOf(jitter(FILM, 52, 0.1), 'br'))
  };
  mockNet(t, {
    legacy: [],
    stremio: [{ id: 'a', url: 'https://subs.strem.test/a', lang: 'pob', movieReleaseName: 'x', fpsMilli: 23976 }, { id: 'b', url: 'https://subs.strem.test/b', lang: 'pob' },
      { id: 'c', url: 'https://subs.strem.test/c', lang: 'ger' }], files, calls
  });
  let apiCalls = 0;
  brain._deps.osApi = () => ({ searchRaw: async () => { apiCalls += 1; return []; }, download: async () => '', quota: {} });
  const prep = await brain.prepare({ id: '3', type: 'movie', runtimeSec: RUNTIME });
  const r = await brain.choose(prep, { runtimeSec: RUNTIME, extras: [] });
  assert.equal(r.ptbr.length, 2);
  assert.ok(!calls.includes('https://subs.strem.test/c'), 'só pob/por');
  assert.equal(apiCalls, 0, 'com 2 boas do Stremio a API com cota fica quieta');
});

test('prepare: com menos de 2 boas, consulta a API com cota (e respeita a cota restante)', async (t) => {
  const files = { 'https://subs.strem.test/a': srtBuf(vttOf(jitter(FILM, 81, 0.1), 'br')) };
  mockNet(t, { stremio: [{ id: 'a', url: 'https://subs.strem.test/a', lang: 'pob' }], files });
  const downloads = [];
  const row = (id) => ({ attributes: { language: 'pt-BR', download_count: 500, ratings: 7, files: [{ file_id: id }], release: 'r' + id } });
  brain._deps.osApi = () => ({
    searchRaw: async () => [row(11), row(12)],
    download: async (id) => { downloads.push(id); return `https://api.test/dl/${id}`; },
    quota: { remaining: 40 }
  });
  files['https://api.test/dl/11'] = srtBuf(vttOf(jitter(FILM, 82, 0.1), 'br'));
  files['https://api.test/dl/12'] = srtBuf(vttOf(jitter(FILM, 83, 0.1), 'br'));
  const prep = await brain.prepare({ id: '6', type: 'movie', runtimeSec: RUNTIME });
  assert.deepEqual(downloads.sort(), [11, 12]);
  assert.equal((await brain.choose(prep, { runtimeSec: RUNTIME, extras: [] })).ptbr.length, 3);

  // cota quase no fim: nem tenta baixar
  brain._reset();
  downloads.length = 0;
  brain._deps.osApi = () => ({ searchRaw: async () => [row(11), row(12)], download: async (id) => { downloads.push(id); return `https://api.test/dl/${id}`; }, quota: { remaining: 5 } });
  await brain.prepare({ id: '7', type: 'movie', runtimeSec: RUNTIME });
  assert.equal(downloads.length, 0, 'cota restante (5) abaixo da reserva: nenhum download com cota');
});

test('prepare: biblioteca — o 2º pedido (processo novo) não usa rede nem cota', async (t) => {
  const db = new Map();
  const files = {
    'https://dl.test/1.gz': gz(vttOf(jitter(FILM, 61, 0.1), 'br')),
    'https://dl.test/2.gz': gz(vttOf(jitter(FILM, 62, 0.1), 'br'))
  };
  const calls = mockNet(t, { legacy: [legacyRow(1), legacyRow(2)], files });
  brain._deps.store = { get: async (k) => db.get(k) || null, put: async (k, v) => { db.set(k, JSON.parse(JSON.stringify(v))); } };
  await brain.prepare({ id: '4', type: 'movie', runtimeSec: RUNTIME });
  await new Promise((r) => setImmediate(r));
  assert.equal(db.size, 1);
  assert.ok([...db.keys()][0].startsWith('sublib:v1:movie:4:'));

  brain._reset();                 // "reiniciou o Render"
  calls.length = 0;
  const prep = await brain.prepare({ id: '4', type: 'movie', runtimeSec: RUNTIME });
  assert.equal(calls.length, 0, 'nada de rede: veio da biblioteca');
  assert.equal(prep.fromLibrary, true);
  const r = await brain.choose(prep, { runtimeSec: RUNTIME, extras: [] });
  assert.equal(r.ptbr.length, 2);
});

test('choose: legenda pt do próprio provedor entra na disputa e a referência inglesa vem do próprio vídeo', async (t) => {
  const files = {
    'https://dl.test/1.gz': gz(vttOf(shifted(jitter(FILM, 71, 0.1), 2.4), 'br')),
    'https://prov.test/pt.vtt': Buffer.from(vttOf(shifted(jitter(FILM, 72, 0.1), 2.4), 'br'), 'utf8'),
    'https://prov.test/en.vtt': Buffer.from(vttOf(jitter(FILM, 73, 0.2), 'en'), 'utf8')
  };
  mockNet(t, { legacy: [legacyRow(1)], files });
  const prep = await brain.prepare({ id: '5', type: 'movie', runtimeSec: RUNTIME });
  const extras = [{ url: 'https://prov.test/pt.vtt', language: 'Portuguese - Brazilian' }, { url: 'https://prov.test/en.vtt', language: 'English' }];
  const r = await brain.choose(prep, { runtimeSec: RUNTIME, extras, trusted: (u) => u.startsWith('https://prov.test/') });
  assert.equal(r.hasReference, true);
  assert.equal(r.ptbr.length, 2);
  for (const c of r.ptbr) assert.ok(Math.abs(c.sync.shift + 2.4) < 0.35, `${c.id} ${JSON.stringify(c.sync)}`);

  const r2 = await brain.choose(prep, { runtimeSec: RUNTIME, extras, trusted: () => false });
  for (const c of r2.ptbr) assert.equal(c.sync.shift, 0, 'referência de companhia só ordena, não corrige');
});

/* ---------- lista final para o player ---------- */

test('buildCaptions: pt-BR conferida é a 1ª e o padrão; inglês só por escolha; tradução fica de reserva', () => {
  const raw = [{ url: 'https://x/en.vtt', language: 'English' }, { url: 'https://x/es.vtt', language: 'Spanish' }];
  const planObj = {
    ptbr: [{ vtt: 'WEBVTT\n', info: {}, sync: { shift: 0, scale: 1 } }, { vtt: 'WEBVTT\n', info: {}, sync: { shift: 0, scale: 1 } }],
    ptpt: [{ vtt: 'WEBVTT\n', info: {} }]
  };
  const out = plan.buildCaptions(raw, 0, planObj);
  assert.deepEqual(out.map((c) => c.label), [
    'Português (Brasil)', 'Português (Brasil) · opção 2', plan.TRANSLATE_LABEL, 'Português (Portugal)', 'English', 'Spanish'
  ]);
  assert.deepEqual(out.filter((c) => c.default).map((c) => c.label), ['Português (Brasil)']);
  assert.equal(out[3].srclang, 'pt-PT');
  assert.equal(out.find((c) => c.label === 'English').default, false);
});

test('buildCaptions: sem pt-BR conferida a tradução vira a 1ª (como sempre); pt cru do provedor sai quando há cérebro', () => {
  const raw = [{ url: 'https://x/en.vtt', language: 'English' }, { url: 'https://x/pt.vtt', language: 'Portuguese - Brazilian' }];
  const none = plan.buildCaptions(raw, 0, { ptbr: [], ptpt: [] });
  assert.equal(none[0].label, plan.TRANSLATE_LABEL);
  assert.ok(none[0].default);
  assert.ok(!none.some((c) => c.label === 'Portuguese - Brazilian'), 'o pt do provedor foi julgado pelo cérebro (e barrado)');

  const legacy = plan.buildCaptions(raw, 0, null);   // sem cérebro: comportamento antigo, mas agora o pt-BR vale como pt
  assert.equal(legacy.find((c) => c.default).srclang, 'pt');
  assert.notEqual(legacy.find((c) => c.default).label, plan.TRANSLATE_LABEL);
});
