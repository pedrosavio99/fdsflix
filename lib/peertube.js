'use strict';

/**
 * Fonte "PeerTube" — filmes em instâncias PeerTube de todo o mundo, achados pelo SepiaSearch
 * (o buscador federado oficial do PeerTube).
 *
 * POR QUE FUNCIONA NO RENDER:
 *   - API pública, sem chave e sem cadastro (SepiaSearch + `/api/v1/videos/<uuid>` de cada instância);
 *   - instância PeerTube não usa Cloudflare por padrão e é feita para ser incorporada: os MP4
 *     (`/static/web-videos/...`) mandam `Access-Control-Allow-Origin: *`, aceitam `Range` e não
 *     exigem Referer nem token;
 *   - o navegador baixa direto da instância (`browserDirect`): 0 byte no Render.
 *   - o vídeo traz o IDIOMA no metadado (`language.id`): `pt` entra como dublado/português.
 *
 * COMO ESCOLHE: nomes do TMDB → busca com filtro de duração (runtime ± 12%) → título igual
 * (`sameTitle`: sequência não vale) → detalhes da instância → MP4 de 360p a 1080p que responde `Range`.
 *
 * ESCOPO: só filmes. Variáveis: PEERTUBE_ENABLED=0 desliga; PEERTUBE_SEARCH=<url> troca o buscador;
 * PEERTUBE_BUDGET_MS (padrão 9000).
 */

const tokyo = require('./tokyoVideo');
const matchGuard = require('./matchGuard');
const archive = require('./archiveOrg');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const MAX_NAMES = 3;
const MAX_CANDIDATES = 4;
const PICK_TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 4 * 60 * 1000;
const pickCache = new Map();

function isEnabled() {
  return String(process.env.PEERTUBE_ENABLED || '1') !== '0';
}

function searchBase() {
  return String(process.env.PEERTUBE_SEARCH || 'https://sepiasearch.org').replace(/\/+$/, '');
}

function budgetMs() {
  return Math.max(3000, Math.min(20000, Number(process.env.PEERTUBE_BUDGET_MS) || 9000));
}

let lastReport = null;
function getReport() {
  return lastReport;
}

async function getJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'tempo esgotado' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function searchVideos(name, runtimeSec, timeoutMs) {
  const params = new URLSearchParams();
  params.set('search', name);
  params.set('count', '15');
  params.set('sort', '-match');
  params.set('nsfw', 'false');
  if (runtimeSec) {
    params.set('durationMin', String(Math.round(runtimeSec * 0.88)));
    params.set('durationMax', String(Math.round(runtimeSec * 1.12)));
  } else {
    params.set('durationMin', String(40 * 60));
  }
  const r = await getJson(`${searchBase()}/api/v1/search/videos?${params}`, timeoutMs);
  return r.ok && r.data && Array.isArray(r.data.data) ? r.data.data : [];
}

function hostOf(video) {
  return String((video.account && video.account.host) || (video.channel && video.channel.host) || '').toLowerCase();
}

/** Melhor MP4 de 360p a 1080p (prefere 720p). */
function pickFile(files) {
  const ok = (files || [])
    .map((f) => ({ url: f.fileUrl || f.fileDownloadUrl || '', height: Number(f.resolution && f.resolution.id) || 0, size: Number(f.size) || 0 }))
    .filter((f) => /^https:/i.test(f.url) && /\.mp4(\?|$)/i.test(f.url) && f.height >= 360 && f.height <= 1080);
  if (!ok.length) return null;
  ok.sort((a, b) => Math.abs(a.height - 720) - Math.abs(b.height - 720));
  return ok[0];
}

async function reachable(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-1', 'User-Agent': BROWSER_UA }, signal: controller.signal });
    if (res.body) res.body.cancel().catch(() => {});
    return res.status === 200 || res.status === 206;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function captionList(host, data) {
  const out = [];
  for (const c of (data && data.data) || []) {
    const path = c && c.captionPath;
    const label = c && c.language && (c.language.label || c.language.id);
    if (path && label) out.push({ language: String(label), url: `https://${host}${path}` });
  }
  return out;
}

async function detailsOf(video, timeoutMs) {
  const host = hostOf(video);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || !video.uuid) return null;
  const base = `https://${host}/api/v1/videos/${encodeURIComponent(video.uuid)}`;
  const [d, caps] = await Promise.all([getJson(base, timeoutMs), getJson(`${base}/captions`, Math.min(timeoutMs, 4000))]);
  if (!d.ok || !d.data) return null;
  const file = pickFile(d.data.files);
  if (!file) return null;
  if (!(await reachable(file.url, timeoutMs))) return null;
  return {
    host,
    file,
    language: String((d.data.language && d.data.language.id) || '').toLowerCase(),
    captions: caps.ok ? captionList(host, caps.data) : []
  };
}

async function findMovieStream({ id, type = 'movie', title = '', note } = {}) {
  if (!isEnabled() || type !== 'movie') return null;
  const key = `movie:${id}`;
  const hit = pickCache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;

  const trace = { at: new Date().toISOString(), id: String(id), etapas: [], ok: false };
  const step = (msg) => { trace.etapas.push(msg); if (typeof note === 'function') { try { note(`PeerTube: ${msg}`); } catch (e) { /* ignore */ } } };
  const budget = budgetMs();
  const t0 = Date.now();
  const left = () => Math.max(1500, budget - (Date.now() - t0));

  try {
    const info = await tokyo.tmdbInfo(id, 'movie');
    const names = [...new Set([...(info ? info.names : []), title].filter(Boolean))].slice(0, MAX_NAMES);
    if (!names.length) { step('sem título para procurar'); return null; }
    const runtimeSec = info ? info.runtimeSec : 0;
    const year = info ? info.year : 0;

    const lists = await Promise.all(names.map((n) => searchVideos(n, runtimeSec, left()).catch(() => [])));
    const seen = new Set();
    const candidates = [];
    for (const list of lists) {
      for (const v of list) {
        if (!v || !v.uuid || seen.has(v.uuid)) continue;
        seen.add(v.uuid);
        const label = String(v.name || '');
        if (tokyo.looksLikeExtra(label) || /making of|coment[aá]rios|palestra|an[aá]lise|reaction|rea[cç][aã]o|review|resenha/i.test(label)) continue;
        if (!archive.sameTitle(names, label)) continue;
        if (!tokyo.durationFits(Number(v.duration) || 0, runtimeSec)) continue;
        const verdict = matchGuard.check(info, { label, description: String(v.description || ''), publishedAt: v.originallyPublishedAt || v.publishedAt, durationSec: Number(v.duration) || 0 });
        if (!verdict.ok) { step(`descartado "${label.slice(0, 40)}": ${verdict.why}`); continue; }
        const pt = String((v.language && v.language.id) || '').toLowerCase() === 'pt';
        candidates.push({ v, pt, score: (pt ? 30 : 0) + (/^ano /.test(verdict.why) ? 20 : 0) + Math.min(10, Math.log10(1 + Number(v.views || 0)) * 3) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    step(`busca: ${candidates.length} candidato(s) com título e duração do filme`);

    const top = candidates.slice(0, MAX_CANDIDATES);
    const checked = await Promise.all(top.map((c) => detailsOf(c.v, left()).catch(() => null)));
    for (let i = 0; i < top.length; i += 1) {
      const d = checked[i];
      const c = top[i];
      if (!d) { step(`"${String(c.v.name).slice(0, 40)}": sem MP4 que abra`); continue; }
      const isPt = d.language === 'pt';
      step(`escolhido: "${String(c.v.name).slice(0, 50)}" · ${d.file.height}p${isPt ? ' · pt' : ''}`);
      trace.ok = true;
      const value = {
        url: d.file.url,
        provider: 'PeerTube',
        quality: `${d.file.height}p`,
        codec: 'h264',
        isHls: false,
        browserDirect: true, // a instância entrega ao navegador; 0 byte no Render
        cors: true,
        captions: d.captions,
        label: String(c.v.name || '').slice(0, 120),
        ...(isPt ? { audioLang: 'por' } : {})
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

module.exports = { findMovieStream, getReport, isEnabled, pickFile };
