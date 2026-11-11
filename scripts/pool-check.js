#!/usr/bin/env node
'use strict';

/**
 * Confere TODAS as Vercels da pool (VIDSRC_PROXY_URLS / VIDSRC_PROXY_URL).
 *
 *   npm run pool:check                  # usa o .env
 *   npm run pool:check -- https://a.vercel.app https://b.vercel.app
 *   npm run pool:check -- --tmdb 27205  # outro título de teste
 *
 * Para cada Vercel: extrai o Vidsrc, baixa master + variante + 1 segmento pelo mesmo caminho
 * do player, diz em qual etapa falhou e se ela entrega pelo Edge (100 GB) ou pela função Node
 * (10 GB). Sai com código 1 se alguma falhar.
 */

require('dotenv').config({ quiet: true });

const args = process.argv.slice(2);
const tmdbIndex = args.indexOf('--tmdb');
const tmdb = tmdbIndex >= 0 ? args.splice(tmdbIndex, 2)[1] : '603';

const fromEnv = [process.env.VIDSRC_PROXY_URLS, process.env.VIDSRC_PROXY_URL]
  .filter(Boolean).join(',').split(/[\s,;]+/);
const bases = Array.from(new Set((args.length ? args : fromEnv)
  .map((item) => String(item).trim().replace(/\/+$/, ''))
  .filter((item) => /^https?:\/\//i.test(item))));

if (!bases.length) {
  console.error('Nenhuma Vercel informada. Defina VIDSRC_PROXY_URLS no .env ou passe as URLs como argumento.');
  process.exit(2);
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  return { res, body: await res.json().catch(() => ({})) };
}

/**
 * Percorre o MESMO caminho do player: /vidsrc/stream -> master -> variante -> 1 segmento (todos por
 * /vidsrc/hls, que no kit novo roda no Edge). Também diz se a Vercel entrega pelo Edge.
 */
async function check(base) {
  const started = Date.now();
  let step = 'stream';
  try {
    const cap = await getJson(`${base}/vidsrc/hls?cap=1`).catch(() => ({ res: {}, body: {} }));
    const edge = Boolean(cap.res.ok && cap.body && cap.body.adproxy === 'edge');
    const runtime = edge ? 'Edge (100 GB)' : 'função Node (10 GB: reenvie o kit para liberar o Edge)';

    const { res, body } = await getJson(`${base}/vidsrc/stream?tmdb=${encodeURIComponent(tmdb)}`);
    if (!res.ok || !body.url) throw new Error(`HTTP ${res.status}${body.error ? ' · ' + body.error : ''}`);

    step = 'master';
    const master = await fetch(body.url, { signal: AbortSignal.timeout(45000) });
    const masterText = await master.text();
    if (!master.ok || !masterText.startsWith('#EXTM3U')) throw new Error(`HTTP ${master.status}`);
    const variantPath = masterText.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).pop();

    step = 'variante';
    const variant = await fetch(new URL(variantPath, base), { signal: AbortSignal.timeout(45000) });
    const variantText = await variant.text();
    if (!variant.ok || !variantText.startsWith('#EXTM3U')) throw new Error(`HTTP ${variant.status}`);
    const segPath = variantText.split(/\r?\n/).find((l) => l && !l.startsWith('#'));

    step = 'segmento';
    const seg = await fetch(new URL(segPath, base), { signal: AbortSignal.timeout(60000) });
    const bytes = new Uint8Array(await seg.arrayBuffer());
    if (!seg.ok || bytes[0] !== 0x47) throw new Error(`HTTP ${seg.status}${bytes[0] === 0x47 ? '' : ' · não é vídeo MPEG-TS'}`);

    return {
      base, ok: true, ms: Date.now() - started, runtime,
      detail: `master ${master.status} · variante ${variant.status} · segmento ${seg.status} (${bytes.length} bytes)`
    };
  } catch (err) {
    return { base, ok: false, ms: Date.now() - started, detail: `falhou em "${step}": ${err.message}` };
  }
}

(async () => {
  console.log(`Testando ${bases.length} Vercel(s) com o TMDB ${tmdb}...\n`);
  const results = await Promise.all(bases.map(check));
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.base}\n     ${r.detail}${r.runtime ? ` · ${r.runtime}` : ''} · ${r.ms} ms`);
  }
  const good = results.filter((r) => r.ok).length;
  console.log(`\n${good}/${results.length} funcionando.`);
  process.exit(good === results.length ? 0 : 1);
})();
