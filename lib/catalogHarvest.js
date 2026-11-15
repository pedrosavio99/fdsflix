'use strict';

/**
 * Colheita do catálogo como tarefa em segundo plano (uma por vez), usada pelas rotas do admin
 * e pelo CLI (scripts/harvest.js). Para cada filme do TMDB procura um MP4 ESTÁVEL (sem token)
 * no BitChute e no mgeb.lat e grava em lib/catalog.js (Supabase, ou arquivo sem Supabase).
 *
 * As buscas saem por lib/extractFetch.js (direto → relay residencial/Wasmer → Worker), então
 * do Render a colheita pode passar pelo relay que o dono já tem. Vai devagar de propósito
 * (pausa entre títulos) e desacelera sozinha se o Cloudflare desafiar — rajada faz o IP ser
 * desafiado por horas.
 */

const catalog = require('./catalog');
const bitchute = require('./bitchute');
const mgeb = require('./mgeb');
const audioLang = require('./audioLang');

const MISS_RETRY_MS = 7 * 24 * 3600 * 1000;
const LOG_MAX = 60;

const job = {
  running: false,
  stopRequested: false,
  startedAt: 0,
  finishedAt: 0,
  total: 0,
  done: 0,
  added: 0,
  nothing: 0,
  skipped: 0,
  pending: 0, // sem resposta (Cloudflare): fica para a próxima rodada
  strikes: 0,
  current: '',
  endReason: '',
  options: null,
  log: []
};

const sleepers = new Set();
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { sleepers.delete(wake); resolve(); }, ms);
    const wake = () => { clearTimeout(t); sleepers.delete(wake); resolve(); };
    sleepers.add(wake);
  });
}

function say(line) {
  job.log.push(`${new Date().toTimeString().slice(0, 8)} ${line}`);
  if (job.log.length > LOG_MAX) job.log.shift();
  if (job.onLog) job.onLog(line);
}

async function tmdb(p) {
  const base = String(process.env.TMDB_API_BASE || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
  const key = String(process.env.TMDB_API_KEY || '').trim();
  if (!key) throw new Error('falta TMDB_API_KEY');
  const res = await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

async function titleList({ ids, lists, pages }) {
  const out = [];
  const seen = new Set();
  const add = (id, title, year) => { if (id && !seen.has(String(id))) { seen.add(String(id)); out.push({ id: String(id), title, year }); } };
  if (ids && ids.length) {
    for (const id of ids) {
      try {
        const m = await tmdb(`/movie/${encodeURIComponent(id)}?language=pt-BR`);
        add(m.id, m.title, (m.release_date || '').slice(0, 4));
      } catch (err) { say(`id ${id}: ${err.message}`); }
    }
    return out;
  }
  for (const list of lists) {
    for (let p = 1; p <= pages; p += 1) {
      try {
        const r = await tmdb(`/movie/${list}?language=pt-BR&page=${p}`);
        for (const m of r.results || []) add(m.id, m.title, (m.release_date || '').slice(0, 4));
      } catch (err) { say(`${list} p${p}: ${err.message}`); break; }
    }
  }
  return out;
}

async function harvestOne(item) {
  const found = [];
  try {
    const r = await bitchute.findMovieStream({ id: item.id, type: 'movie', title: item.title });
    if (r && catalog.isStableUrl(r.url)) found.push({ source: 'bitchute', url: r.url, quality: r.quality, cors: false, ...(r.audioLang ? { audioLang: r.audioLang } : {}) });
  } catch (err) { /* segue */ }
  try {
    const r = await mgeb.findStream({ id: item.id, type: 'movie', title: item.title });
    if (r && catalog.isStableUrl(r.url) && !found.some((f) => f.url === r.url)) {
      let lang = null;
      try { lang = await audioLang.audioLanguages(r.url, 8000); } catch (err) { /* sem ffprobe */ }
      found.push({ source: 'mgeb', url: r.url, quality: r.quality, cors: false, ...(lang && audioLang.isPortuguese(lang) ? { audioLang: 'por' } : {}) });
    }
  } catch (err) { /* segue */ }
  return found;
}

function parseOptions(input = {}) {
  const list = (v, d) => (Array.isArray(v) ? v : String(v || d).split(',')).map((s) => String(s).trim()).filter(Boolean);
  const ids = input.ids ? list(input.ids, '').filter((s) => /^\d{1,9}$/.test(s)).slice(0, 200) : [];
  const allowed = new Set(['popular', 'top_rated', 'now_playing', 'upcoming']);
  const lists = list(input.lists, 'popular,top_rated').filter((l) => allowed.has(l));
  return {
    ids,
    lists: lists.length ? lists : ['popular', 'top_rated'],
    pages: Math.max(1, Math.min(25, Number(input.pages) || 3)),
    force: input.force === true || input.force === '1' || input.force === 'true',
    delay: Math.max(2500, Math.min(60000, Number(input.delay) || 4000))
  };
}

async function run(opts) {
  try {
    const items = await titleList(opts);
    await catalog.refreshRemote();
    const known = catalog.load();
    job.total = items.length;
    say(`Catálogo atual: ${Object.keys(known.movies).length} filme(s). Títulos a conferir: ${items.length}.`);

    for (let i = 0; i < items.length && !job.stopRequested; i += 1) {
      const item = items[i];
      job.current = `${item.title} (${item.year || '?'})`;
      const missAt = known.misses[item.id];
      if (!opts.force && (known.movies[item.id] || (missAt && Date.now() - missAt < MISS_RETRY_MS))) {
        job.skipped += 1; job.done += 1; continue;
      }

      let before = bitchute.getStats().challenged;
      let found = await harvestOne(item);
      if (bitchute.getStats().challenged > before) {
        job.strikes += 1;
        say(`Cloudflare desafiou (${job.strikes}x). Esperando 90 s…`);
        if (job.strikes >= 4) { job.endReason = 'Muitos desafios seguidos do Cloudflare: tente de novo mais tarde (o que já foi colhido está salvo).'; break; }
        await sleep(90000);
        if (job.stopRequested) break;
        before = bitchute.getStats().challenged;
        found = await harvestOne(item);
      } else {
        job.strikes = 0;
      }

      job.done += 1;
      if (!found.length && bitchute.getStats().challenged > before) {
        job.pending += 1;
        say(`? ${item.title}: sem resposta (Cloudflare) — fica para a próxima rodada`);
      } else if (found.length) {
        try {
          await catalog.putMovie(item.id, { title: item.title, year: item.year, entries: found.map((f) => ({ ...f, harvestedAt: new Date().toISOString() })) });
          job.added += 1;
          say(`OK ${item.title} → ${found.map((f) => `${f.source}${f.audioLang ? ' (pt)' : ''}`).join(' + ')}`);
        } catch (err) {
          say(`ERRO ao gravar ${item.title}: ${err.message}`);
          job.endReason = `Não consegui gravar o catálogo: ${err.message}`;
          break;
        }
      } else {
        job.nothing += 1;
        try { await catalog.putMiss(item.id); } catch (err) { /* só otimização */ }
        say(`– ${item.title}: nada`);
      }
      await sleep(opts.delay);
    }
    if (!job.endReason) job.endReason = job.stopRequested ? 'Parado pelo admin.' : 'Concluído.';
  } catch (err) {
    job.endReason = `Falhou: ${err.message}`;
    say(job.endReason);
  } finally {
    job.running = false;
    job.current = '';
    job.finishedAt = Date.now();
    say(`Fim: novos ${job.added} · sem fonte ${job.nothing} · já tinham ${job.skipped} · pendentes ${job.pending}. ${job.endReason}`);
  }
}

/** Inicia (se não houver outra rodando). Devolve o estado. */
function start(input = {}, { onLog } = {}) {
  if (job.running) return { started: false, ...state() };
  const opts = parseOptions(input);
  Object.assign(job, {
    running: true, stopRequested: false, startedAt: Date.now(), finishedAt: 0,
    total: 0, done: 0, added: 0, nothing: 0, skipped: 0, pending: 0, strikes: 0, current: '', endReason: '',
    options: opts, log: [], onLog: onLog || null
  });
  const done = run(opts);
  job.promise = done;
  return { started: true, ...state() };
}

function stop() {
  if (!job.running) return state();
  job.stopRequested = true;
  for (const wake of [...sleepers]) wake();
  return state();
}

function state() {
  const { running, stopRequested, startedAt, finishedAt, total, done, added, nothing, skipped, pending, strikes, current, endReason, options, log } = job;
  return { running, stopRequested, startedAt, finishedAt, total, done, added, nothing, skipped, pending, strikes, current, endReason, options, log: log.slice(-25) };
}

module.exports = { start, stop, state, parseOptions, wait: () => job.promise || Promise.resolve() };
