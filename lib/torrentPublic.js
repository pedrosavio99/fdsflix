'use strict';

/**
 * fdsFlix - Torrent como ÚLTIMO recurso para o público.
 *
 * Só entra quando a cascata de fontes inteira falhou (o front decide). Este módulo:
 *  - acha candidatos para um filme do TMDB (lib/torrentSearch.js) e escolhe quais valem a pena,
 *  - lembra quão rápido cada torrent foi de verdade ("mais seeds" nem sempre é o mais rápido),
 *  - protege os nós: liga/desliga por env, sem nó com banda sobrando = desligado, limite por IP.
 *
 * O público NUNCA vê nome de fonte/tracker/título de release: a resposta só leva hash, magnet, qualidade e
 * se parece dublado. O vídeo sai direto do nó (não passa pelo Render).
 *
 * Variáveis (todas opcionais):
 *   TORRENT_PUBLIC=0           desliga para o público (admin continua tendo o painel)
 *   TORRENT_PUBLIC_MAX_GB      maior arquivo aceito (padrão 3,5): nó tem banda de saída limitada
 *   TORRENT_PUBLIC_PER_IP      buscas por IP a cada 10 min (padrão 8)
 */

const torrentSearch = require('./torrentSearch');

const MAX_GB = Math.max(0.5, Number(process.env.TORRENT_PUBLIC_MAX_GB) || 3.5);
const PER_IP = Math.max(1, Number(process.env.TORRENT_PUBLIC_PER_IP) || 8);
const IP_WINDOW_MS = 10 * 60 * 1000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const LEARN_TTL_MS = 24 * 3600 * 1000;
const ISSUED_TTL_MS = 6 * 3600 * 1000;
const MAX_ENTRIES = 600;

const cache = new Map();     // tmdb id -> { at, ttl, value } | { promise }
const learned = new Map();   // hash -> { kBs, n, fails, at }
const issued = new Map();    // hash -> at (só aceitamos relatório de hash que nós mesmos entregamos)
const hits = new Map();      // ip -> [timestamps]

let searchImpl = (args) => torrentSearch.search(args);

function enabled() { return process.env.TORRENT_PUBLIC !== '0'; }

function prune(map, ttl, now) {
  if (map.size <= MAX_ENTRIES) return;
  for (const [k, v] of map) {
    const at = typeof v === 'number' ? v : v.at;
    if (now - at > ttl) map.delete(k);
  }
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
}

/** true = pode buscar; false = estourou o limite deste IP. */
function allowIp(ip, now = Date.now()) {
  const key = String(ip || 'x');
  const list = (hits.get(key) || []).filter((t) => now - t < IP_WINDOW_MS);
  if (list.length >= PER_IP) { hits.set(key, list); return false; }
  list.push(now);
  hits.set(key, list);
  if (hits.size > MAX_ENTRIES) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < IP_WINDOW_MS)) hits.delete(k);
  }
  return true;
}

/* ------------------------------ aprendizado de velocidade ------------------------------ */

/** Relato do navegador: o torrent chegou a tocar (kBs medido) ou falhou (ok=false). */
function learn(hash, { kBs, ok } = {}, now = Date.now()) {
  const h = String(hash || '').toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(h)) return false;
  const at = issued.get(h);
  if (!at || now - at > ISSUED_TTL_MS) return false;       // só vale para hash que entregamos
  const cur = learned.get(h) || { kBs: 0, n: 0, fails: 0, at: now };
  if (ok === false) cur.fails += 1;
  else {
    const v = Math.max(0, Math.min(50000, Number(kBs) || 0)); // 50 MB/s é o teto crível
    if (v > 0) { cur.kBs = cur.n ? (cur.kBs * cur.n + v) / (cur.n + 1) : v; cur.n += 1; cur.fails = Math.max(0, cur.fails - 1); }
  }
  cur.at = now;
  learned.set(h, cur);
  prune(learned, LEARN_TTL_MS, now);
  return true;
}

function learnedOf(hash, now = Date.now()) {
  const l = learned.get(String(hash || '').toUpperCase());
  return l && now - l.at < LEARN_TTL_MS ? l : null;
}

/* ------------------------------ escolha dos candidatos ------------------------------ */

function isMp4Like(item) {
  // YTS entrega mp4 (o nó toca na hora e deixa avançar); mkv/avi o nó converte com ffmpeg e não deixa avançar.
  const t = String(item.title || '') + ' ' + String(item.source || '');
  return /yts|yify|\.mp4|\bmp4\b/i.test(t);
}

/**
 * Nota para o PÚBLICO. Parte da nota da busca (título/ano/dublado/qualidade) e ajusta pelo que importa para tocar:
 * velocidade medida antes (vale mais que seeds), arquivo mp4, tamanho, e "sem seed" quase nunca toca.
 */
function publicScore(item, now = Date.now()) {
  let s = Number(item.score) || 0;
  const seeds = Number(item.seeds) || 0;
  if (seeds <= 0) s -= 60;
  else if (seeds < 3) s -= 15;
  if (isMp4Like(item)) s += 12;
  if (item.quality === '2160p') s -= 25;                 // pesado demais para a banda dos nós
  const l = learnedOf(item.hash, now);
  if (l) {
    if (l.kBs) s += Math.min(35, l.kBs / 40);            // 1 MB/s ≈ +25
    s -= Math.min(60, l.fails * 30);
  }
  return s;
}

function pickCandidates(results, { limit = 4, now = Date.now() } = {}) {
  const maxBytes = MAX_GB * 1024 ** 3;
  const seen = new Set();
  const list = [];
  for (const r of results || []) {
    const hash = String(r.hash || '').toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(hash) || !r.magnet || seen.has(hash)) continue;
    if (r.size && r.size > maxBytes) continue;
    seen.add(hash);
    list.push({ r, hash, s: publicScore(r, now) });
  }
  list.sort((a, b) => b.s - a.s);
  // Sem nenhum candidato com seed, não vale tentar (o player ficaria esperando peers que não existem).
  const usable = list.filter((x) => (Number(x.r.seeds) || 0) > 0 || learnedOf(x.hash, now));
  return usable.slice(0, limit).map((x) => ({
    hash: x.hash,
    magnet: x.r.magnet,
    q: x.r.quality || '',
    dub: x.r.audio === 'dub' || x.r.audio === 'dual',
    size: Number(x.r.size) || 0,
    seeds: Number(x.r.seeds) || 0
  }));
}

/**
 * names = { title, alt, year } do TMDB. Resultado em cache (30 min; 5 min se vazio) e pedidos iguais em voo
 * viram um só.
 */
async function find(tmdbId, names, now = Date.now()) {
  const key = String(tmdbId);
  const hit = cache.get(key);
  if (hit) {
    if (hit.promise) return hit.promise;
    if (now - hit.at < hit.ttl) return hit.value;
  }
  const promise = (async () => {
    let out;
    try {
      const runs = [{ title: names.title, alt: names.alt }];
      const norm = (x) => String(x || '').trim().toLowerCase();
      if (names.alt2 && ![names.title, names.alt].map(norm).includes(norm(names.alt2))) runs.push({ title: names.alt2, alt: '' });
      const settled = await Promise.allSettled(runs.map((q) => searchImpl({ ...q, year: names.year, type: 'movie', limit: 40 })));
      const results = [];
      let firstErr = '';
      for (const st of settled) {
        if (st.status === 'fulfilled') results.push(...((st.value && st.value.results) || []));
        else firstErr = firstErr || (st.reason && st.reason.message) || 'erro';
      }
      out = { candidates: pickCandidates(results, { now: Date.now() }) };
      if (!out.candidates.length && firstErr) out.error = firstErr;
    } catch (err) {
      out = { candidates: [], error: err.message };
    }
    const at = Date.now();
    cache.set(key, { at, ttl: out.candidates.length ? CACHE_TTL_MS : EMPTY_TTL_MS, value: out });
    prune(cache, CACHE_TTL_MS, at);
    return out;
  })();
  cache.set(key, { promise, at: now });
  const out = await promise;
  // O ranking depende do que aprendemos: devolve sempre reordenado com o que sabemos AGORA.
  return out;
}

/** Marca os hashes entregues (para aceitar o relatório depois) e reordena com o aprendizado mais recente. */
function issue(candidates, now = Date.now()) {
  for (const c of candidates) issued.set(c.hash, now);
  prune(issued, ISSUED_TTL_MS, now);
  return candidates.slice().sort((a, b) => {
    const sa = (learnedOf(a.hash, now) ? 1 : 0) * (learnedOf(a.hash, now) || {}).kBs;
    const sb = (learnedOf(b.hash, now) ? 1 : 0) * (learnedOf(b.hash, now) || {}).kBs;
    // só reordena quando há velocidade medida de algum deles; senão mantém a nota
    return (sb || sa) ? (sb - sa) : 0;
  });
}

module.exports = {
  enabled, allowIp, learn, learnedOf, pickCandidates, publicScore, find, issue,
  _reset() { cache.clear(); learned.clear(); issued.clear(); hits.clear(); },
  _setSearch(fn) { searchImpl = fn || ((args) => torrentSearch.search(args)); },
  MAX_GB, PER_IP
};
