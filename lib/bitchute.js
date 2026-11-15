'use strict';

/**
 * Fonte "BitChute" — uploads de filmes inteiros, muitos "PT-BR Dublado" (o MP4 do Chihiro dublado que o
 * MGEB aponta é daqui). Pela API pública do próprio site, sem chave:
 *   POST api.bitchute.com/api/beta/search/videos   {query,...}  -> lista com `duration` ("2:04:34")
 *   POST api.bitchute.com/api/beta/video/media     {video_id}   -> { media_url: https://seedNNN.bitchute.com/.../id.mp4 }
 *
 * O MP4 (CDN do BitChute) abre sem Referer nem token e aceita `Range`; o navegador baixa direto
 * (`browserDirect`): 0 byte no Render. O CDN só libera CORS para bitchute.com, então vai `cors:false`
 * (o <video> toca sem `crossorigin`).
 *
 * ESCOLHA: nomes do TMDB (pt-BR primeiro) → título igual (`sameTitle`) → duração = runtime ± 12% →
 * "dublado/PT-BR/nacional" no título conta como áudio em português → MP4 que responde `Range` e é H.264.
 *
 * ESCOPO: só filmes. Variáveis: BITCHUTE_ENABLED=0 desliga; BITCHUTE_API=<url> troca a API;
 * BITCHUTE_BUDGET_MS (padrão 9000).
 */

const tokyo = require('./tokyoVideo');
const extractFetch = require('./extractFetch');
const archive = require('./archiveOrg');
const matchGuard = require('./matchGuard');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const MAX_NAMES = 3;
const MAX_CANDIDATES = 4;
const PICK_TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 4 * 60 * 1000;
const pickCache = new Map();

function isEnabled() {
  return String(process.env.BITCHUTE_ENABLED || '1') !== '0';
}

function apiBase() {
  return String(process.env.BITCHUTE_API || 'https://api.bitchute.com').replace(/\/+$/, '');
}

function budgetMs() {
  return Math.max(3000, Math.min(20000, Number(process.env.BITCHUTE_BUDGET_MS) || 9000));
}

// Quantas respostas foram desafio/limite do Cloudflare (o script de colheita usa para desacelerar).
const stats = { challenged: 0, calls: 0 };
function getStats() {
  return { ...stats };
}

let lastReport = null;
function getReport() {
  return lastReport;
}

async function postJson(path, body, timeoutMs) {
  // direto → relay residencial/Wasmer (EXTRACT_RELAY_URL) → Worker: o mesmo caminho das outras extrações.
  const r = await extractFetch.postJsonSmart(apiBase() + path, body, { timeoutMs: Math.max(1500, timeoutMs) });
  stats.calls += 1;
  if (!r.ok && (r.challenge || r.status === 429 || r.status === 403)) stats.challenged += 1;
  return r.ok ? { ok: true, status: r.status, data: r.data, via: r.via } : { ok: false, status: r.status, error: r.error, tried: r.tried };
}

/** "2:04:34" | "94:10" | "45" -> segundos. */
function parseDuration(text) {
  const parts = String(text || '').trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const PT_HINT = /dublad|pt[- ]?br|nacional|portugu[eê]s|dual[ .-]?audio|dual\b/i;

async function searchVideos(name, timeoutMs) {
  const r = await postJson('/api/beta/search/videos', { query: name, offset: 0, limit: 20, sensitivity_id: 'normal', sort: 'views' }, timeoutMs);
  return r.ok && r.data && Array.isArray(r.data.videos) ? r.data.videos : [];
}

/** Abre os primeiros bytes: precisa ser MP4 de verdade (e não H.265). */
async function probeMp4(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-4095', 'User-Agent': BROWSER_UA }, signal: controller.signal });
    if (res.status !== 200 && res.status !== 206) return null;
    const head = Buffer.from(await res.arrayBuffer()).toString('latin1');
    if (head.indexOf('ftyp') < 0 || head.indexOf('ftyp') > 64) return null;
    if (head.includes('hvc1') || head.includes('hev1')) return null;
    return { ok: true };
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function mediaOf(video, timeoutMs) {
  const r = await postJson('/api/beta/video/media', { video_id: video.video_id }, timeoutMs);
  const url = r.ok && r.data && String(r.data.media_url || '');
  if (!url || !/^https:\/\/[a-z0-9.-]+\.bitchute\.com\/.+\.mp4(\?|$)/i.test(url)) return null;
  return (await probeMp4(url, timeoutMs)) ? url : null;
}

async function findMovieStream({ id, type = 'movie', title = '', note } = {}) {
  if (!isEnabled() || type !== 'movie') return null;
  const key = `movie:${id}`;
  const hit = pickCache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;

  const trace = { at: new Date().toISOString(), id: String(id), etapas: [], ok: false };
  const step = (msg) => { trace.etapas.push(msg); if (typeof note === 'function') { try { note(`BitChute: ${msg}`); } catch (e) { /* ignore */ } } };
  const budget = budgetMs();
  const t0 = Date.now();
  const left = () => Math.max(1500, budget - (Date.now() - t0));

  try {
    const info = await tokyo.tmdbInfo(id, 'movie');
    const names = [...new Set([...(info ? info.names : []), title].filter(Boolean))].slice(0, MAX_NAMES);
    if (!names.length) { step('sem título para procurar'); return null; }
    const runtimeSec = info ? info.runtimeSec : 0;
    const year = info ? info.year : 0;

    const lists = await Promise.all(names.map((n) => searchVideos(n, left()).catch(() => [])));
    const seen = new Set();
    const candidates = [];
    for (const list of lists) {
      for (const v of list) {
        if (!v || !v.video_id || seen.has(v.video_id)) continue;
        seen.add(v.video_id);
        const label = String(v.video_name || '');
        if (tokyo.looksLikeExtra(label) || /making of|coment[aá]rios|an[aá]lise|reaction|rea[cç][aã]o|resenha|parte \d|part \d|cap[ií]tulo/i.test(label)) continue;
        if (!archive.sameTitle(names, label)) continue;
        if (!tokyo.durationFits(parseDuration(v.duration), runtimeSec)) continue;
        const desc = String(v.description || '').replace(/<[^>]+>/g, ' ');
        const verdict = matchGuard.check(info, { label, description: desc, publishedAt: v.date_published, durationSec: parseDuration(v.duration) });
        if (!verdict.ok) { step(`descartado "${label.slice(0, 40)}": ${verdict.why}`); continue; }
        const pt = PT_HINT.test(label + ' ' + desc);
        candidates.push({ v, pt, score: (pt ? 30 : 0) + (/^ano /.test(verdict.why) ? 20 : 0) + Math.min(10, Math.log10(1 + Number(v.view_count || 0)) * 2.5) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    step(`busca: ${candidates.length} candidato(s) com título e duração do filme`);

    const top = candidates.slice(0, MAX_CANDIDATES);
    const urls = await Promise.all(top.map((c) => mediaOf(c.v, left()).catch(() => null)));
    for (let i = 0; i < top.length; i += 1) {
      if (!urls[i]) { step(`"${String(top[i].v.video_name).slice(0, 40)}": MP4 não abriu`); continue; }
      const c = top[i];
      step(`escolhido: "${String(c.v.video_name).slice(0, 50)}" · ${c.v.duration}${c.pt ? ' · pt-BR' : ''}`);
      trace.ok = true;
      const value = {
        url: urls[i],
        provider: 'BitChute',
        quality: 'auto',
        codec: 'h264',
        isHls: false,
        browserDirect: true, // CDN do BitChute entrega ao navegador; 0 byte no Render
        cors: false,
        captions: [],
        label: String(c.v.video_name || '').slice(0, 120),
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

module.exports = { findMovieStream, getReport, getStats, isEnabled, parseDuration };
