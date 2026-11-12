'use strict';

/**
 * fdsFlix - Programação (EPG) da TV ao vivo.
 *
 * Fonte gratuita, sem chave: guias XMLTV de TV brasileira mantidos pela comunidade no GitHub
 * (limaalef/BrazilTVEPG: "claro.xml" tem ~160 canais, "epg.xml" cobre Globo/SporTV/Premiere/Telecine e abertas).
 * O servidor baixa o guia uns poucos MB a cada 6 h (entrada de dados, não conta nos 5 GB de saída do Render), guarda só
 * os canais do fdsFlix para as próximas ~48 h e responde ao navegador com alguns KB de JSON.
 * É "melhor esforço": se o guia sumir ou ficar velho, a TV continua funcionando, só sem os títulos.
 */

const FEEDS = [
  'https://raw.githubusercontent.com/limaalef/BrazilTVEPG/main/claro.xml',
  'https://raw.githubusercontent.com/limaalef/BrazilTVEPG/main/epg.xml'
];
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const KEEP_PAST_MS = 2 * 60 * 60 * 1000;
const KEEP_AHEAD_MS = 48 * 60 * 60 * 1000;
const MAX_BYTES = 40 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 90 * 1000;

/** Nome do canal do fdsFlix -> nomes possíveis dentro dos guias (já normalizados; vale o primeiro que existir). */
const NAMES = {
  sportv: ['sportv'],
  sportv2: ['sportv 2', 'sportv2'],
  sportv3: ['sportv 3', 'sportv3'],
  espn: ['espn'],
  espn2: ['espn 2'],
  espn3: ['espn 3'],
  espn4: ['espn 4'],
  premiere: ['premiere clubes hd', 'premiere clubes', 'premiere'],
  combate: ['combate hd', 'combate'],
  bandsports: ['band sports hd', 'band sports'],
  telecine: ['telecine premium', 'telecine action', 'telecine pipoca'],
  axn: ['axn'],
  studiouniversal: ['studio universal hd', 'studio universal'],
  space: ['space hd', 'space'],
  discoverykids: ['discovery kids hd', 'discovery kids'],
  cartoon: ['cartoon hd', 'cartoon network'],
  discovery: ['discovery hd', 'discovery channel'],
  globo: ['globo sp', 'globo sp local', 'tv globo'],
  sbt: ['sbt sao paulo', 'sbt'],
  record: ['record sao paulo', 'record sp local'],
  band: ['band hd', 'band sp local'],
  redetv: ['rede tv sao paulo', 'rede tv sp local'],
  cultura: ['cultura hd', 'tv cultura sp local'],
  tnt: ['tnt hd'],
  history: ['history'],
  tlc: ['tlc hd'],
  universal: ['universal tv hd', 'universal'],
  warner: ['warner channel'],
  tcm: ['tcm br', 'tcm'],
  woohoo: ['woohoo hd'],
  camara: ['tv camara']
};

const state = {
  byChannel: new Map(), // id do fdsFlix -> [{ t, s, d, st, en, a }] ordenado por início
  updatedAt: 0,
  tried: 0,
  loading: null,
  source: '',
  error: ''
};

function norm(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&amp;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function decode(text) {
  return String(text || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .trim();
}

/** "20261110234000 -0300" -> epoch ms */
function xmltvTime(stamp, offset) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return NaN;
  const sign = offset && offset[0] === '-' ? -1 : 1;
  const off = offset ? sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5))) : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - off * 60000;
}

function ageOf(inner) {
  const m = /<rating[^>]*>\s*<value>([^<]*)<\/value>/.exec(inner);
  if (!m) return '';
  const v = decode(m[1]).replace(/[[\]]/g, '').trim().toUpperCase();
  if (/^L/.test(v) || v === 'LIVRE') return 'L';
  const n = v.match(/\d+/);
  return n ? n[0] : '';
}

/**
 * Lê um XMLTV e devolve { channels: Map<nomeNormalizado, idDoGuia>, items: Map<idDoGuia, programa[]> } só para os nomes pedidos.
 * Regex linear em vez de um parser de XML: o arquivo chega a 14 MB e roda num servidor de 512 MB.
 */
function parseXmltv(xml, wanted, now = Date.now()) {
  const guideIds = new Map(); // nome normalizado -> ids do guia
  const channelRe = /<channel id="([^"]*)">([\s\S]*?)<\/channel>/g;
  let m;
  while ((m = channelRe.exec(xml))) {
    const id = decode(m[1]);
    for (const names of [norm(id), ...[...m[2].matchAll(/<display-name[^>]*>([^<]*)<\/display-name>/g)].map((x) => norm(decode(x[1])))]) {
      if (!names) continue;
      if (!guideIds.has(names)) guideIds.set(names, id);
    }
  }
  const wantIds = new Set();
  for (const names of wanted) for (const n of names) if (guideIds.has(n)) wantIds.add(guideIds.get(n));
  const items = new Map();
  const progRe = /<programme start="(\d{14})(?: ([+-]\d{4}))?" stop="(\d{14})(?: ([+-]\d{4}))?" channel="([^"]*)">([\s\S]*?)<\/programme>/g;
  while ((m = progRe.exec(xml))) {
    const channel = decode(m[5]);
    if (!wantIds.has(channel)) continue;
    const st = xmltvTime(m[1], m[2]);
    const en = xmltvTime(m[3], m[4] || m[2]);
    if (!(st < en) || en < now - KEEP_PAST_MS || st > now + KEEP_AHEAD_MS) continue;
    const inner = m[6];
    const pick = (tag) => { const x = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(inner); return x ? decode(x[1]) : ''; };
    const title = pick('title');
    if (!title) continue;
    const list = items.get(channel) || [];
    list.push({ t: title.slice(0, 120), s: pick('sub-title').slice(0, 120), d: pick('desc').slice(0, 420), st, en, a: ageOf(inner) });
    items.set(channel, list);
  }
  for (const list of items.values()) list.sort((a, b) => a.st - b.st);
  return { guideIds, items };
}

function ingest(xml, source, now = Date.now()) {
  const ids = Object.keys(NAMES);
  const parsed = parseXmltv(xml, ids.map((id) => NAMES[id]), now);
  let filled = 0;
  for (const id of ids) {
    for (const name of NAMES[id]) {
      const guideId = parsed.guideIds.get(name);
      const list = guideId && parsed.items.get(guideId);
      if (!list || !list.length) continue;
      // O primeiro guia que cobre o agora vale; os seguintes só completam o que faltou.
      const current = state.byChannel.get(id);
      if (current && current.some((p) => p.st <= now && p.en > now)) break;
      state.byChannel.set(id, list);
      filled += 1;
      break;
    }
  }
  return filled;
}

async function fetchText(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'user-agent': 'fdsflix-epg' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('guia grande demais');
  return buf.toString('utf8');
}

/** Baixa os guias (um por vez, para não segurar dois arquivos de 14 MB na memória). Uma única rodada por vez. */
function refresh(fetchImpl = fetch, now = Date.now()) {
  if (state.loading) return state.loading;
  state.tried = now;
  state.loading = (async () => {
    const before = state.byChannel;
    state.byChannel = new Map();
    const used = [];
    let lastError = '';
    for (const url of FEEDS) {
      try {
        const xml = await fetchText(url, fetchImpl);
        const filled = ingest(xml, url, now);
        if (filled) used.push(url.split('/').pop());
      } catch (error) { lastError = `${url.split('/').pop()}: ${error.message}`; }
    }
    if (!state.byChannel.size) {
      state.byChannel = before; // falhou: mantém o que já tinha
      state.error = lastError || 'guia vazio';
    } else {
      state.updatedAt = Date.now();
      state.source = used.join(' + ');
      state.error = lastError;
    }
  })().catch((error) => { state.error = error.message; }).finally(() => { state.loading = null; });
  return state.loading;
}

/** Garante dados razoavelmente novos sem segurar quem pediu: dispara a atualização em segundo plano. */
function ensure(fetchImpl = fetch, now = Date.now()) {
  const stale = !state.updatedAt || now - state.updatedAt > REFRESH_MS;
  const canTry = !state.tried || now - state.tried > (state.updatedAt ? REFRESH_MS / 4 : RETRY_MS) || (!state.updatedAt && now - state.tried > 60 * 1000 && !state.error);
  if (stale && canTry && !state.loading) refresh(fetchImpl, now);
}

function slice(p) {
  return { t: p.t, s: p.s, d: p.d, st: p.st, en: p.en, a: p.a };
}

/** Agora e próximo de cada canal (sem sinopse longa: o navegador só mostra o resumo). */
function nowNext(now = Date.now()) {
  const out = {};
  for (const [id, list] of state.byChannel) {
    const i = list.findIndex((p) => p.st <= now && p.en > now);
    const cur = i >= 0 ? list[i] : null;
    const next = list.find((p) => p.st > now);
    if (!cur && !next) continue;
    out[id] = {
      now: cur ? { t: cur.t, s: cur.s, d: cur.d.slice(0, 220), st: cur.st, en: cur.en, a: cur.a } : null,
      next: next ? { t: next.t, st: next.st, en: next.en } : null
    };
  }
  return out;
}

/** Grade do canal: o que está no ar e as próximas ~24 h. */
function schedule(chId, now = Date.now()) {
  const list = state.byChannel.get(chId) || [];
  return list.filter((p) => p.en > now && p.st < now + 24 * 60 * 60 * 1000).slice(0, 60).map(slice);
}

function status(now = Date.now()) {
  return {
    updatedAt: state.updatedAt,
    loading: Boolean(state.loading),
    source: state.source,
    error: state.error,
    channelCount: state.byChannel.size,
    freshMinutes: state.updatedAt ? Math.round((now - state.updatedAt) / 60000) : null
  };
}

function _reset() {
  state.byChannel = new Map(); state.updatedAt = 0; state.tried = 0; state.loading = null; state.source = ''; state.error = '';
}

module.exports = { NAMES, FEEDS, norm, decode, xmltvTime, parseXmltv, ingest, refresh, ensure, nowNext, schedule, status, _reset };
