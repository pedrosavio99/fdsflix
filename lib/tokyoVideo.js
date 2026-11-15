'use strict';

/**
 * Fonte TokyVideo (tokyvideo.com) — FILMES enviados por usuários: cinema clássico,
 * documentários, cult e conteúdo latino. É a plataforma "YouTube de vídeos": alguns
 * canais sobem o filme inteiro, o acervo tem títulos que as outras fontes não têm.
 *
 * POR QUE ELA NÃO GASTA O RENDER (o ponto que viabiliza a fonte):
 *   - a API do site devolve o MP4 já assinado (`videoFileUrl`, no CDN77);
 *   - o CDN aceita QUALQUER origem, sem Referer e sem User-Agent especial;
 *   - a assinatura vale ~24 h e NÃO é presa ao IP de quem pediu (conferido: token
 *     emitido para outro IP abriu normalmente aqui);
 *   - logo o navegador baixa o vídeo direto do CDN: 0 byte e 0 requisição no Render
 *     e no Worker. O servidor só devolve um JSON pequeno (igual ao modo "direct").
 *
 * A BUSCA É EM TRÊS PASSOS, porque a busca do site é frouxa (devolve clipe, música e
 * trailer para quase tudo) e o título sozinho não basta:
 *   1. nomes do TMDB — pt-BR, original, inglês e alternativos (o acervo é multilíngue);
 *   2. busca no site (JSON) e REORDENAÇÃO local por semelhança de título;
 *   3. CONFIRMAÇÃO PELA DURAÇÃO contra o runtime do TMDB — é o que separa "filme
 *      inteiro" de trailer/clipe com o mesmo nome (o clipe de 1 min cai fora).
 *
 * ESCOPO: só FILMES (`type === 'movie'`). Em séries a fonte devolve null na hora,
 * sem gastar requisição: as "series" do site não têm temporada/episódio confiáveis.
 *
 * Variáveis:
 *   TOKYOVIDEO_ENABLED=0      desliga a fonte (padrão: ligada, no fim da cascata)
 *   TOKYOVIDEO_API_BASE=...   troca o endereço da API (se o site mudar)
 *   TOKYOVIDEO_SITE=...       troca o endereço do site
 *   TOKYOVIDEO_BUDGET_MS=...  teto de tempo por título (padrão 9000 ms)
 *
 * O identificador do vídeo sai da própria miniatura (`/videos/<milhar>/<id>/thumbs/...`),
 * então a busca do site custa UMA requisição; a duração e o link assinado custam outra
 * por candidato (no máximo 4 candidatos, em paralelo).
 */

const { relayFetch } = require('./relayFetch');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const MAX_QUERIES = 3;
const MAX_CANDIDATES = 4;
const MAX_META = 4;
const MIN_SCORE = 62;
const MIN_MOVIE_SEC = 40 * 60; // sem runtime no TMDB, só aceita o que claramente é filme

// Cache em memória (some quando o servidor reinicia).
const cache = new Map();
const CACHE_MAX = 400;
const pickCache = new Map(); // "movie:<id>" -> { value, at, until }
const PICK_HIT_TTL_MS = 10 * 60 * 1000;
const PICK_MISS_TTL_MS = 4 * 60 * 1000;

function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  return loader().then((value) => {
    if (value != null) {
      cache.set(key, { value, expires: Date.now() + ttlMs });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return value;
  });
}

function config() {
  const strip = (v) => String(v || '').replace(/\/+$/, '');
  return {
    enabled: String(process.env.TOKYOVIDEO_ENABLED || '1') !== '0',
    api: strip(process.env.TOKYOVIDEO_API_BASE) || 'https://api.tokyvideo.com',
    site: strip(process.env.TOKYOVIDEO_SITE) || 'https://www.tokyvideo.com',
    tmdbBase: strip(process.env.TMDB_API_BASE) || 'https://api.themoviedb.org/3',
    budgetMs: Math.max(3000, Math.min(20000, Number(process.env.TOKYOVIDEO_BUDGET_MS) || 9000)),
    // Canais cujo acervo é indexado (a busca do site é inútil para achar filme: ela devolve
    // clipe/música). Lista separada por vírgula; o índice fica 6 h na memória.
    channels: String(process.env.TOKYOVIDEO_CHANNELS || 'matrizoculta,cinetel')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => /^[a-z0-9_-]{2,40}$/.test(name))
  };
}

function isEnabled() {
  return config().enabled;
}

/* ------------------------------------------------------------------ */
/* Nomes, anos e duração                                               */
/* ------------------------------------------------------------------ */

// Palavras que o site põe no título e que não mudam QUEM é o filme.
const NOISE = /\b(full movie|filme completo|completo|completa|filme|movie|dublado|legendado|dub|sub|subtitulado|online|hd|full hd|1080p|720p|4k)\b/g;

function normTitle(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\((?:19|20)\d{2}\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function yearOf(text) {
  const m = String(text || '').match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : 0;
}

/** 0..100. A busca do site erra muito, então aqui só o título parecido passa. */
function titleScore(wanted, found) {
  const w = normTitle(wanted);
  const f = normTitle(found);
  if (!w || !f) return 0;
  if (w === f) return 100;
  if (f.startsWith(w + ' ') || w.startsWith(f + ' ')) return 84;
  if (f.includes(w) || w.includes(f)) return 66;
  const wTokens = w.split(' ');
  const fTokens = new Set(f.split(' '));
  // Todas as palavras do título pedido aparecem no achado ("O Poderoso Chefão" -> "...Chefao...").
  if (wTokens.length >= 2 && wTokens.every((t) => fTokens.has(t))) return 58;
  return 0;
}

/** "01:34:04" = 1h34m · "02:04" = 2m04s (o site usa os dois formatos). */
function parseDuration(text) {
  const parts = String(text || '').trim().split(':').map((p) => Number(p));
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

/** A duração do arquivo bate com o filme do TMDB? (trailer de 2 min nunca bate) */
function durationFits(seconds, runtimeSec) {
  if (!seconds) return false;
  if (!runtimeSec) return seconds >= MIN_MOVIE_SEC;
  const tolerance = Math.max(480, runtimeSec * 0.12); // ~8-12 min de folga
  return Math.abs(seconds - runtimeSec) <= tolerance;
}

/** Título que claramente é material extra, não o filme. */
function looksLikeExtra(text) {
  return /\b(trailer|trailers|teaser|clip|extracto|escena|scene|interview|entrevista|review|critica|making of|behind the scenes|detras de camaras|resumen|recap|analisis)\b/i.test(String(text || ''));
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function fetchJson(cfg, url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  // `relay: false` = busco direto (bem mais rápido para o catálogo dos canais, que é público).
  const doFetch = options.relay === false ? fetch : relayFetch;
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json',
        'Accept-Language': 'pt-BR,pt;q=0.9,es;q=0.8,en;q=0.7',
        Origin: cfg.site,
        Referer: cfg.site + '/'
      }
    });
    if (!res || !res.ok) return { ok: false, status: res ? res.status : 0 };
    const text = await res.text();
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) };
    } catch (err) {
      return { ok: false, status: res.status, notJson: true };
    }
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'tempo esgotado' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(cfg, url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  const doFetch = options.relay === false ? fetch : relayFetch;
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9,es;q=0.8,en;q=0.7'
      }
    });
    if (!res || !res.ok) return null;
    return await res.text();
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 1 byte do MP4 pelo caminho nativo (NÃO usa relay: o CDN é público e não gasta cota). */
async function reachable(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal
    });
    if (res.body) res.body.cancel().catch(() => {});
    return res.status === 200 || res.status === 206 ? res.status : 0;
  } catch (err) {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * O arquivo é H.264? Basta ler o cabeçalho (`ftyp`) — 2 KB e ~0,1 s.
 *
 * NÃO use ffprobe aqui: nestes MP4 (moov no fim do arquivo) ele levava ~6 s e lia dezenas
 * de MB do filme no Render. O `ftyp` deste acervo anuncia as marcas `isom iso2 avc1 mp41`
 * (o muxer só escreve `avc1` para H.264); HEVC aparece como `hvc1`/`hev1`.
 */
const codecCache = new Map();
function sniffCodec(url, timeoutMs) {
  let key = '';
  try {
    const u = new URL(url);
    key = u.origin + u.pathname;
  } catch (err) {
    return Promise.resolve(null);
  }
  const hit = codecCache.get(key);
  if (hit) return Promise.resolve(hit);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  return fetch(url, { headers: { Range: 'bytes=0-2047' }, signal: controller.signal })
    .then(async (res) => {
      if (res.status !== 200 && res.status !== 206) return null;
      const body = Buffer.from(await res.arrayBuffer());
      const head = body.toString('latin1');
      let codec = null;
      if (head.includes('ftyp')) {
        if (head.includes('hvc1') || head.includes('hev1')) codec = 'hevc';
        else if (head.includes('avc1') || head.includes('avc3')) codec = 'h264';
      }
      if (codec) codecCache.set(key, codec);
      return codec;
    })
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------------ */
/* TMDB: nomes (vários idiomas) e duração do filme                     */
/* ------------------------------------------------------------------ */

async function tmdbJson(cfg, path) {
  const key = String(process.env.TMDB_API_KEY || '').trim();
  if (!key) return null;
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetchJson(cfg, `${cfg.tmdbBase}${path}${sep}api_key=${encodeURIComponent(key)}`, 7000);
  return r.ok ? r.data : null;
}

function loadTmdbInfo(cfg, id, type) {
  return cached(`tmdb:${type}:${id}`, 6 * 60 * 60 * 1000, async () => {
    const [pt, alt] = await Promise.all([
      tmdbJson(cfg, `/movie/${encodeURIComponent(id)}?language=pt-BR`),
      tmdbJson(cfg, `/movie/${encodeURIComponent(id)}/alternative_titles`)
    ]);
    if (!pt) return null;

    const names = [];
    const add = (name) => {
      const value = String(name || '').trim();
      if (value.length >= 2 && !names.includes(value)) names.push(value);
    };
    add(pt.title);
    add(pt.original_title);
    // Alternativos: o acervo do site é forte em espanhol, então ES/PT/BR vêm primeiro
    // na fila de buscas (o inglês fica por último, mas ainda entra).
    const ALT_PREF = ['ES', 'MX', 'AR', 'CO', 'CL', 'BR', 'PT', 'US', 'GB'];
    const altTitles = ((alt && alt.titles) || []).slice().sort((a, b) => {
      const rank = (item) => {
        const index = ALT_PREF.indexOf(String((item && item.iso_3166_1) || '').toUpperCase());
        return index === -1 ? ALT_PREF.length : index;
      };
      return rank(a) - rank(b);
    });
    for (const item of altTitles) add(item && item.title);
    // Nomes em inglês ajudam quando o upload internacional usa o título original.
    if (names.length < 6) {
      const en = await tmdbJson(cfg, `/movie/${encodeURIComponent(id)}?language=en-US`);
      add(en && en.title);
    }

    return {
      names,
      runtimeSec: Number(pt.runtime || 0) * 60,
      year: yearOf(pt.release_date)
    };
  });
}

/* ------------------------------------------------------------------ */
/* TokyVideo: busca, metadados e escolha                               */
/* ------------------------------------------------------------------ */

function videoIdFromThumb(thumb) {
  const m = /\/videos\/\d+\/(\d+)\//.exec(String(thumb || ''));
  return m ? m[1] : null;
}

async function searchSite(cfg, query, timeoutMs) {
  const url = `${cfg.api}/search-ajax?q=${encodeURIComponent(query)}`;
  const r = await fetchJson(cfg, url, timeoutMs);
  if (!r.ok || !r.data) return { list: [], status: r.status, error: r.error, notJson: r.notJson };
  const list = [];
  const seen = new Set();
  for (const group of r.data.results || []) {
    for (const item of (group && group.children) || []) {
      if (!item || item.type !== 'video') continue;
      const id = videoIdFromThumb(item.thumb);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      list.push({ id, title: String(item.title || '') });
    }
  }
  return { list, status: r.status };
}

async function videoMeta(cfg, id, timeoutMs) {
  const r = await fetchJson(cfg, `${cfg.api}/video/${encodeURIComponent(id)}`, timeoutMs);
  const v = r.ok && r.data && r.data.video;
  if (!v) return null;
  const relative = String(v.url || '');
  return {
    id: String(v.id || id),
    title: String(v.title || ''),
    durationSec: parseDuration(v.duration),
    duration: String(v.duration || ''),
    banned: Boolean(v.banned),
    private: Boolean(v.private),
    live: Boolean(v.liveStream),
    url: String(v.videoFileUrl || ''),
    channel: String(v.channelName || ''),
    thumb: /^https:\/\//i.test(String(v.thumb || '')) ? String(v.thumb) : '',
    page: relative.startsWith('/') ? cfg.site + relative : ''
  };
}

function describeFailure(r) {
  if (r.error) return String(r.error).replace(/https?:\/\/\S+/g, '[url]').slice(0, 80);
  if (r.notJson) return `HTTP ${r.status} mas não é JSON (a API pode ter mudado)`;
  return `HTTP ${r.status || '?'}`;
}

// Relatório da última tentativa (sem URLs) — é o que o painel do admin mostra.
let lastReport = null;
function getReport() {
  return lastReport;
}

/* ------------------------------------------------------------------ */
/* Índice dos canais: é onde o acervo (filmes) de verdade está         */
/*                                                                     */
/* A busca do site é inútil para achar filme: "um sonho de liberdade"  */
/* devolve 69 resultados de série/música e NÃO o filme — que está no    */
/* canal matrizoculta com o título certinho e 2h22. O caminho que       */
/* funciona é o catálogo do canal: /user/<nome> dá o id e              */
/* /channel/<id>/videos?offset=N devolve 24 por página, com título e    */
/* duração. Indexamos isso (6 h de cache) e casamos localmente.        */
/* ------------------------------------------------------------------ */

const INDEX_TTL_MS = 6 * 60 * 60 * 1000;
const CHANNEL_PAGE = 24;
const CHANNEL_MAX_VIDEOS = 480;   // teto por canal (20 páginas)
const CHANNEL_BATCH = 4;          // páginas buscadas em paralelo

let indexValue = null;
let indexBuiltAt = 0;
let indexTtl = INDEX_TTL_MS;
let indexPromise = null;

function channelIdOf(cfg, slug, relay = true) {
  return fetchText(cfg, `${cfg.site}/user/${encodeURIComponent(slug)}`, 9000, { relay }).then((html) => {
    const m = html && /channel\/edit\/(\d+)/.exec(html);
    return m ? m[1] : null;
  }).catch(() => null);
}

function toCatalogItem(video, cfg) {
  const id = String((video && video.id) || '');
  if (!/^\d{1,12}$/.test(id)) return null;
  const seconds = parseDuration(video.duration);
  const relative = String(video.url || '');
  return {
    id,
    title: String(video.title || ''),
    durationSec: seconds,
    duration: String(video.duration || ''),
    minutes: seconds ? Math.round(seconds / 60) : 0,
    channel: String(video.channelName || ''),
    thumb: /^https:\/\//i.test(String(video.thumb || '')) ? String(video.thumb) : '',
    page: relative.startsWith('/') ? cfg.site + relative : ''
  };
}

async function channelCatalog(cfg, channelId, deadline, relay = true) {
  const out = [];
  const seen = new Set();
  const take = (list) => {
    for (const video of list) {
      const item = toCatalogItem(video, cfg);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  };

  for (let offset = 0; offset < CHANNEL_MAX_VIDEOS && Date.now() < deadline; offset += CHANNEL_BATCH * CHANNEL_PAGE) {
    const offsets = [];
    for (let i = 0; i < CHANNEL_BATCH; i += 1) {
      const next = offset + i * CHANNEL_PAGE;
      if (next < CHANNEL_MAX_VIDEOS) offsets.push(next);
    }
    const pages = await Promise.all(offsets.map((start) =>
      fetchJson(cfg, `${cfg.api}/channel/${channelId}/videos?offset=${start}`, 8000, { relay })));
    let finished = false;
    pages.forEach((res) => {
      const list = res.ok && res.data && Array.isArray(res.data.videos) ? res.data.videos : [];
      take(list);
      if (list.length < CHANNEL_PAGE) finished = true;
    });
    if (finished) break;
  }
  return out;
}

async function channelBySlug(cfg, slug, deadline, relay) {
  const channelId = await channelIdOf(cfg, slug, relay);
  if (!channelId) return [];
  return channelCatalog(cfg, channelId, deadline, relay);
}

async function buildIndex(cfg, deadline) {
  const channels = cfg.channels || [];
  const lists = await Promise.all(channels.map(async (slug) => {
    // Direto é ~3x mais rápido; o relay fica de reserva para o dia em que o site bloquear IP de nuvem.
    let list = await channelBySlug(cfg, slug, deadline, false);
    if (!list.length && Date.now() < deadline) list = await channelBySlug(cfg, slug, deadline, true);
    return { slug, list };
  }));
  const seen = new Set();
  const all = [];
  const missing = [];
  for (const entry of lists) {
    if (!entry.list.length) missing.push(entry.slug);
    for (const item of entry.list) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      all.push(item);
    }
  }
  return { list: all, missing };
}

/**
 * Índice dos canais em memória (6 h). Com `wait: false` devolve o que já existe e continua
 * montando em segundo plano — é o que a cascata usa, para não gastar o tempo do play.
 */
function loadIndex(cfg, { wait = true, budgetMs = 25000 } = {}) {
  const fresh = indexValue && Date.now() - indexBuiltAt < indexTtl;
  if (fresh) return Promise.resolve(indexValue);
  if (indexPromise) return wait ? indexPromise : Promise.resolve(indexValue || []);

  const deadline = Date.now() + Math.max(3000, budgetMs);
  indexPromise = buildIndex(cfg, deadline)
    .then((build) => {
      const list = build.list;
      if (list.length) {
        indexValue = list;
        indexBuiltAt = Date.now();
        // Canal que não respondeu: tenta de novo em 10 min (não deixa o índice capenga por 6 h).
        indexTtl = build.missing.length ? 10 * 60 * 1000 : INDEX_TTL_MS;
      }
      console.log(`[tokyvideo] acervo indexado: ${list.length} vídeo(s)` +
        (build.missing.length ? ` · sem resposta: ${build.missing.join(', ')}` : '') +
        ` · canais: ${(cfg.channels || []).join(', ') || 'nenhum'}`);
      return list;
    })
    .catch((err) => {
      console.warn('[tokyvideo] índice falhou:', err.message);
      return indexValue || [];
    })
    .finally(() => { indexPromise = null; });

  return wait ? indexPromise : Promise.resolve(indexValue || []);
}

/** Aquece o índice sem bloquear ninguém (o servidor chama no boot). */
function prewarm() {
  try { loadIndex(config(), { wait: false }); } catch (err) { /* melhor esforço */ }
}

function indexStatus() {
  return {
    videos: indexValue ? indexValue.length : 0,
    builtAt: indexBuiltAt ? new Date(indexBuiltAt).toISOString() : null,
    building: Boolean(indexPromise)
  };
}

/** Casa o título (e a duração) contra o acervo indexado. */
function searchCatalog(list, names, runtimeSec, year) {
  const wanted = (names || []).filter(Boolean);
  const out = [];
  for (const item of list) {
    let score = 0;
    for (const name of wanted) score = Math.max(score, titleScore(name, item.title));
    if (score < MIN_SCORE) continue;
    if (runtimeSec) {
      if (!durationFits(item.durationSec, runtimeSec)) continue;
      const foundYear = yearOf(item.title);
      if (year && foundYear) score += foundYear === year ? 6 : -12;
    } else if (item.durationSec < MIN_MOVIE_SEC) {
      continue;
    }
    out.push({ ...item, score });
  }
  return out.sort((a, b) => b.score - a.score || b.durationSec - a.durationSec);
}

/* ------------------------------------------------------------------ */
/* Busca manual (painel do admin) e abertura de um vídeo específico     */
/* ------------------------------------------------------------------ */

const searchCache = new Map(); // "q" -> { value, until }
const playCache = new Map();   // id  -> { value, until }
const SEARCH_TTL_MS = 5 * 60 * 1000;
const PLAY_TTL_MS = 5 * 60 * 1000;

/**
 * Busca livre no acervo, para o painel do administrador: título, duração, canal,
 * miniatura e o link da página. Não toca nada — é só a listagem.
 */
async function searchVideos(query, options = {}) {
  const cfg = config();
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return { query: '', results: [], error: 'Informe um título.' };
  if (!cfg.enabled) return { query: q, results: [], error: 'A fonte está desligada (TOKYOVIDEO_ENABLED=0).' };

  // Aberto de dentro de um filme, o painel manda o id do TMDB: aí a busca usa os nomes em
  // vários idiomas (pt-BR incluso) e a duração do filme para marcar o que realmente confere.
  const tmdbId = /^\d{1,12}$/.test(String(options.id || '')) ? String(options.id) : '';
  const useTmdb = Boolean(tmdbId) && options.type !== 'tv';

  const limit = Math.max(1, Math.min(20, Number(options.limit) || 12));
  const cacheKey = (useTmdb ? tmdbId + ':' : '') + q.toLowerCase();
  const cachedHit = searchCache.get(cacheKey);
  if (cachedHit && cachedHit.until > Date.now()) return cachedHit.value;

  let names = [q];
  let runtimeSec = 0;
  let year = 0;
  if (useTmdb) {
    const info = await loadTmdbInfo(cfg, tmdbId, 'movie');
    if (info) {
      names = [...new Set([q, ...info.names])].slice(0, 6);
      runtimeSec = info.runtimeSec || 0;
      year = info.year || 0;
    }
  }

  // Até 3 consultas, em paralelo (cada uma leva ~1,2 s no site deles).
  const queries = [...new Set(names.map((name) => normTitle(name)).filter((name) => name.length >= 3))].slice(0, MAX_QUERIES);
  const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 8000);
  const [catalog, searches] = await Promise.all([
    loadIndex(cfg, { wait: true, budgetMs: 15000 }),
    Promise.all(queries.map((name) => searchSite(cfg, name, timeoutMs)))
  ]);
  // O acervo indexado resolve o que a busca do site não acha (ex.: "Um Sonho de Liberdade").
  const indexed = catalog.length ? searchCatalog(catalog, names, runtimeSec, year) : [];
  if (!searches.some((res) => res.status) && !indexed.length) {
    return { query: q, total: 0, results: [], error: describeFailure(searches[0]) };
  }

  const found = new Map();
  let total = 0;
  for (const res of searches) {
    if (!res.status) continue;
    total = Math.max(total, res.list.length);
    for (const item of res.list) {
      const score = Math.max(...names.map((name) => titleScore(name, item.title)));
      const previous = found.get(item.id);
      if (!previous || previous.score < score) found.set(item.id, { ...item, score });
    }
  }

  // A ordem da busca deles não serve (devolve clipe/música antes do filme). Reordena pelo
  // título antes de buscar os metadados, senão o filme nem entra na lista.
  const ranked = [...found.values()].sort((a, b) => b.score - a.score).slice(0, limit);

  const metas = await Promise.all(ranked.map((item) => videoMeta(cfg, item.id, 8000)));
  const results = ranked.map((item, index) => {
    const meta = metas[index];
    const seconds = meta ? meta.durationSec : 0;
    return {
      id: item.id,
      title: (meta && meta.title) || item.title,
      duration: meta ? meta.duration : '',
      minutes: seconds ? Math.round(seconds / 60) : 0,
      channel: meta ? meta.channel : '',
      thumb: meta ? meta.thumb : '',
      page: meta ? meta.page : '',
      // 40 min+ separa filme de clipe/trailer (mesmo corte da busca automática).
      full: seconds >= MIN_MOVIE_SEC,
      playable: Boolean(meta && meta.url && !meta.banned && !meta.private && !meta.live),
      // null quando o TMDB não deu a duração: aí não dá para afirmar nada.
      matchesRuntime: runtimeSec ? durationFits(seconds, runtimeSec) : null,
      score: item.score
    };
  });

  // O que confere com o filme aberto primeiro; depois filme inteiro; depois o mais parecido.
  results.sort((a, b) =>
    (Number(b.matchesRuntime) - Number(a.matchesRuntime)) ||
    (Number(b.full) - Number(a.full)) ||
    (b.score - a.score) ||
    (b.minutes - a.minutes));
  results.forEach((item) => { delete item.score; });

  // Acervo primeiro (é o que existe de verdade), depois o que a busca do site achou.
  const merged = [];
  const seenIds = new Set();
  for (const item of indexed.slice(0, limit)) {
    merged.push({
      id: item.id,
      title: item.title,
      duration: item.duration,
      minutes: item.minutes,
      channel: item.channel,
      thumb: item.thumb,
      page: item.page,
      full: item.durationSec >= MIN_MOVIE_SEC,
      playable: true,
      matchesRuntime: runtimeSec ? true : null,
      via: 'acervo'
    });
    seenIds.add(item.id);
  }
  for (const item of results) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    merged.push({ ...item, via: 'busca' });
  }

  const value = {
    query: q,
    total,
    catalog: catalog.length,
    runtimeMinutes: runtimeSec ? Math.round(runtimeSec / 60) : 0,
    names: names.slice(0, 4),
    results: merged.slice(0, limit),
    error: null
  };
  searchCache.set(cacheKey, { value, until: Date.now() + SEARCH_TTL_MS });
  while (searchCache.size > 60) searchCache.delete(searchCache.keys().next().value);
  return value;
}

/** Formato que a cascata espera (e que o /api/stream entrega ao navegador). */
function streamResult(url) {
  return {
    url,
    provider: 'TokyVideo',
    quality: 'auto',
    // Declarado para o servidor não chamar ffprobe (6 s e dezenas de MB só para ler o codec).
    codec: 'h264',
    isHls: false,
    // O CDN recusa Referer de fora (a página vai com Referrer-Policy: no-referrer) e o
    // Chrome bloqueia os pedaços (Range) sem CORS: aqui o <video> precisa de `crossorigin`.
    browserDirect: true,
    cors: true,
    captions: []
  };
}

/** Abre um vídeo específico do acervo (URL assinada). Só devolve o que toca de verdade. */
async function streamById(id) {
  const cfg = config();
  const key = String(id || '').trim();
  if (!cfg.enabled) return { error: 'A fonte está desligada (TOKYOVIDEO_ENABLED=0).' };
  if (!/^\d{1,12}$/.test(key)) return { error: 'id inválido.' };

  const cachedHit = playCache.get(key);
  if (cachedHit && cachedHit.until > Date.now()) return cachedHit.value;

  const meta = await videoMeta(cfg, key, 8000);
  if (!meta) return { error: 'Vídeo não encontrado.' };
  if (meta.banned || meta.private || meta.live) return { error: 'Vídeo indisponível (banido, privado ou ao vivo).' };
  if (!meta.url) return { error: 'Este vídeo não tem arquivo para tocar.' };

  const codec = await sniffCodec(meta.url, 4000);
  if (codec === 'hevc') return { error: 'Arquivo em HEVC — tocaria só convertendo no Render.' };

  const status = await reachable(meta.url, 6000);
  if (!status) return { error: 'O CDN não abriu o arquivo.' };

  const value = {
    url: meta.url,
    title: meta.title,
    duration: meta.duration,
    channel: meta.channel,
    page: meta.page,
    codec: codec || 'h264'
  };
  playCache.set(key, { value, until: Date.now() + PLAY_TTL_MS });
  while (playCache.size > 200) playCache.delete(playCache.keys().next().value);
  return value;
}

/**
 * @param {{id: string|number, type: string, season?: number, episode?: number, title?: string, note?: Function}} options
 * @returns {Promise<object|null>} no formato da cascata, com `browserDirect: true`
 */
async function findMovieStream(options = {}) {
  const cfg = config();
  // Séries: fora do escopo desta versão (o site não numera temporada/episódio de forma confiável).
  if (!cfg.enabled || options.type !== 'movie') return null;

  // A escolha fica 10 min: "Recarregar" e uma manada no mesmo título não refazem as
  // buscas, e o link assinado vale 24 h. Um "não achei" fica só 4 min (o acervo muda).
  const pickKey = `${options.type}:${options.id}`;
  const hit = pickCache.get(pickKey);
  if (hit && hit.until > Date.now()) {
    if (typeof options.note === 'function' && hit.value) {
      options.note(`reaproveitada a escolha de ~${Math.max(1, Math.round((Date.now() - hit.at) / 60000))} min atrás`);
    }
    return hit.value;
  }

  const result = await findMovieStreamUncached(cfg, options);
  pickCache.set(pickKey, {
    value: result,
    at: Date.now(),
    until: Date.now() + (result ? PICK_HIT_TTL_MS : PICK_MISS_TTL_MS)
  });
  while (pickCache.size > 300) pickCache.delete(pickCache.keys().next().value);
  return result;
}

async function findMovieStreamUncached(cfg, { id, type, season, episode, title, note } = {}) {
  const say = (msg) => { if (typeof note === 'function') note(String(msg)); };
  const trace = { at: new Date().toISOString(), id: String(id), etapas: [], ok: false };
  const step = (msg) => { trace.etapas.push(msg); say(msg); };
  const deadline = Date.now() + cfg.budgetMs;
  const left = () => Math.max(1500, deadline - Date.now());

  try {
    const info = await loadTmdbInfo(cfg, id, type);
    if (!info) {
      step('TMDB: sem resposta (chave ausente ou erro) — sem nomes para procurar');
      return null;
    }

    const wanted = [];
    const addWanted = (name) => {
      const value = String(name || '').trim();
      if (value && !wanted.includes(value)) wanted.push(value);
    };
    addWanted(title); // título que a pessoa abriu
    for (const name of info.names) addWanted(name);

    step(`TMDB: ${info.names.length} nome(s), duração ${Math.round(info.runtimeSec / 60) || '?'} min`);

    // 1) Acervo dos canais indexados: é onde os filmes estão de verdade (a busca do site
    //    devolve clipe/música para quase tudo). Sem esperar: se o índice ainda não existe,
    //    ele é montado em segundo plano e a busca do site atende esta vez.
    const catalog = await loadIndex(cfg, { wait: false });
    if (catalog.length) {
      const hits = searchCatalog(catalog, wanted, info.runtimeSec, info.year).slice(0, 2);
      step(`acervo: ${catalog.length} vídeo(s) indexado(s) · ${hits.length} candidato(s)`);
      for (const hit of hits) {
        const meta = await videoMeta(cfg, hit.id, Math.min(6000, left()));
        if (!meta || !meta.url) { step(`acervo "${hit.title.slice(0, 40)}": sem arquivo`); continue; }
        if (meta.banned || meta.private || meta.live) { step(`acervo "${hit.title.slice(0, 40)}": indisponível`); continue; }
        const status = await reachable(meta.url, 6000);
        if (!status) { step(`acervo "${hit.title.slice(0, 40)}": o CDN não abriu o arquivo`); continue; }
        const sniffed = await sniffCodec(meta.url, 4000);
        if (sniffed === 'hevc') { step(`acervo "${hit.title.slice(0, 40)}": HEVC`); continue; }
        step(`escolhido do acervo: "${meta.title.slice(0, 50)}" · ${hit.minutes} min · canal ${hit.channel || '?'}`);
        trace.ok = true;
        trace.duracao = hit.duration;
        trace.codec = sniffed || 'h264 (suposto)';
        return streamResult(meta.url);
      }
    }

    const queries = [...new Set(wanted.map(normTitle).filter((q) => q.length >= 3))].slice(0, MAX_QUERIES);
    const found = new Map(); // id -> { id, title, score }
    // Em paralelo: cada busca do site leva ~1,2 s; em série, três buscas custariam ~4 s.
    const results = await Promise.all(
      queries.map((query) => searchSite(cfg, query, Math.min(6000, left())))
    );
    results.forEach((res, index) => {
      const query = queries[index];
      if (!res.list.length && !res.status) {
        step(`busca "${query}": falhou (${describeFailure(res)})`);
        return;
      }
      for (const item of res.list) {
        const score = Math.max(...wanted.map((name) => titleScore(name, item.title)));
        const previous = found.get(item.id);
        if (!previous || previous.score < score) found.set(item.id, { ...item, score });
      }
      step(`busca "${query}": ${res.list.length} vídeo(s)`);
    });

    const ranked = [...found.values()]
      .filter((c) => c.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES);

    if (!ranked.length) {
      step(`nenhum título parecido o bastante (${found.size} candidato(s) vistos, mínimo ${MIN_SCORE} de semelhança)`);
      return null;
    }

    // Metadados em paralelo: é onde vêm a duração e o link assinado.
    const metas = await Promise.all(
      ranked.slice(0, MAX_META).map((c) => videoMeta(cfg, c.id, Math.min(6000, left())))
    );

    const scored = [];
    for (let i = 0; i < metas.length; i += 1) {
      const meta = metas[i];
      const cand = ranked[i];
      if (!meta) continue;
      if (meta.banned || meta.private || meta.live) { step(`"${meta.title.slice(0, 40)}": indisponível (banido/privado/ao vivo)`); continue; }
      if (!meta.url) { step(`"${meta.title.slice(0, 40)}": sem arquivo de vídeo`); continue; }
      if (looksLikeExtra(meta.title) && cand.score < 100) { step(`"${meta.title.slice(0, 40)}": material extra (trailer/clipe)`); continue; }
      if (!durationFits(meta.durationSec, info.runtimeSec)) {
        step(`"${meta.title.slice(0, 40)}": duração ${meta.duration || '?'} não confere com o filme`);
        continue;
      }
      // Desempate: título exato, e o ano do TMDB quando o título do site traz ano.
      const foundYear = yearOf(meta.title);
      const yearBonus = foundYear && info.year ? (foundYear === info.year ? 4 : (Math.abs(foundYear - info.year) <= 1 ? 0 : -12)) : 0;
      scored.push({ ...meta, score: cand.score + yearBonus, candScore: cand.score });
    }

    scored.sort((a, b) => b.score - a.score || b.durationSec - a.durationSec);
    if (!scored.length) {
      step('nenhum candidato com a duração do filme (só clipes/trailers ou partes)');
      return null;
    }

    for (const chosen of scored.slice(0, 2)) {
      // Bytes e codec ao mesmo tempo: são dois pedidos ao CDN, não dois passos.
      const [status, sniffed] = await Promise.all([
        reachable(chosen.url, 6000),
        sniffCodec(chosen.url, 4000)
      ]);
      if (!status) { step(`"${chosen.title.slice(0, 40)}": o CDN não abriu o arquivo`); continue; }

      // Só H.264: HEVC cairia na conversão do ffmpeg no Render (banda e CPU que o fdsFlix não gasta).
      if (sniffed === 'hevc') {
        step(`"${chosen.title.slice(0, 40)}": HEVC (evitando conversão no Render)`);
        continue;
      }
      if (!sniffed) step('cabeçalho sem codec declarado; seguindo como H.264 (o acervo é convertido em MP4/H.264)');
      const minutes = Math.round(chosen.durationSec / 60);
      step(`escolhido: "${chosen.title.slice(0, 50)}" · ${minutes} min · semelhança ${chosen.candScore}${info.runtimeSec ? ` · TMDB ${Math.round(info.runtimeSec / 60)} min` : ''}`);
      trace.ok = true;
      trace.duracao = chosen.duration;
      trace.codec = sniffed || 'h264 (suposto)';

      return streamResult(chosen.url);
    }

    step('os candidatos com a duração certa não abriram no CDN');
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
  searchVideos,
  streamById,
  prewarm,
  indexStatus,
  getReport,
  isEnabled,
  // exportados para teste
  normTitle,
  titleScore,
  parseDuration,
  durationFits,
  looksLikeExtra,
  videoIdFromThumb,
  yearOf,
  searchCatalog
};
