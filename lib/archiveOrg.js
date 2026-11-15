'use strict';

/**
 * Fonte "Internet Archive" (archive.org) — FILMES com MP4 público, muitos com áudio em pt-BR
 * (rips de DVD "R4BR", "Europa Filmes", etc.).
 *
 * POR QUE ELA RESOLVE O IMPASSE DO RENDER:
 *   - o archive.org NÃO fica atrás de Cloudflare e não desafia IP de datacenter (redecanais e
 *     mgeb.lat devolvem 403 para o Render e para o Worker; aqui não existe esse problema);
 *   - tem API JSON pública (advancedsearch + metadata), sem chave e sem cadastro;
 *   - o MP4 é estável (sem token que expira nem IP preso), aceita `Range` e a banda é deles:
 *     o navegador baixa direto do servidor do acervo (`browserDirect`): 0 byte no Render.
 *
 * COMO ESCOLHE (a busca por título é frouxa, então confirma por três sinais):
 *   1. nomes do TMDB (pt-BR, original, inglês, alternativos) → `advancedsearch`;
 *   2. título parecido (`titleScore`), sem trailer/making of/clipe;
 *   3. DURAÇÃO do arquivo contra o runtime do TMDB (é o que separa filme de extra/parte).
 *   Preferência: metadado `language: por`, "dublado"/"R4BR"/"pt-BR" no título, ano batendo.
 *   Fora: 10-bit/HEVC (o navegador não toca), mkv/avi (só `.mp4`).
 *
 * O download passa por um 302 para o servidor do item (`dnNNN.us.archive.org`); resolvemos o
 * redirect aqui e devolvemos a URL final (o Chrome perde o `Origin` nos `Range` após redirect).
 * O servidor final NÃO manda `Access-Control-Allow-Origin`: vem `cors: false` (o <video> vai sem
 * `crossorigin`).
 *
 * ESCOPO: só filmes. Variáveis: ARCHIVEORG_ENABLED=0 desliga; ARCHIVEORG_BUDGET_MS (padrão 9000).
 */

const tokyo = require('./tokyoVideo');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const API = 'https://archive.org';
const MAX_NAMES = 4;
const MAX_CANDIDATES = 4;
const MIN_SCORE = 62;
const PICK_TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 4 * 60 * 1000;

const pickCache = new Map();

function isEnabled() {
  return String(process.env.ARCHIVEORG_ENABLED || '1') !== '0';
}

function budgetMs() {
  return Math.max(3000, Math.min(20000, Number(process.env.ARCHIVEORG_BUDGET_MS) || 9000));
}

let lastReport = null;
function getReport() {
  return lastReport;
}

/** Tem cara de arquivo que o navegador não toca (10-bit, HEVC) ou de material extra. */
function unplayableHint(text) {
  return /\b(hi10|hi10p|10[ -]?bit|hevc|x265|h\.?265)\b/i.test(String(text || ''));
}

/** "7475.92" | "02:04:35" | "1:44:12.5" -> segundos. */
function lengthSec(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// Palavras que o upload põe no título sem mudar QUEM é o filme.
const HARMLESS = new Set((
  'dvdrip dvdiso dvd bluray blu ray brrip bdrip webrip webdl web rip hdrip hdtv remux uncompressed ' +
  'archive version edition remastered restored extended theatrical directors cut r4br europa filmes ' +
  'br pt por eng jpn dual audio legendado dublado full the a o os as de da do dos das e and of ' +
  'completo completa original film movie trailer 480p 576p 720p 1080p 2160p mp4 avi mkv divx xvid ' +
  'x264 h264 aac ac3 dual web dl hdtv nacional brasil brasileiro'
).split(' '));

/**
 * O título do item é O filme pedido, e não uma sequência/spin-off ("Toy Story 2" para "Toy Story")?
 * Todas as palavras do nome pedido têm de estar no título do item, e o que sobrar só pode ser
 * palavra inofensiva (qualidade, idioma, ano). Número ou palavra nova = outro filme.
 */
function sameTitle(names, label) {
  const found = tokyo.normTitle(label).split(' ').filter(Boolean);
  for (const name of names) {
    const wanted = tokyo.normTitle(name).split(' ').filter(Boolean);
    if (!wanted.length) continue;
    const foundSet = new Set(found);
    if (!wanted.every((w) => foundSet.has(w))) continue;
    const wantedSet = new Set(wanted);
    const extra = found.filter((w) => !wantedSet.has(w));
    if (extra.every((w) => HARMLESS.has(w) || /^(19|20)\d{2}$/.test(w))) return true;
  }
  return false;
}

function hasPtHint(doc) {
  const lang = [].concat(doc.language || []).join(' ').toLowerCase();
  return /\b(por|pt|portuguese|portugu[eê]s)\b/.test(lang)
    || /dublad|pt[- ]?br|r4br|europa filmes|portugu[eê]s/i.test(String(doc.title || '') + ' ' + String(doc.identifier || ''));
}

async function getJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'tempo esgotado' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function quote(name) {
  return '"' + String(name).replace(/["\\]/g, ' ').trim() + '"';
}

async function searchItems(names, timeoutMs) {
  const q = `mediatype:movies AND (${names.map((n) => `title:(${quote(n)})`).join(' OR ')})`;
  const params = new URLSearchParams();
  params.set('q', q);
  for (const f of ['identifier', 'title', 'language', 'year', 'downloads']) params.append('fl[]', f);
  params.set('rows', '20');
  params.append('sort[]', 'downloads desc');
  params.set('output', 'json');
  const r = await getJson(`${API}/advancedsearch.php?${params}`, timeoutMs);
  if (!r.ok) return { docs: [], status: r.status, error: r.error };
  return { docs: (r.data && r.data.response && r.data.response.docs) || [], status: r.status };
}

/** Melhor MP4 do item cuja duração bate com o filme. */
async function pickFile(doc, runtimeSec, timeoutMs) {
  const r = await getJson(`${API}/metadata/${encodeURIComponent(doc.identifier)}`, timeoutMs);
  if (!r.ok || !r.data || !Array.isArray(r.data.files)) return null;
  let best = null;
  for (const f of r.data.files) {
    const name = String(f.name || '');
    if (!/\.mp4$/i.test(name) || unplayableHint(name)) continue;
    if (/sample|trailer|teaser/i.test(name)) continue;
    if (f.private === 'true' || f.private === true) continue;
    const seconds = lengthSec(f.length);
    if (!tokyo.durationFits(seconds, runtimeSec)) continue;
    const height = Number(f.height) || 0;
    const size = Number(f.size) || 0;
    const rank = (f.source === 'original' ? 1 : 0) * 1e12 + height * 1e6 + Math.min(size, 5e9) / 1e4;
    if (!best || rank > best.rank) best = { name, seconds, height, size, rank };
  }
  return best;
}

/** Segue o 302 do /download e confirma que o servidor do item responde `Range`. */
async function resolveFinalUrl(identifier, fileName, timeoutMs) {
  const start = `${API}/download/${encodeURIComponent(identifier)}/${fileName.split('/').map(encodeURIComponent).join('/')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  try {
    let url = start;
    for (let hop = 0; hop < 3; hop += 1) {
      const res = await fetch(url, { redirect: 'manual', headers: { Range: 'bytes=0-1', 'User-Agent': BROWSER_UA }, signal: controller.signal });
      if (res.body) res.body.cancel().catch(() => {});
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), url).toString();
        continue;
      }
      return res.status === 200 || res.status === 206 ? url : null;
    }
    return null;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findMovieStream({ id, type = 'movie', title = '', note } = {}) {
  if (!isEnabled() || type !== 'movie') return null;
  const key = `movie:${id}`;
  const hit = pickCache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;

  const trace = { at: new Date().toISOString(), id: String(id), etapas: [], ok: false };
  const step = (msg) => { trace.etapas.push(msg); if (typeof note === 'function') { try { note(`Internet Archive: ${msg}`); } catch (e) { /* ignore */ } } };
  const budget = budgetMs();
  const t0 = Date.now();
  const left = () => Math.max(1500, budget - (Date.now() - t0));

  try {
    const info = await tokyo.tmdbInfo(id, 'movie');
    const names = [...new Set([...(info ? info.names : []), title].filter(Boolean))].slice(0, MAX_NAMES);
    if (!names.length) { step('sem título para procurar'); return null; }
    const runtimeSec = info ? info.runtimeSec : 0;
    const year = info ? info.year : 0;

    const found = await searchItems(names, left());
    step(`busca: ${found.docs.length} item(ns)${found.status && found.status !== 200 ? ` (HTTP ${found.status})` : ''}${found.error ? ` (${found.error})` : ''}`);

    const scored = [];
    for (const doc of found.docs) {
      const label = String(doc.title || '');
      if (tokyo.looksLikeExtra(label) || /making of|cartoon network|fridays/i.test(label)) continue;
      if (unplayableHint(label) || unplayableHint(doc.identifier)) continue;
      const base = Math.max(...names.map((n) => tokyo.titleScore(n, label)));
      if (base < MIN_SCORE || !sameTitle(names, label)) continue;
      const docYear = Number(String(doc.year || '').slice(0, 4)) || tokyo.yearOf(label);
      // Ano do item no archive costuma ser o do upload/lançamento local: folga de 3 anos.
      if (year && docYear && Math.abs(docYear - year) > 3) continue;
      const pt = hasPtHint(doc);
      scored.push({ doc, pt, score: base + (pt ? 25 : 0) + Math.min(10, Math.log10(1 + Number(doc.downloads || 0)) * 2) });
    }
    scored.sort((a, b) => b.score - a.score);
    step(`${scored.length} candidato(s) com título parecido`);

    const top = scored.slice(0, MAX_CANDIDATES);
    // Metadados e teste do servidor de cada candidato em paralelo; vale o primeiro da ordem de preferência.
    const checked = await Promise.all(top.map(async (c) => {
      const file = await pickFile(c.doc, runtimeSec, left()).catch(() => null);
      if (!file) return { c, why: 'nenhum MP4 com a duração do filme' };
      const finalUrl = await resolveFinalUrl(c.doc.identifier, file.name, left());
      return finalUrl ? { c, file, finalUrl } : { c, why: 'servidor do arquivo não abriu' };
    }));
    for (const item of checked) {
      const { c, file, finalUrl } = item;
      if (!finalUrl) { step(`"${String(c.doc.title).slice(0, 40)}": ${item.why}`); continue; }
      step(`escolhido: "${String(c.doc.title).slice(0, 50)}" · ${Math.round(file.seconds / 60)} min${c.pt ? ' · pt-BR' : ''}`);
      trace.ok = true;
      const value = {
        url: finalUrl,
        provider: 'Internet Archive',
        quality: file.height ? `${file.height}p` : 'auto',
        codec: 'h264',
        isHls: false,
        browserDirect: true, // o servidor do acervo entrega ao navegador; 0 byte no Render
        cors: false,
        captions: [],
        ...(c.pt ? { audioLang: 'por' } : {})
      };
      pickCache.set(key, { value, until: Date.now() + PICK_TTL_MS });
      return value;
    }
    pickCache.set(key, { value: null, until: Date.now() + MISS_TTL_MS });
    return null;
  } catch (err) {
    step('falhou: ' + String(err.message || err).replace(/https?:\/\/\S+/g, '[url]').slice(0, 90));
    return null;
  } finally {
    lastReport = trace;
  }
}

module.exports = {
  findMovieStream,
  getReport,
  isEnabled,
  // exportados para teste
  lengthSec,
  sameTitle,
  hasPtHint,
  unplayableHint
};
