'use strict';

/**
 * Motor de torrents — aba admin "Torrents" (fase de testes; o visitante NÃO vê).
 *
 * Quando o link de vídeo falha, o admin tem um caminho alternativo: um .torrent/magnet confiável,
 * com o mesmo rigor do /api/stream (título + ano; rejeita CAM/TS/sample/trailer) e a mesma
 * preferência: PT-BR dublado primeiro, depois original.
 *
 * Fontes medidas em 2026-11-18 (de casa):
 *   apibay (TPB, JSON)         200, sem Cloudflare
 *   YTS (API JSON)             200 (yts.mx; o yts.bz redireciona)
 *   Rede Torrent (PT-BR)       200, HTML
 *   ComandoFilmes (PT-BR)      200, HTML
 *   Pirateiro (PT-BR)          200, HTML
 *   TorrentDosFilmes (PT-BR)   200, HTML
 *   1337x                      403 Cloudflare do datacenter (o motor anota e pula)
 *
 * O vídeo não passa por aqui: é só o link para o admin baixar. Nada é baixado do nosso lado.
 * Nada disto aparece para o visitante: as rotas exigem a senha e a aba é .admin-only.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12000;

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.openbittorrent.com:6969/announce'
];

// Ordem = prioridade da cascata (PT-BR primeiro, depois as genéricas).
const SOURCES = [
  { id: 'redetorrent', name: 'Rede Torrent', lang: 'pt', kind: 'html', base: 'https://redetorrent.com', path: '/?s=' },
  { id: 'comandofilmes', name: 'ComandoFilmes', lang: 'pt', kind: 'html', base: 'https://comandofilmes.xyz', path: '/?s=' },
  { id: 'pirateiro', name: 'Pirateiro', lang: 'pt', kind: 'html', base: 'http://pirateiro.com', path: '/torrents/?search=' },
  { id: 'torrentdosfilmes', name: 'TorrentDosFilmes', lang: 'pt', kind: 'html', base: 'https://torrentdosfilmes.to', path: '/?s=' },
  { id: 'apibay', name: 'The Pirate Bay', lang: 'multi', kind: 'json', base: 'https://apibay.org', path: '/q.php?q=' },
  { id: 'yts', name: 'YTS', lang: 'en', kind: 'json', base: 'https://yts.lt', path: '/api/v2/list_movies.json?query_term=' },
  { id: '1337x', name: '1337x', lang: 'multi', kind: 'html', base: 'https://1337x.to', path: '/search/' }
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'", '&nbsp;': ' ' };

function decodeEntities(s) {
  return String(s || '').replace(/&(amp|lt|gt|quot|#0?39|nbsp);/gi, (m) => ENTITIES[m.toLowerCase()] || m);
}

function strip(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function words(s) {
  return norm(s).split(' ').filter((w) => w.length >= 3);
}

function yearOf(s) {
  const m = String(s || '').match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : 0;
}

const TRACKER_QS = TRACKERS.map((t) => '&tr=' + encodeURIComponent(t)).join('');

function magnetFor(hash, name) {
  const h = String(hash || '').trim();
  if (!h) return '';
  return `magnet:?xt=urn:btih:${h}&dn=${encodeURIComponent(String(name || ''))}${TRACKER_QS}`;
}

function hashOf(value) {
  const s = String(value || '');
  const m = s.match(/urn:btih:([a-zA-Z0-9]{32,40})/i);
  if (m) return m[1].toUpperCase();
  const t = s.match(/([a-fA-F0-9]{40})(?:\.torrent|\b)/);
  return t ? t[1].toUpperCase() : '';
}

function absUrl(href, base) {
  try { return new URL(href, base).toString(); } catch (err) { return href; }
}

function guessAudio(text) {
  const t = norm(text);
  if (/\b(english dub|eng dub|english|eng)\b/.test(t)) return 'orig';
  if (/\b(dublado|dublada|dub|ptbr|pt br|nacional|portugues)\b/.test(t)) return 'dub';
  if (/\b(dual|dual audio|dual-audio)\b/.test(t)) return 'dual';
  if (/\b(legendado|legendada|leg|sub|subtitulado)\b/.test(t)) return 'leg';
  return 'orig';
}

function qualityOf(text) {
  const t = norm(text);
  if (/\b(2160p|4k|uhd)\b/.test(t)) return '2160p';
  if (/\b1080p\b/.test(t)) return '1080p';
  if (/\b720p\b/.test(t)) return '720p';
  if (/\b480p\b/.test(t)) return '480p';
  return 'auto';
}

function sizeOf(text) {
  const m = String(text || '').match(/(\d+(?:[.,]\d+)?)\s*(gb|gib|mb|mib)/i);
  if (!m) return 0;
  const n = Number(m[1].replace(',', '.'));
  return Math.round(n * (/^g/i.test(m[2]) ? 1024 ** 3 : 1024 ** 2));
}

function titleMatch(title, ctx) {
  const t = norm(title);
  const c = words(ctx.title);
  if (!t || !c.length) return false;
  const hay = ' ' + t + ' ';
  let hits = 0;
  for (const w of c) if (hay.includes(' ' + w + ' ')) hits += 1;
  // 1 palavra: precisa bater; 2+: exige pelo menos 2 (mesma ideia do matchesTitle do websearch).
  if (c.length === 1 && hits < 1) return false;
  if (c.length >= 2 && hits < 2) return false;
  const ty = yearOf(title);
  if (ctx.year && ty && Math.abs(ty - Number(ctx.year)) > 1) return false;
  return true;
}

const REJECT = /\b(cam|hdcam|ts|telesync|screener|scr|sample|trailer|teaser|dublado cam)\b/i;

function scoreOf(item, ctx) {
  if (!item || !titleMatch(item.title, ctx)) return -1;
  if (REJECT.test(item.title)) return -1;
  const t = norm(item.title);
  let s = 30;
  if (ctx.year && yearOf(item.title)) s += 20;
  if (item.audio === 'dub') s += 40;
  else if (item.audio === 'dual') s += 30;
  else if (item.audio === 'leg') s += 10;
  s += Math.min(25, Math.round(Math.log10((item.seeds || 0) + 1) * 12));
  if (item.quality === '2160p') s += 6;
  else if (item.quality === '1080p') s += 5;
  else if (item.quality === '720p') s += 3;
  if (item.size && item.size < 50 * 1024 * 1024) s -= 20;
  if (/\b(x265|hevc|10bit)\b/.test(t)) s -= 2;
  return s;
}

/* ------------------------------------------------------------------ */
/* Parsers                                                             */
/* ------------------------------------------------------------------ */

function parseApibay(body) {
  let items;
  try { items = JSON.parse(body); } catch (err) { return []; }
  if (!Array.isArray(items)) return [];
  return items
    .filter((x) => x && x.name && x.info_hash && x.info_hash !== '0000000000000000000000000000000000000000')
    .map((x) => {
      const hash = String(x.info_hash).toUpperCase();
      return {
        title: String(x.name), hash,
        seeds: Number(x.seeders) || 0, peers: Number(x.leechers) || 0,
        size: Number(x.size) || 0, added: Number(x.added) || 0,
        category: Number(x.category) || 0, imdb: x.imdb || '',
        quality: qualityOf(x.name), audio: guessAudio(x.name),
        magnet: magnetFor(hash, x.name),
        torrent: `https://itorrents.org/torrent/${hash}.torrent`,
        source: 'The Pirate Bay', lang: 'multi'
      };
    });
}

function parseYts(body) {
  let d;
  try { d = JSON.parse(body); } catch (err) { return []; }
  const movies = (d && d.data && d.data.movies) || [];
  const out = [];
  for (const m of movies) {
    const title = String(m.title_long || m.title || '');
    for (const t of (m.torrents || [])) {
      const hash = String(t.hash || '').toUpperCase();
      if (!hash) continue;
      out.push({
        title: `${title} ${t.quality || ''} ${t.type || ''}`.trim(),
        hash, seeds: Number(t.seeds) || 0, peers: Number(t.peers) || 0,
        size: Number(t.size_bytes) || 0,
        added: Date.parse(m.date_uploaded || '') || 0,
        quality: t.quality || qualityOf(title), audio: 'orig',
        magnet: magnetFor(hash, title), torrent: t.url || '',
        source: 'YTS', lang: 'en'
      });
    }
  }
  return out;
}

function parseHtml(body, src, ctx) {
  const out = [];
  const seen = new Set();
  const push = (magnet, title, torrent) => {
    const hash = hashOf(magnet || torrent || '');
    const name = strip(title) || hash || torrent;
    if (!hash && !torrent) return;
    const key = hash || torrent;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      title: name, hash: hash || '',
      seeds: 0, peers: 0, size: 0, added: 0,
      quality: qualityOf(name), audio: guessAudio(name),
      magnet: magnet || (hash ? magnetFor(hash, name) : ''),
      torrent: torrent || '',
      source: src.name, lang: src.lang || 'multi'
    });
  };

  let m;
  const magnetRe = /href=["'](magnet:\?[^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  while ((m = magnetRe.exec(body))) push(decodeEntities(m[1]), m[2], '');

  // 2) links de detalhe (.torrent ou /torrent/<id>, /download/<id>, /filme/<slug>) + o título
  const torRe = /href=["']([^"']+(?:\.torrent|\/torrent\/|\/download\/|\/filme\/|-torrent-)[^"']*)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  while ((m = torRe.exec(body))) push('', m[2], absUrl(decodeEntities(m[1]), src.base));

  // páginas PT-BR listam o link de detalhe sem texto no <a> — o próprio href vira o título
  const detailRe = /href=["']([^"']*-torrent-[^"']*)["']/gi;
  while ((m = detailRe.exec(body))) push('', '', absUrl(decodeEntities(m[1]), src.base));

  return out;
}

/**
 * As páginas PT-BR/1337x listam a PÁGINA DE DETALHE (não o magnet direto). Abre até 4 detalhes e
 * pega o magnet/.torrent de lá. Vale para o que o parseHtml achou; o que já tem magnet passa direto.
 */
async function enrichFromDetails(items, src) {
  const out = [];
  const seen = new Set();
  let fetched = 0;
  for (const item of items) {
    const key = item.torrent || item.hash || item.magnet || item.title;
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.magnet || item.hash || !item.torrent || fetched >= 4) {
      out.push(item);
      continue;
    }
    fetched += 1;
    try {
      const body = await fetchText(item.torrent);
      const found = parseHtml(body, src, {});
      const first = found.find((f) => f.magnet || f.hash);
      out.push(first ? Object.assign({}, item, { magnet: first.magnet || item.magnet, hash: first.hash || item.hash }) : item);
    } catch (err) {
      out.push(item);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Busca                                                               */
/* ------------------------------------------------------------------ */

async function fetchText(url, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      signal: ctrl.signal,
      redirect: 'follow'
    });
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function rank(items, ctx) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || !item.title) continue;
    const key = item.hash || item.magnet || item.torrent || norm(item.title);
    if (seen.has(key)) continue;
    const score = scoreOf(item, ctx);
    if (score < 0) continue;
    seen.add(key);
    out.push(Object.assign({}, item, { score }));
  }
  out.sort((a, b) => b.score - a.score || (b.seeds || 0) - (a.seeds || 0));
  return out;
}

function urlFor(src, query) {
  if (src.id === 'apibay') return src.base + src.path + encodeURIComponent(query.toLowerCase());
  if (src.id === 'yts') return src.base + src.path + encodeURIComponent(query) + '&limit=20';
  if (src.id === '1337x') return src.base + '/search/' + encodeURIComponent(query) + '/1/';
  return src.base + src.path + encodeURIComponent(query.toLowerCase());
}

async function search({ title, year, type, limit } = {}) {
  const t = String(title || '').trim();
  if (!t) return { query: '', results: [], sources: [], note: 'Informe o título.' };
  const y = String(year || '').trim();
  const ctx = { title: t, year: y, type: type || 'movie' };
  const query = t; // o ano vai no ranking (o apibay não acha quando o ano entra na query)

  const sources = [];
  const jobs = SOURCES.map(async (src) => {
    const started = Date.now();
    try {
      const body = await fetchText(urlFor(src, query));
      let items = src.id === 'apibay'
        ? parseApibay(body)
        : src.id === 'yts'
          ? parseYts(body)
          : parseHtml(body, src, ctx);
      if (src.kind === 'html') items = await enrichFromDetails(items, src);
      sources.push({ id: src.id, name: src.name, ok: true, count: items.length, ms: Date.now() - started });
      return items;
    } catch (err) {
      sources.push({ id: src.id, name: src.name, ok: false, count: 0, ms: Date.now() - started, error: err.message });
      return [];
    }
  });

  const lists = await Promise.all(jobs);
  const all = [];
  for (const list of lists) for (const item of list) all.push(item);

  const ranked = rank(all, ctx).slice(0, Math.max(1, Math.min(60, Number(limit) || 30)));
  return {
    query,
    results: ranked,
    sources,
    note: ranked.length ? '' : 'Nenhum torrent confiável para este título.'
  };
}

module.exports = {
  search,
  rank,
  parseApibay,
  parseYts,
  parseHtml,
  magnetFor,
  hashOf,
  guessAudio,
  qualityOf,
  titleMatch,
  SOURCES,
  TRACKERS
};
