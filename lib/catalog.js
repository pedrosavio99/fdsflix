'use strict';

/**
 * Catálogo colhido em casa (data/catalog.json) — a saída para sites que barram IP de datacenter.
 *
 * O problema: BitChute (API), mgeb.lat e redecanais ficam atrás do Cloudflare e desafiam o Render
 * (e o Worker). Mas o MP4 que eles apontam costuma ser ESTÁVEL e sem token (ex.: o filme dublado
 * em seedNNN.bitchute.com), e o CDN do arquivo abre de qualquer IP.
 *
 * A saída: `scripts/harvest.js` roda no PC de casa (IP que o site aceita), descobre
 * tmdbId -> MP4 estável e grava em data/catalog.json. O servidor só LÊ esse arquivo: sem relay,
 * sem túnel, sem extensão, sem o PC ligado. Link que morrer é descartado na hora (checagem de
 * `Range`, cacheada) e a fonte segue para a próxima da cascata.
 *
 * Onde fica: no **Supabase** (tabela `pix_settings`, uma linha por filme: `catalog:<tmdbId>`; "não achei"
 * em `catalogmiss:<tmdbId>`) — assim o admin colhe pelo painel, sem PC ligado nem git. O arquivo
 * data/catalog.json segue como semente/reserva (sem Supabase, é nele que se grava).
 *
 * Só entra no catálogo URL sem token/assinatura. Variáveis: CATALOG_ENABLED=0 desliga;
 * CATALOG_FILE=<caminho> troca o arquivo.
 */

const fs = require('fs');
const path = require('path');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const RELOAD_MS = 5 * 60 * 1000;
const ALIVE_TTL_MS = 30 * 60 * 1000;
const DEAD_TTL_MS = 10 * 60 * 1000;

let loaded = { at: 0, mtime: 0, data: { movies: {}, misses: {} } };
let remote = { at: 0, loading: null, movies: {}, misses: {}, ok: false, error: '' };
let dbOverride = null; // testes
const KEY_MOVIE = 'catalog:';
const KEY_MISS = 'catalogmiss:';
const quiet = { quiet: true };

function db() {
  return dbOverride || require('./usageStore');
}
function setDb(next) {
  dbOverride = next || null;
  remote = { at: 0, loading: null, movies: {}, misses: {}, ok: false, error: '' };
}
function remoteEnabled() {
  try { return Boolean(db().enabled()); } catch (err) { return false; }
}
const alive = new Map(); // url -> { ok, until }

function isEnabled() {
  return String(process.env.CATALOG_ENABLED || '1') !== '0';
}

function file() {
  return process.env.CATALOG_FILE || path.join(__dirname, '..', 'data', 'catalog.json');
}

/** Lê as linhas catalog:* do Supabase (paginado) e guarda em memória. Nunca lança. */
async function refreshRemote() {
  if (!remoteEnabled()) return;
  if (remote.loading) return remote.loading;
  remote.loading = (async () => {
    try {
      const movies = {};
      const misses = {};
      for (let offset = 0; offset < 20000; offset += 1000) {
        const rows = await db().call('GET', `/pix_settings?select=k,v&k=like.catalog*&order=k&limit=1000&offset=${offset}`, undefined, undefined, quiet);
        for (const row of rows || []) {
          if (row.k.startsWith(KEY_MISS)) misses[row.k.slice(KEY_MISS.length)] = Number(row.v && row.v.at) || 0;
          else if (row.k.startsWith(KEY_MOVIE) && row.v) movies[row.k.slice(KEY_MOVIE.length)] = row.v;
        }
        if (!rows || rows.length < 1000) break;
      }
      remote.movies = movies;
      remote.misses = misses;
      remote.ok = true;
      remote.error = '';
    } catch (err) {
      remote.ok = false;
      remote.error = err.message;
    } finally {
      remote.at = Date.now();
      remote.loading = null;
    }
  })();
  return remote.loading;
}

/** Garante dados do Supabase razoavelmente frescos (a 1ª vez espera; depois renova em segundo plano). */
async function ensureFresh() {
  if (!remoteEnabled()) return;
  if (!remote.at) { await refreshRemote(); return; }
  if (Date.now() - remote.at > RELOAD_MS) refreshRemote();
}

function loadFile() {
  const now = Date.now();
  if (now - loaded.at < RELOAD_MS && loaded.at && loaded.path === file()) return loaded.data;
  loaded.at = now;
  if (loaded.path !== file()) loaded.mtime = 0;
  loaded.path = file();
  try {
    const stat = fs.statSync(file());
    if (stat.mtimeMs !== loaded.mtime) {
      const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
      loaded.data = { movies: (data && data.movies) || {}, misses: (data && data.misses) || {} };
      loaded.mtime = stat.mtimeMs;
    }
  } catch (err) {
    // sem arquivo ou quebrado: catálogo vazio (nunca derruba o servidor)
    loaded.data = { movies: {}, misses: {} };
  }
  return loaded.data;
}

/** Arquivo + Supabase (o Supabase vale mais). */
function load() {
  const f = loadFile();
  if (!remote.ok && !Object.keys(remote.movies).length) return f;
  return { movies: { ...f.movies, ...remote.movies }, misses: { ...f.misses, ...remote.misses } };
}

function size() {
  return Object.keys(load().movies).length;
}

function readFileRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { version: 1, note: data.note, movies: data.movies || {}, misses: data.misses || {} };
  } catch (err) {
    return { version: 1, note: 'Catalogo colhido por lib/catalogHarvest.js. Links estaveis, sem token.', movies: {}, misses: {} };
  }
}
function writeFileRaw(data) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n');
  fs.renameSync(tmp, file());
  loaded.at = 0; // força releitura
}

async function upsertRow(k, v) {
  await db().call('POST', '/pix_settings?on_conflict=k', { k, v, updated_at: new Date().toISOString() },
    { Prefer: 'resolution=merge-duplicates,return=minimal' }, quiet);
}

/** Grava (ou troca) um filme. Supabase se configurado; senão o arquivo local. */
async function putMovie(id, entry) {
  id = String(id);
  const clean = { title: entry.title, year: entry.year, entries: entry.entries, harvestedAt: new Date().toISOString() };
  if (remoteEnabled()) {
    await upsertRow(KEY_MOVIE + id, clean);
    remote.movies[id] = clean;
    delete remote.misses[id];
    db().call('DELETE', `/pix_settings?k=eq.${encodeURIComponent(KEY_MISS + id)}`, undefined, undefined, quiet).catch(() => {});
    return 'supabase';
  }
  const data = readFileRaw();
  data.movies[id] = clean;
  delete data.misses[id];
  writeFileRaw(data);
  return 'arquivo';
}

/** "Procurei e não achei" (para não repetir por 7 dias). */
async function putMiss(id) {
  id = String(id);
  const at = Date.now();
  if (remoteEnabled()) {
    await upsertRow(KEY_MISS + id, { at });
    remote.misses[id] = at;
    return 'supabase';
  }
  const data = readFileRaw();
  data.misses[id] = at;
  writeFileRaw(data);
  return 'arquivo';
}

async function removeMovie(id) {
  id = String(id);
  if (remoteEnabled()) {
    await db().call('DELETE', `/pix_settings?k=in.(${encodeURIComponent(KEY_MOVIE + id)},${encodeURIComponent(KEY_MISS + id)})`, undefined, undefined, quiet);
    delete remote.movies[id];
    delete remote.misses[id];
  }
  const data = readFileRaw();
  if (data.movies[id] || data.misses[id]) {
    delete data.movies[id];
    delete data.misses[id];
    writeFileRaw(data);
  }
  return true;
}

/** Resumo para o painel do admin (nada de URL completa em massa). */
async function status({ refresh = false } = {}) {
  if (refresh) { remote.at = 0; }
  await ensureFresh();
  const all = load();
  const ids = Object.keys(all.movies);
  const recent = ids
    .map((id) => ({ id, title: all.movies[id].title, year: all.movies[id].year, dub: (all.movies[id].entries || []).some((e) => e.audioLang === 'por'), sources: (all.movies[id].entries || []).map((e) => e.source), at: all.movies[id].harvestedAt || '' }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 30);
  return {
    enabled: isEnabled(),
    storage: remoteEnabled() ? 'supabase' : 'arquivo',
    supabaseOk: remoteEnabled() ? remote.ok : null,
    supabaseError: remote.error || '',
    movies: ids.length,
    dubbed: ids.filter((id) => (all.movies[id].entries || []).some((e) => e.audioLang === 'por')).length,
    misses: Object.keys(all.misses).length,
    recent
  };
}

async function reachable(url, timeoutMs = 5000) {
  const hit = alive.get(url);
  if (hit && hit.until > Date.now()) return hit.ok;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let ok = false;
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-1', 'User-Agent': BROWSER_UA }, signal: controller.signal });
    if (res.body) res.body.cancel().catch(() => {});
    ok = res.status === 200 || res.status === 206;
  } catch (err) {
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  alive.set(url, { ok, until: Date.now() + (ok ? ALIVE_TTL_MS : DEAD_TTL_MS) });
  return ok;
}

/** Endereço estável? (nada de token/assinatura/expiração na URL) */
function isStableUrl(url) {
  try {
    const u = new URL(url);
    const local = u.hostname === 'localhost' || /^127\./.test(u.hostname); // só para desenvolvimento/teste
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return false;
    return !/(^|[?&])(token|sig|signature|expires?|e|st|hdnts|x-amz-[a-z-]+)=/i.test(u.search);
  } catch (err) {
    return false;
  }
}

/** Provedor da cascata: (id, type) -> { url, ... } | null */
async function findStream({ id, type = 'movie' } = {}) {
  if (!isEnabled() || type !== 'movie') return null;
  await ensureFresh();
  const entry = load().movies[String(id)];
  if (!entry || !Array.isArray(entry.entries) || !entry.entries.length) return null;
  // Português primeiro; depois a ordem da colheita.
  const ordered = entry.entries.slice().sort((a, b) => (b.audioLang === 'por') - (a.audioLang === 'por'));
  for (const e of ordered) {
    if (!e || !isStableUrl(e.url)) continue;
    if (!(await reachable(e.url))) continue;
    return {
      url: e.url,
      provider: 'Catálogo',
      quality: e.quality || 'auto',
      codec: 'h264',
      isHls: false,
      browserDirect: true,
      cors: e.cors === true,
      captions: [],
      ...(e.audioLang ? { audioLang: e.audioLang } : {})
    };
  }
  return null;
}

module.exports = { findStream, isEnabled, size, isStableUrl, load, reachable, file, putMovie, putMiss, removeMovie, status, refreshRemote, setDb };
