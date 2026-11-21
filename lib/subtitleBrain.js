'use strict';

/**
 * "Cérebro" das legendas: escolhe a MELHOR legenda em português do Brasil e a deixa sincronizada.
 *
 * Por que existe (medido em 2026-11-20):
 *  - o rótulo "pt-BR"/"Portuguese - Brazilian" virava `und` no servidor, então o pt-BR do OpenSubtitles nunca
 *    contava como português e perdia o lugar de padrão para a TRADUÇÃO AUTOMÁTICA do inglês;
 *  - a legenda "de companhia" só entrava quando o vídeo não trazia nenhuma, e o OpenSubtitles era consultado
 *    pela API nova, que tem COTA de 100 downloads/dia para o site inteiro (baixava 3 por título);
 *  - nada comparava as candidatas: valia a 1ª da fila, mesmo em espanhol/Portugal/incompleta/de outro corte.
 *
 * O que faz:
 *  1. Junta candidatas pt-BR de várias fontes (todas só de metadados primeiro, baixa poucas):
 *     OpenSubtitles legado (sem chave; traz fps, downloads, nota, "confiável" e a ÚLTIMA fala, que já mostra se o
 *     arquivo está inteiro), addon do Stremio (sem cota, UTF-8) e, só se faltar, a API nova (cota).
 *  2. Confere cada uma pelo TEXTO: é português mesmo? do Brasil ou de Portugal? está inteira? veio quebrada?
 *  3. COMPARA as tempos: alinha os horários das falas entre as candidatas e com uma legenda de referência
 *     (inglês do mesmo vídeo). Quem concorda com as outras e com a referência sobe; quem é de outro corte desce.
 *  4. Se a referência é do MESMO vídeo (a fonte trouxe a própria legenda), corrige atraso e fps antes de entregar.
 *  5. Guarda o resultado (Supabase, `pix_settings`, chave `sublib:v1:…`): título repetido não gasta cota nem rede.
 *
 * O áudio do filme (public/autosync.js, no navegador) continua sendo a prova final de sincronia.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { srtToVtt, decodeSubtitle, stripSpamCues, analyzeVtt, parseCues } = require('./subtitles');

const OS_LEGACY_UA = process.env.OS_LEGACY_UA || 'TemporaryUserAgent';
const OS_LEGACY_BASE = 'https://rest.opensubtitles.org/search';
const STREMIO_BASE = process.env.STREMIO_SUBS_BASE || 'https://opensubtitles-v3.strem.io/subtitles';
const HTTP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MEM_TTL_MS = 20 * 60 * 1000;
const LIB_TTL_MS = 14 * 24 * 3600 * 1000;
const LIB_MISS_TTL_MS = 6 * 3600 * 1000;
const TEXT_TTL_MS = 30 * 60 * 1000;
const MAX_DOWNLOADS = 5;       // por título e por rodada (o resto fica só em metadados)
const PREPARE_DEADLINE_MS = 9000;

/* ------------------------------------------------------------------------------------------------
 * 1. Idioma
 * ---------------------------------------------------------------------------------------------- */

/**
 * Rótulo/código de legenda -> { lang, region }. Entende "pt-BR", "pt_br", "pob", "por", "Portuguese - Brazilian",
 * "Português (Brasil)", "European Portuguese"… `region`: 'br' | 'pt' | '' (português sem região).
 */
function parseLabel(label, code) {
  const raw = `${code || ''} ${label || ''}`.trim().toLowerCase();
  if (!raw) return { lang: 'und', region: '' };
  const has = (re) => re.test(raw);
  const portuguese = has(/\b(pt|por|pob|pb|ptbr|pt[-_ ]?br|pt[-_ ]?pt)\b/) || has(/portugu[eê]s|portuguese|brazil|brasil|brasile/);
  if (portuguese) {
    let region = '';
    if (has(/\b(pob|pb|ptbr|pt[-_ ]?br)\b/) || has(/brazil|brasil|brasile/)) region = 'br';
    else if (has(/\bpt[-_ ]?pt\b/) || has(/portugal|european|europe|europeu/)) region = 'pt';
    return { lang: 'pt', region };
  }
  const map = [
    ['en', /\b(en|eng)\b|english|ingl[eê]s/], ['es', /\b(es|spa)\b|espa[nñ]ol|spanish|espanhol/],
    ['fr', /\b(fr|fre|fra)\b|fran[cç]ais|french|franc[eê]s/], ['de', /\b(de|ger|deu)\b|deutsch|german|alem[aã]o/],
    ['it', /\b(it|ita)\b|italian/]
  ];
  for (const [lang, re] of map) if (re.test(raw)) return { lang, region: '' };
  const two = /^([a-z]{2})(?:[-_][a-z]{2,4})?$/.exec(String(code || label || '').trim().toLowerCase());
  return { lang: two ? two[1] : 'und', region: '' };
}

const WORDS = {
  pt: new Set(['não', 'você', 'vocês', 'uma', 'então', 'são', 'também', 'isso', 'ele', 'ela', 'nós', 'já', 'mas', 'pra',
    'obrigado', 'obrigada', 'porque', 'tudo', 'sim', 'minha', 'ainda', 'agora', 'onde', 'fazer', 'estou', 'tenho', 'quero',
    'pode', 'vou', 'vai', 'foi', 'aqui', 'muito', 'seu', 'sua', 'dos', 'das', 'nada', 'quem', 'quando', 'tem']),
  es: new Set(['usted', 'ustedes', 'pero', 'los', 'las', 'una', 'esto', 'eso', 'muy', 'yo', 'gracias', 'bueno', 'soy', 'tengo',
    'quiero', 'puedo', 'ahora', 'señor', 'también', 'está', 'qué', 'cómo', 'nada', 'pues', 'sí', 'mí', 'tú']),
  en: new Set(['the', 'you', 'and', 'that', 'what', 'this', 'with', 'have', 'just', 'don', 'your', 'are', 'not', 'but', 'was',
    'they', 'for', 'will', 'can', 'there', 'about', 'know', 'like', 'get', 'would', 'out', 'she', 'his', 'her', 'from'])
};

// Marcas do português de Portugal x do Brasil. Peso maior = mais característico.
const PT_PT_MARKS = [
  [/\best(?:ou|ás|á|amos|ão|ava|avam|iveste|ive)\s+a\s+[a-zçãõáéíóúâêô]+(?:ar|er|ir|or)\b/g, 3],
  [/\b(?:estás|queres|podes|fazes|tens|sabes|vais|devias|dizes|ouves|vês|precisas|gostas|andas)\b/g, 3],
  [/\b(?:ecrã|autocarro|miúd[oa]s?|rapariga|raparigas|comboio|telemóvel|casa de banho|pequeno-almoço|sítio|facto|equipa|fixe|bué|giro|gajo|puto|pá|esquadra)\b/g, 3],
  [/\b(?:tu)\b/g, 1],
  [/\b\w+-(?:me|te|lhe|nos|vos|lhes)\b/g, 1]
];
const PT_BR_MARKS = [
  [/\b(?:você|vocês)\b/g, 3],
  [/\b(?:cara|gente|legal|ônibus|tela|celular|trem|banheiro|café da manhã|moleque|garota|bacana|valeu|beleza|cadê|né|fato|time|ator)\b/g, 2],
  [/\b(?:pra)\b/g, 1],
  [/\b(?:estou|está|estamos|estão|estava|estavam)\s+[a-zçãõáéíóúâêô]+(?:ando|endo|indo|ondo)\b/g, 3],
  [/\b(?:me|te|lhe|nos)\s+(?:diz|dá|dê|fala|conta|deixa|ajuda|escuta|ouve|ligue|liga|chama)\b/g, 1]
];

/** Texto de legenda (cues) -> { lang: 'pt'|'en'|'es'|'other', variant: 'br'|'pt'|'', conf, shares }. */
function detectText(cues) {
  const text = cues.map((c) => c.text).join(' \n ').toLowerCase().slice(0, 60000);
  const tokens = text.split(/[^\p{L}']+/u).filter(Boolean);
  if (tokens.length < 30) return { lang: 'other', variant: '', conf: 0, shares: {} };
  const shares = {};
  for (const lang of Object.keys(WORDS)) {
    let hits = 0;
    for (const t of tokens) if (WORDS[lang].has(t)) hits += 1;
    shares[lang] = hits / tokens.length;
  }
  const accents = (text.match(/[ãõç]/g) || []).length / text.length;
  const tilde = (text.match(/[ñ¿¡]/g) || []).length / text.length;
  shares.pt += accents * 4;
  shares.es += tilde * 6;
  const ranked = Object.keys(shares).sort((a, b) => shares[b] - shares[a]);
  const best = ranked[0];
  if (shares[best] < 0.05) return { lang: 'other', variant: '', conf: 0, shares };
  const conf = shares[best] / Math.max(0.001, shares[ranked[1]] || 0.001);
  let variant = '';
  if (best === 'pt') {
    const score = (marks) => marks.reduce((sum, [re, w]) => sum + (text.match(re) || []).length * w, 0);
    const pt = score(PT_PT_MARKS);
    const br = score(PT_BR_MARKS);
    if (pt >= 12 && pt > br * 1.4) variant = 'pt';
    else if (br >= 6 && br >= pt) variant = 'br';
    else if (pt > br * 1.4 && pt >= 6) variant = 'pt';
  }
  return { lang: best, variant, conf: Math.round(conf * 100) / 100, shares };
}

/* ------------------------------------------------------------------------------------------------
 * 2. Análise de uma legenda (WebVTT já limpo)
 * ---------------------------------------------------------------------------------------------- */

function analyze(vtt, runtimeSec) {
  const cues = parseCues(vtt).filter((c) => c.e > c.s && c.text);
  const info = analyzeVtt(vtt);
  const onsets = Float64Array.from(cues.map((c) => c.s).sort((a, b) => a - b));
  let hi = 0;
  let mojibake = 0;
  let chars = 0;
  for (const c of cues) {
    if (/^[\[(♪].*[\])♪]$/s.test(c.text.trim()) || /^[-\s]*[\[(][^\])]{2,40}[\])]/.test(c.text)) hi += 1;
    mojibake += (c.text.match(/Ã[ -¿]|Â[ -¿]|â€|�/g) || []).length;
    chars += c.text.length;
  }
  const detected = detectText(cues);
  const total = Number(runtimeSec) || 0;
  return {
    cues: cues.length,
    firstStart: info.firstStart,
    lastEnd: info.lastEnd,
    garbled: chars ? Math.max(info.garbled, mojibake / chars) : 0,
    hiRatio: cues.length ? hi / cues.length : 0,
    lang: detected.lang,
    variant: detected.variant,
    langConf: detected.conf,
    coverage: total > 0 ? Math.round((info.lastEnd / total) * 1000) / 1000 : null,
    onsets
  };
}

/* ------------------------------------------------------------------------------------------------
 * 3. Comparação de tempos (alinha os horários das falas de duas legendas)
 * ---------------------------------------------------------------------------------------------- */

// Trocas de fps que explicam quase toda legenda "que vai escorregando".
const RATIOS = [1, 25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25, 24 / 23.976, 23.976 / 24, 30 / 25, 25 / 30, 29.97 / 25, 25 / 29.97];

function medianOf(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[a.length >> 1];
}

// Quantas falas de A (já em `x*ratio+off`) têm uma fala de B a menos de `tol` s, e a mediana das diferenças.
function matchFraction(A, B, ratio, off, tol) {
  let j = 0;
  let hitsA = 0;
  const hitB = new Uint8Array(B.length);
  const diffs = [];
  for (let i = 0; i < A.length; i += 1) {
    const x = A[i] * ratio + off;
    while (j < B.length - 1 && B[j + 1] <= x) j += 1;
    let k = j;
    if (j + 1 < B.length && Math.abs(B[j + 1] - x) < Math.abs(B[j] - x)) k = j + 1;
    const d = B[k] - x;
    if (Math.abs(d) <= tol) { hitsA += 1; hitB[k] = 1; diffs.push(d); }
  }
  let hitsB = 0;
  for (let i = 0; i < hitB.length; i += 1) hitsB += hitB[i];
  return { fracA: hitsA / A.length, fracB: hitsB / B.length, shift: medianOf(diffs) };
}

/**
 * Alinha os horários de início das falas de `A` sobre os de `B`: B ≈ A*ratio + offset.
 * @returns { ok, offset, ratio, frac, lift } | null
 *   frac = fração das falas das duas legendas que se encontram (≤ 0,8 s); lift = quanto isso supera o acaso (0..1).
 */
function alignOnsets(A, B, opts) {
  opts = opts || {};
  const maxLag = opts.maxLag || 150;
  const tol = opts.tol || 0.8;
  const bin = 0.25;
  if (!A || !B || A.length < 20 || B.length < 20) return null;
  const spanB = Math.max(60, B[B.length - 1] - B[0]);
  const base = 1 - Math.exp(-2 * tol * (B.length / spanB));
  const nb = Math.ceil((2 * maxLag) / bin) + 3;

  const tryRatio = (ratio) => {
    const h = new Int32Array(nb);
    let lo = 0;
    for (let i = 0; i < A.length; i += 1) {
      const x = A[i] * ratio;
      while (lo < B.length && B[lo] < x - maxLag) lo += 1;
      for (let j = lo; j < B.length && B[j] <= x + maxLag; j += 1) h[Math.round((B[j] - x + maxLag) / bin)] += 1;
    }
    let best = 1;
    let bestV = -1;
    for (let b = 1; b < nb - 1; b += 1) {
      const v = h[b - 1] + h[b] + h[b + 1];
      if (v > bestV) { bestV = v; best = b; }
    }
    let off = best * bin - maxLag;
    for (let pass = 0; pass < 2; pass += 1) off += matchFraction(A, B, ratio, off, 1.2).shift;
    const m = matchFraction(A, B, ratio, off, tol);
    const frac = (m.fracA + m.fracB) / 2;
    return { ratio, offset: off + 0, frac, lift: Math.max(0, (frac - base) / (1 - base)) };
  };

  let best = tryRatio(1);
  if (best.lift < 0.6) {
    for (let r = 1; r < RATIOS.length; r += 1) {
      const t = tryRatio(RATIOS[r]);
      if (t.lift > best.lift + 0.12) best = t;
    }
  }
  best.offset = Math.round(best.offset * 1000) / 1000;
  best.frac = Math.round(best.frac * 1000) / 1000;
  best.lift = Math.round(best.lift * 1000) / 1000;
  best.ok = best.lift >= 0.4 && best.frac >= 0.45;
  return best;
}

const sameTimeline = (al) => Boolean(al && al.ok && al.ratio === 1 && Math.abs(al.offset) <= 0.7);

/* ------------------------------------------------------------------------------------------------
 * 4. Pontuação e escolha
 * ---------------------------------------------------------------------------------------------- */

/** Motivo para NUNCA entregar este arquivo como pt-BR ('' = serve). */
function rejectReason(c, ctx) {
  const a = c.stats;
  if (!a || !a.cues) return 'vazia';
  if (a.garbled > 0.012) return 'caracteres quebrados';
  if (a.lang !== 'pt') return a.lang === 'other' ? 'não parece português' : `está em ${a.lang === 'en' ? 'inglês' : a.lang === 'es' ? 'espanhol' : a.lang}`;
  if (a.variant === 'pt') return 'português de Portugal';
  const total = ctx.runtimeSec;
  if (total > 900) {
    if (a.lastEnd < total * 0.7) return 'incompleta (termina cedo demais)';
    if (a.lastEnd > total * 1.35) return 'de outra versão do filme (longa demais)';
    if (a.cues < Math.max(20, total / 140)) return 'poucas falas';
  } else if (!total && a.cues < 15) {
    return 'poucas falas';
  }
  if (c.meta && c.meta.machine) return 'tradução automática';
  return '';
}

function metaScore(m) {
  let s = 0;
  if (!m) return s;
  s += Math.log10((m.downloads || 0) + 1) * 7;
  s += Math.max(0, Math.min(10, m.rating || 0)) * 1.2;
  if (m.trusted) s += 10;
  if (m.hi) s -= 8;
  if (m.cds > 1) s -= 40;
  if (m.machine) s -= 60;
  return s;
}

function scoreAll(cands, ctx) {
  const ref = ctx.reference;
  for (const c of cands) {
    c.why = [];
    c.reject = rejectReason(c, ctx);
    c.score = 0;
    c.align = null;
  }
  const ok = cands.filter((c) => !c.reject);
  // timeline entre as candidatas
  for (let i = 0; i < ok.length; i += 1) {
    ok[i].peers = 0;
    ok[i].cut = 0;
  }
  for (let i = 0; i < ok.length; i += 1) {
    for (let j = i + 1; j < ok.length; j += 1) {
      const al = alignOnsets(ok[i].stats.onsets, ok[j].stats.onsets, { maxLag: 60 });
      if (!al || !al.ok) continue;
      ok[i].cut += 1; ok[j].cut += 1;
      if (sameTimeline(al)) { ok[i].peers += 1; ok[j].peers += 1; }
    }
  }
  for (const c of ok) {
    const a = c.stats;
    let s = 100;
    if (c.region === 'br' || a.variant === 'br') { s += 22; c.why.push('pt-BR'); } else { s += 4; c.why.push('português (sem marca de região)'); }
    s += metaScore(c.meta);
    if (a.coverage) {
      const dist = Math.abs(a.coverage - 0.95);
      s += dist <= 0.06 ? 12 : dist <= 0.14 ? 4 : -10;
    }
    if (a.hiRatio > 0.04) { s -= 6; c.why.push('para surdos'); }
    s += Math.min(3, c.peers) * 12;
    if (c.peers) c.why.push(`${c.peers} outra(s) com o mesmo tempo`);
    if (ref && ref.onsets.length >= 80) {
      c.align = alignOnsets(a.onsets, ref.onsets, { maxLag: 150 });
      if (c.align && c.align.ok) {
        s += 12 + 36 * c.align.lift;
        c.why.push(`casa com a referência (${Math.round(c.align.frac * 100)}%)`);
      } else if (c.align) {
        s -= 25;
        c.why.push('não casa com a referência (outro corte?)');
      }
    }
    c.score = Math.round(s * 10) / 10;
  }
  return cands;
}

/**
 * Corrige atraso/fps pela referência quando ela é DO MESMO VÍDEO que vai tocar.
 * Devolve { shift, scale, basis } (0/1 = nada a fazer).
 */
function presync(c, ctx) {
  const none = { shift: 0, scale: 1, basis: '' };
  if (!ctx.referenceTrusted || !c.align || !c.align.ok) return none;
  const al = c.align;
  if (al.lift < 0.5 || al.frac < 0.5) return none;
  if (Math.abs(al.offset) > 150) return none;
  if (Math.abs(al.offset) < 0.25 && al.ratio === 1) return none;
  return { shift: al.offset, scale: al.ratio, basis: 'referência do próprio vídeo' };
}

/**
 * Ordena as candidatas. `cands`: [{ id, source, region, stats, meta, vtt, label }].
 * @returns { ptbr: [...melhor primeiro], ptpt: [...], rejected: [{ id, reason }], hasReference }
 */
function rank(cands, ctx) {
  ctx = ctx || {};
  const all = scoreAll(cands.slice(), ctx);
  const good = all.filter((c) => !c.reject).sort((a, b) => b.score - a.score);
  for (const c of good) c.sync = presync(c, ctx);
  return {
    ptbr: good,
    ptpt: all.filter((c) => c.reject === 'português de Portugal'),
    rejected: all.filter((c) => c.reject).map((c) => ({ id: c.id, source: c.source, reason: c.reject })),
    hasReference: Boolean(ctx.reference)
  };
}

/* ------------------------------------------------------------------------------------------------
 * 5. Fontes de legenda
 * ---------------------------------------------------------------------------------------------- */

const deps = {
  fetch: (...args) => fetch(...args),
  imdbIdOf: (...args) => require('./streamExtractor').imdbIdOf(...args),
  now: () => Date.now(),
  osApi: () => require('./opensubtitles'),
  store: null   // { get(key), put(key, value) } — padrão: Supabase quando houver
};

async function getJson(url, headers, ms) {
  const res = await deps.fetch(url, { headers: headers || {}, signal: AbortSignal.timeout(ms || 6000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function toSec(hms) {
  const m = /^(\d+):(\d{2}):(\d{2})/.exec(String(hms || ''));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/** OpenSubtitles legado: catálogo inteiro, sem chave, com metadados ricos (inclui a última fala: SubLastTS). */
async function searchLegacy({ imdb, type, season, episode }) {
  if (!imdb) return [];
  const id = String(imdb).replace(/^tt/, '');
  const parts = [];
  if (type === 'tv') parts.push(`episode-${Number(episode) || 1}`);
  parts.push(`imdbid-${id}`);
  if (type === 'tv') parts.push(`season-${Number(season) || 1}`);
  parts.push('sublanguageid-pob');
  const rows = await getJson(`${OS_LEGACY_BASE}/${parts.join('/')}`, { 'User-Agent': OS_LEGACY_UA, Accept: 'application/json' }, 7000);
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.SubDownloadLink && r.SubFormat === 'srt')
    .map((r) => ({
      source: 'os-legacy',
      ext: String(r.IDSubtitleFile),
      url: String(r.SubDownloadLink),
      code: 'pob',
      release: String(r.MovieReleaseName || r.SubFileName || ''),
      fps: Number(r.MovieFPS) || 0,
      lastEnd: toSec(r.SubLastTS),
      downloads: Number(r.SubDownloadsCnt) || 0,
      rating: Number(r.SubRating) || 0,
      votes: Number(r.SubSumVotes) || 0,
      trusted: r.SubFromTrusted === '1' || r.SubFromTrusted === 1,
      hi: r.SubHearingImpaired === '1' || r.SubHearingImpaired === 1,
      machine: r.SubAutoTranslation === '1' || r.SubAutoTranslation === 1 || r.SubBad === '1',
      foreign: r.SubForeignPartsOnly === '1',
      cds: Number(r.SubSumCD) || 1,
      encoding: String(r.SubEncoding || '')
    }));
}

/** Addon do Stremio para o OpenSubtitles: sem cota, devolve UTF-8; `pob` = Brasil. */
async function searchStremio({ imdb, type, season, episode }) {
  if (!imdb) return [];
  const idPart = type === 'tv' ? `series/${imdb}:${Number(season) || 1}:${Number(episode) || 1}` : `movie/${imdb}`;
  const data = await getJson(`${STREMIO_BASE}/${idPart}.json`, { Accept: 'application/json' }, 7000);
  return (Array.isArray(data && data.subtitles) ? data.subtitles : [])
    .filter((s) => s && s.url && (s.lang === 'pob' || s.lang === 'por'))
    .map((s) => ({
      source: 'stremio',
      ext: String(s.id),
      url: String(s.url),
      code: s.lang,
      release: String(s.movieReleaseName || s.subtitleFileName || ''),
      fps: (Number(s.fpsMilli) || 0) / 1000,
      lastEnd: 0,
      downloads: 0,
      rating: 0,
      votes: 0,
      trusted: false,
      hi: false,
      machine: false,
      cds: /\b(cd|part)\s*[12]\b|\(\s*[12]\s*of\s*2\s*\)/i.test(`${s.subtitleFileName} ${s.movieReleaseName}`) ? 2 : 1,
      encoding: String(s.SubEncoding || '')
    }));
}

/** API nova (COTA de 100 downloads/dia no site todo): só metadados aqui; o download é do `fetchOsApi`. */
async function searchOsApi({ id, type, season, episode }) {
  const os = deps.osApi();
  const rows = await os.searchRaw({ tmdbId: id, type, season, episode });
  return rows
    .filter((r) => r && r.attributes && Array.isArray(r.attributes.files) && r.attributes.files[0] && r.attributes.files[0].file_id)
    .map((r) => {
      const a = r.attributes;
      return {
        source: 'os-api',
        ext: String(a.files[0].file_id),
        url: '',
        code: 'pob',
        release: String(a.release || ''),
        fps: Number(a.fps) || 0,
        lastEnd: 0,
        downloads: Number(a.download_count) || 0,
        rating: Number(a.ratings) || 0,
        votes: Number(a.votes) || 0,
        trusted: Boolean(a.from_trusted),
        hi: Boolean(a.hearing_impaired),
        machine: Boolean(a.machine_translated || a.ai_translated),
        foreign: Boolean(a.foreign_parts_only),
        cds: Number(a.nb_cd) || 1,
        encoding: ''
      };
    });
}

/** Ordem de download: o que os metadados já dizem ser melhor (e inteiro, se a fonte informa a última fala). */
function preRank(metas, runtimeSec) {
  const rows = metas.filter((m) => !m.machine && !m.foreign && m.cds <= 1);
  const score = (m) => {
    let s = metaScore(m);
    if (runtimeSec > 900 && m.lastEnd) {
      const r = m.lastEnd / runtimeSec;
      if (r < 0.6 || r > 1.35) s -= 80; else if (Math.abs(r - 0.95) <= 0.07) s += 12;
    }
    if (m.code === 'pob') s += 10;
    return s;
  };
  return rows.map((m) => ({ m, s: score(m) })).sort((a, b) => b.s - a.s).map((x) => x.m);
}

/* ------------------------------------------------------------------------------------------------
 * 6. Download + limpeza (compartilhado com o servidor)
 * ---------------------------------------------------------------------------------------------- */

const textCache = new Map(); // url -> { promise, at }

/** URL -> { vtt, info } (decodifica, tira propaganda, converte para WebVTT). Pedidos iguais dividem o download. */
function loadText(url, lang, opts) {
  const hit = textCache.get(url);
  if (hit && deps.now() - hit.at < TEXT_TTL_MS) return hit.promise;
  const promise = (async () => {
    const res = await deps.fetch(url, {
      headers: { 'User-Agent': (opts && opts.ua) || HTTP_UA },
      signal: AbortSignal.timeout((opts && opts.timeout) || 12000)
    });
    if (!res.ok) throw new Error(`Falha ao baixar legenda (HTTP ${res.status})`);
    return cleanBytes(Buffer.from(await res.arrayBuffer()), lang);
  })();
  textCache.set(url, { promise, at: deps.now() });
  promise.catch(() => { if (textCache.get(url) && textCache.get(url).promise === promise) textCache.delete(url); });
  while (textCache.size > 120) textCache.delete(textCache.keys().next().value);
  return promise;
}

function cleanBytes(buf, lang) {
  const text = decodeSubtitle(buf, lang);
  const vtt = /^\s*﻿?WEBVTT/.test(text) ? text : srtToVtt(text);
  const cleaned = stripSpamCues(vtt);
  return { vtt: cleaned.vtt, spamRemoved: cleaned.removed, info: { ...analyzeVtt(cleaned.vtt), spamRemoved: cleaned.removed } };
}

/* ------------------------------------------------------------------------------------------------
 * 7. Biblioteca (guarda o resultado; evita gastar cota e rede em título repetido)
 * ---------------------------------------------------------------------------------------------- */

function libKey(t) {
  return `sublib:v1:${t.type === 'tv' ? 'tv' : 'movie'}:${t.id}:${t.type === 'tv' ? `${t.season}x${t.episode}` : '-'}`;
}

// A biblioteca não pode crescer para sempre no Supabase: depois da 1ª gravação do processo, apaga as linhas vencidas.
let pruned = false;
function pruneOnce(us) {
  if (pruned) return;
  pruned = true;
  const cutoff = new Date(deps.now() - LIB_TTL_MS).toISOString();
  us.call('DELETE', `/pix_settings?k=like.${encodeURIComponent('sublib:v1:*')}&updated_at=lt.${encodeURIComponent(cutoff)}`,
    undefined, { Prefer: 'return=minimal' }, { quiet: true }).catch(() => {});
}

function theStore() {
  if (deps.store) return deps.store;
  try {
    const us = require('./usageStore');
    if (!us.enabled()) return null;
    const quiet = { quiet: true };
    return {
      async get(key) {
        const rows = await us.call('GET', `/pix_settings?select=v&k=eq.${encodeURIComponent(key)}&limit=1`, undefined, undefined, quiet);
        return rows && rows[0] ? rows[0].v : null;
      },
      async put(key, v) {
        await us.call('POST', '/pix_settings?on_conflict=k', { k: key, v, updated_at: new Date().toISOString() },
          { Prefer: 'resolution=merge-duplicates,return=minimal' }, quiet);
        pruneOnce(us);
      }
    };
  } catch (err) {
    return null;
  }
}

function deflate(vtt) { return zlib.gzipSync(Buffer.from(vtt, 'utf8')).toString('base64'); }
function inflate(b64) { return zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'); }

/* ------------------------------------------------------------------------------------------------
 * 8. Orquestração
 * ---------------------------------------------------------------------------------------------- */

const prepared = new Map();  // chave -> { value, at }
const inflight = new Map();
const osApiState = { remaining: null, at: 0 };

function makeCandidate(meta, text, runtimeSec) {
  const stats = analyze(text.vtt, runtimeSec);
  const parsed = parseLabel('', meta.code);
  return {
    id: `${meta.source}:${meta.ext}`,
    source: meta.source,
    region: parsed.region || (meta.code === 'pob' ? 'br' : ''),
    meta: {
      release: meta.release, fps: meta.fps, downloads: meta.downloads, rating: meta.rating, votes: meta.votes,
      trusted: meta.trusted, hi: meta.hi, machine: meta.machine, cds: meta.cds
    },
    vtt: text.vtt,
    info: text.info,
    stats
  };
}

async function downloadMeta(meta) {
  if (meta.source === 'os-api') {
    const os = deps.osApi();
    const known = os.quota && Number.isFinite(os.quota.remaining) ? os.quota.remaining : osApiState.remaining;
    if (known !== null && known < 12) throw new Error('cota do OpenSubtitles quase no fim');
    const link = await os.download(Number(meta.ext));
    if (!link) throw new Error('sem link');
    if (Number.isFinite(os.quota.remaining)) osApiState.remaining = os.quota.remaining;
    return loadText(link, 'pt');
  }
  return loadText(meta.url, 'pt', meta.source === 'os-legacy' ? { ua: OS_LEGACY_UA } : undefined);
}

async function downloadAll(metas, runtimeSec, seen) {
  const out = await Promise.all(metas.map(async (m) => {
    try {
      const text = await downloadMeta(m);
      const hash = crypto.createHash('sha1').update(text.vtt).digest('hex');
      if (seen.has(hash)) return null;
      seen.add(hash);
      return makeCandidate(m, text, runtimeSec);
    } catch (err) {
      return null;
    }
  }));
  return out.filter(Boolean);
}

/**
 * Busca e confere as candidatas pt-BR do título (rede + biblioteca). Não precisa do vídeo escolhido:
 * pode ser chamada em paralelo com a cascata, ou antes dela.
 * `title`: { id, type, season, episode, runtimeSec }
 * @returns Promise<{ cands, notes }>
 */
function prepare(title) {
  const key = libKey(title);
  const hit = prepared.get(key);
  if (hit && deps.now() - hit.at < MEM_TTL_MS) return Promise.resolve(hit.value);
  if (inflight.has(key)) return inflight.get(key);
  const job = runPrepare(title, key)
    .then((value) => {
      prepared.set(key, { value, at: deps.now() });
      while (prepared.size > 40) prepared.delete(prepared.keys().next().value);   // ~0,5 MB por título: o Render Free tem 512 MB
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function runPrepare(title, key) {
  const runtimeSec = Number(title.runtimeSec) || 0;
  const notes = [];
  const store = theStore();

  if (store) {
    try {
      const saved = await store.get(key);
      const age = saved ? deps.now() - Date.parse(saved.at || 0) : Infinity;
      if (saved && saved.v === 1 && Array.isArray(saved.items) && age < (saved.items.length ? LIB_TTL_MS : LIB_MISS_TTL_MS)) {
        const cands = saved.items.map((it) => {
          const text = { vtt: inflate(it.gz), info: it.info || {} };
          return makeCandidate({ ...it.meta, source: it.source, ext: it.ext, code: it.code, release: it.meta.release }, text, runtimeSec);
        });
        notes.push(`biblioteca: ${cands.length} legenda(s) já conferida(s)`);
        return { cands, notes, fromLibrary: true };
      }
    } catch (err) { /* sem biblioteca: busca de novo */ }
  }

  const deadline = deps.now() + PREPARE_DEADLINE_MS;
  const imdb = await Promise.resolve(deps.imdbIdOf(title.id, title.type)).catch(() => null);
  const seen = new Set();
  const cands = [];
  const settle = (p) => p.catch((err) => { notes.push('falha: ' + String(err.message || err).slice(0, 60)); return []; });
  const left = () => deadline - deps.now();

  const [legacy, stremio] = await Promise.all([
    settle(searchLegacy({ imdb, type: title.type, season: title.season, episode: title.episode })),
    settle(searchStremio({ imdb, type: title.type, season: title.season, episode: title.episode }))
  ]);
  notes.push(`catálogo: legado ${legacy.length}, stremio ${stremio.length}`);

  const goodCount = () => cands.filter((c) => !rejectReason(c, { runtimeSec })).length;

  const first = preRank(legacy, runtimeSec).slice(0, 4);
  if (first.length && left() > 0) cands.push(...await downloadAll(first, runtimeSec, seen));

  if (goodCount() < 3 && stremio.length && left() > 0) {
    const extra = preRank(stremio, runtimeSec).slice(0, 3);
    cands.push(...await downloadAll(extra, runtimeSec, seen));
  }

  if (goodCount() < 2 && left() > 1500) {
    const api = await settle(searchOsApi({ id: title.id, type: title.type, season: title.season, episode: title.episode }));
    notes.push(`api nova: ${api.length}`);
    const picks = preRank(api, runtimeSec).slice(0, 2);
    if (picks.length) cands.push(...await downloadAll(picks, runtimeSec, seen));
  }

  // Só guarda quando a rodada foi completa (sem estourar o prazo) e achou algo ou a busca respondeu "nada".
  if (store && left() > 0) {
    const keep = cands
      .filter((c) => !rejectReason(c, { runtimeSec }) || rejectReason(c, { runtimeSec }) === 'português de Portugal')
      .sort((a, b) => metaScore(b.meta) - metaScore(a.meta)).slice(0, 3);
    const answered = legacy.length || stremio.length || keep.length;
    if (keep.length || answered === 0) {
      store.put(key, {
        v: 1,
        at: new Date(deps.now()).toISOString(),
        items: keep.map((c) => ({
          source: c.source, ext: c.id.slice(c.source.length + 1), code: c.region === 'br' ? 'pob' : 'por',
          meta: c.meta, info: c.info, gz: deflate(c.vtt)
        }))
      }).catch(() => {});
    }
  }
  // Em memória fica só o que serve (ou o pt de Portugal, que a pessoa pode escolher): o texto das barradas não volta a ser usado.
  const useful = cands.filter((c) => { const why = rejectReason(c, { runtimeSec }); return !why || why === 'português de Portugal'; });
  notes.push(`${cands.length} baixada(s), ${useful.length} útil(eis)`);
  return { cands: useful, notes };
}

/**
 * Junta o que `prepare` achou com as legendas que o PRÓPRIO vídeo trouxe (e as de companhia) e escolhe.
 * `extras`: [{ url, language }] (formato do `streamInfo.captions`).
 * `trusted(url)`: a legenda desse endereço foi feita para ESTE vídeo (a própria fonte trouxe, ou é o VidLink tocando).
 * @returns { ptbr, ptpt, rejected, hasReference, notes }
 */
async function choose(prep, opts) {
  opts = opts || {};
  const runtimeSec = Number(opts.runtimeSec) || 0;
  const cands = (prep && prep.cands ? prep.cands : []).slice();
  const notes = (prep && prep.notes ? prep.notes : []).slice();
  const extras = Array.isArray(opts.extras) ? opts.extras.filter((c) => c && c.url) : [];

  let reference = null;
  const jobs = [];
  const taken = new Set(cands.map((c) => crypto.createHash('sha1').update(c.vtt).digest('hex')));
  const trusted = typeof opts.trusted === 'function' ? opts.trusted : () => false;
  const english = [];
  for (const ex of extras) {
    const p = parseLabel(ex.language, '');
    if (p.lang === 'pt') jobs.push(loadText(ex.url, 'pt').then((text) => ({ ex, text, p })).catch(() => null));
    else if (p.lang === 'en') english.push(ex);
  }
  // Referência de tempo: o inglês que foi feito PARA ESTE VÍDEO (da própria fonte) vale mais que um de companhia.
  const refEx = english.find((ex) => trusted(ex.url)) || english[0] || null;
  const refJob = refEx ? loadText(refEx.url, 'en').then((t) => analyze(t.vtt, runtimeSec)).catch(() => null) : Promise.resolve(null);
  const [found, refStats] = await Promise.all([Promise.all(jobs), refJob]);
  for (const f of found) {
    if (!f) continue;
    const hash = crypto.createHash('sha1').update(f.text.vtt).digest('hex');
    if (taken.has(hash)) continue;
    taken.add(hash);
    const c = makeCandidate({ source: 'provider', ext: String(taken.size), code: '', release: '', fps: 0, downloads: 0, rating: 0, votes: 0, trusted: false, hi: false, machine: false, cds: 1 }, f.text, runtimeSec);
    c.region = f.p.region;
    c.url = f.ex.url;
    cands.push(c);
  }
  if (refStats && refStats.cues >= 80 && refStats.lang === 'en') reference = refStats;
  else if (refStats) notes.push('referência descartada (' + refStats.lang + ', ' + refStats.cues + ' falas)');
  const referenceTrusted = Boolean(reference && refEx && trusted(refEx.url));
  if (reference) notes.push(`referência: inglês com ${reference.cues} falas (${referenceTrusted ? 'do próprio vídeo' : 'de companhia'})`);

  const ranked = rank(cands, { runtimeSec, reference, referenceTrusted });
  return { ...ranked, notes };
}

function _reset() {
  prepared.clear(); inflight.clear(); textCache.clear(); osApiState.remaining = null;
}

module.exports = {
  parseLabel, detectText, analyze, alignOnsets, rank, rejectReason, preRank, presync,
  prepare, choose, loadText, cleanBytes,
  searchLegacy, searchStremio, searchOsApi,
  _deps: deps, _reset
};
