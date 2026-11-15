'use strict';

/**
 * "Dublado ou original?": descobre, ANTES de começar a tocar, quais versões do título existem.
 *
 * A cascata normal (`getFallbackStream`) para na primeira fonte que entrega. Aqui as fontes rodam
 * em paralelo (as rápidas primeiro; as pesadas só se as rápidas não acharem nada, para não
 * estourar os 0,1 CPU do Render Free), cada achado é classificado como `dub` (áudio em português)
 * ou `orig` (áudio original), e o melhor de cada tipo é devolvido.
 *
 * Quando o ouvinte escolhe, o `/api/stream?pick=<token>` reaproveita o link já achado: nada é
 * pesquisado duas vezes.
 *
 * Regras de parada (o público não espera à toa):
 *   - achou dublado E original → para na hora;
 *   - achou uma versão → espera só mais `GRACE_MS` pela outra;
 *   - teto de `BUDGET_MS` no total.
 */

const audioLang = require('./audioLang');

const BUDGET_MS = 13000;
const GRACE_MS = 3000;

// Fontes que costumam ter áudio em português. Se só o original apareceu e todas elas já terminaram,
// não adianta esperar mais (e vice-versa para as demais).
const DUBBERS = new Set(['Internet Archive', 'MGEB', 'AnimeFire', 'Dublado PT', 'TokyVideo', 'PeerTube', 'BitChute', 'Catálogo']);
const CACHE_TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 2 * 60 * 1000;

// Fontes leves (rodam todas juntas). As demais só entram se nenhuma dessas achar.
const FAST = new Set([
  'Vidsrc Proxy', 'VidLink Pro', 'AnimeFire', 'MGEB', 'Internet Archive',
  'TokyVideo', 'PeerTube', 'BitChute', 'Catálogo', 'Dublado PT', 'Vidsrc', 'Embed.su'
]);

const cache = new Map(); // chave -> { value, until }
const inflight = new Map();

function keyOf({ id, type, season, episode }) {
  return `${type}:${id}:${type === 'tv' ? `${season}x${episode}` : ''}`;
}

/** 'dub' | 'orig' — pelo que a própria fonte diz e, em MP4, pela faixa de áudio. */
async function classify(info) {
  if (!info) return 'orig';
  const lang = String(info.audioLang || '').toLowerCase();
  if (info.dubbed === true || /^(por|pt|pt-br|ptbr)$/.test(lang)) return 'dub';
  if (/dublad|dub pt|pt[- ]?br/i.test(String(info.audio || '') + ' ' + String(info.provider || ''))) return 'dub';
  const isHls = info.isHls || /\.m3u8(\?|$)/i.test(String(info.url || ''));
  if (!isHls && info.url && /^https?:/i.test(info.url)) {
    try {
      const langs = await audioLang.audioLanguages(info.url, 5000);
      if (langs && audioLang.isPortuguese(langs)) return 'dub';
    } catch (err) { /* best effort */ }
  }
  return 'orig';
}

function better(a, b) {
  // Maior qualidade vence; empate: o que não passa pelo Render.
  const q = (x) => Number(String(x && x.quality).replace(/\D/g, '')) || 0;
  if (!a) return b;
  if (!b) return a;
  if (q(b) !== q(a)) return q(b) > q(a) ? b : a;
  return a;
}

async function runTier(names, providers, args, found, state) {
  const list = providers.filter((p) => names(p.name));
  await Promise.all(list.map(async (p) => {
    const started = Date.now();
    state.pending.add(p.name);
    try {
      const result = await p.fn(args.id, args.type, args.season, args.episode, args.title, { note: () => {} });
      if (!result || !result.url || state.done) return;
      const info = { ...result, provider: result.provider || p.name };
      const kind = await classify(info);
      if (state.done) return;
      found[kind] = better(found[kind], info);
      if (!state.firstAt) state.firstAt = Date.now();
      if (args.log) args.log({ provider: p.name, kind, ms: Date.now() - started });
      state.wake();
    } catch (err) {
      if (args.log) args.log({ provider: p.name, error: String(err.message || err).slice(0, 80), ms: Date.now() - started });
    } finally {
      state.pending.delete(p.name);
      state.wake();
    }
  }));
}

/**
 * @param {{id:string,type:string,season:number,episode:number,title:string,providers:Array,log?:Function}} args
 * @returns {Promise<{dub:object|null, orig:object|null}>}
 */
function discover(args) {
  const key = keyOf(args);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.value);
  if (inflight.has(key)) return inflight.get(key);

  const job = new Promise((resolve) => {
    const found = { dub: null, orig: null };
    const state = { done: false, firstAt: 0, pending: new Set(), wake: () => {} };
    const startedAt = Date.now();
    let timer = null;

    const finish = () => {
      if (state.done) return;
      state.done = true;
      clearTimeout(timer);
      const value = { dub: found.dub, orig: found.orig };
      cache.set(key, { value, until: Date.now() + (value.dub || value.orig ? CACHE_TTL_MS : MISS_TTL_MS) });
      while (cache.size > 300) cache.delete(cache.keys().next().value);
      resolve(value);
    };
    const check = () => {
      if (state.done) return;
      if (found.dub && found.orig) return finish();
      const now = Date.now();
      if (now - startedAt >= BUDGET_MS) return finish();
      if (state.firstAt && now - state.firstAt >= GRACE_MS) return finish();
      if (state.firstAt) {
        const waitingFor = [...state.pending].filter((n) => (found.dub ? !DUBBERS.has(n) : DUBBERS.has(n)));
        if (!waitingFor.length) return finish();
      }
    };
    state.wake = check;
    timer = setInterval(check, 250);
    if (timer.unref) timer.unref();

    (async () => {
      await runTier((n) => FAST.has(n), args.providers, args, found, state);
      if (!state.done && !found.dub && !found.orig) {
        await runTier((n) => !FAST.has(n), args.providers, args, found, state);
      }
      finish();
    })().catch(finish);
  }).finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

module.exports = { discover, classify, keyOf, _cache: cache };
