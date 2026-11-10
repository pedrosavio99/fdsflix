#!/usr/bin/env node
'use strict';

/**
 * Confere TODAS as Vercels da pool (VIDSRC_PROXY_URLS / VIDSRC_PROXY_URL).
 *
 *   npm run pool:check                  # usa o .env
 *   npm run pool:check -- https://a.vercel.app https://b.vercel.app
 *   npm run pool:check -- --tmdb 27205  # outro título de teste
 *
 * Para cada Vercel: extrai o Vidsrc, baixa master + variante + 1 segmento a
 * partir do IP DELA e diz em qual etapa falhou. Sai com código 1 se alguma falhar.
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

async function check(base) {
  const started = Date.now();
  try {
    const res = await fetch(`${base}/vidsrc/probe?tmdb=${encodeURIComponent(tmdb)}`, { signal: AbortSignal.timeout(45000) });
    const body = await res.json().catch(() => ({}));
    const steps = body.steps || {};
    const seg = steps.segment || {};
    const ok = res.ok && seg.status === 200;
    const failed = ['master', 'variant', 'segment'].find((k) => !steps[k] || steps[k].status !== 200);
    return {
      base, ok, ms: Date.now() - started, ip: body.egressIp,
      detail: ok
        ? `master ${steps.master.status} · variante ${steps.variant.status} · segmento ${seg.status} (${seg.bytes} bytes)`
        : `HTTP ${res.status}${body.error ? ' · ' + body.error : ''}${failed ? ` · falhou em "${failed}" (${(steps[failed] || {}).status || 'sem resposta'})` : ''}`
    };
  } catch (err) {
    return { base, ok: false, ms: Date.now() - started, detail: err.message };
  }
}

(async () => {
  console.log(`Testando ${bases.length} Vercel(s) com o TMDB ${tmdb}...\n`);
  const results = await Promise.all(bases.map(check));
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.base}\n     ${r.detail}${r.ip ? ` · IP de saída ${r.ip}` : ''} · ${r.ms} ms`);
  }
  const good = results.filter((r) => r.ok).length;
  console.log(`\n${good}/${results.length} funcionando.`);
  process.exit(good === results.length ? 0 : 1);
})();
