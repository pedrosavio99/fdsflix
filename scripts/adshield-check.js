#!/usr/bin/env node
'use strict';

/**
 * Testa um AdShield de FALLBACK (nó com MEDIA_PROXY=1) antes de ligar no Render.
 *
 *   node scripts/adshield-check.js https://seu-no.vercel.app https://exemplo.com/master.m3u8 [chave]
 *
 * Com a chave (ADSHIELD_FALLBACK_KEY / MEDIA_PROXY_KEY) ele faz o mesmo caminho do Render:
 * health -> /_adshield/media/prepare -> baixa 1 KB pela URL assinada. Sai com código 1 se falhar.
 *
 * Sem chave na linha, usa ADSHIELD_FALLBACK_KEY do ambiente/.env.
 */

require('dotenv').config({ quiet: true });

const [baseArg, mediaArg, keyArg] = process.argv.slice(2);

if (!baseArg || !mediaArg) {
  console.error('Uso: node scripts/adshield-check.js <url-do-nó> <url-de-mídia> [chave]');
  process.exit(2);
}

const base = String(baseArg).trim().replace(/\/+$/, '');
const mediaUrl = String(mediaArg).trim();
const key = String(keyArg || process.env.ADSHIELD_FALLBACK_KEY || '').trim();

async function step(label, run) {
  const started = Date.now();
  try {
    const out = await run();
    console.log(`✅ ${label} (${Date.now() - started} ms)`);
    return out;
  } catch (error) {
    console.error(`❌ ${label} (${Date.now() - started} ms): ${error.message}`);
    process.exit(1);
  }
}

(async () => {
  console.log(`Nó: ${base}`);
  console.log(`Mídia: ${mediaUrl}`);
  console.log(`Chave: ${key ? '(definida)' : '(nenhuma)'}\n`);

  await step('health', async () => {
    const res = await fetch(`${base}/_adshield/health`, { signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (body.version) console.log(`   versão ${body.version} · alvo ${body.target || '?'}`);
    return body;
  });

  const prepared = await step('prepare', async () => {
    const query = new URLSearchParams({ u: mediaUrl });
    const res = await fetch(`${base}/_adshield/media/prepare?${query}`, {
      headers: key ? { 'x-media-key': key, Accept: 'application/json' } : { Accept: 'application/json' },
      signal: AbortSignal.timeout(30000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(`HTTP ${res.status} · ${body.error || 'sem url'}`);
    console.log(`   ${body.kind} · ${body.contentType || '?'} · ${body.status}`);
    return body;
  });

  await step('baixar 1 KB pela URL assinada', async () => {
    const res = await fetch(prepared.url, {
      headers: { Range: 'bytes=0-1023' },
      signal: AbortSignal.timeout(30000)
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`   HTTP ${res.status} · ${res.headers.get('content-type') || '?'} · ${bytes.length} bytes`);
    if (prepared.kind === 'hls') {
      const text = Buffer.from(bytes).toString('utf8');
      if (!text.startsWith('#EXTM3U')) throw new Error('não parece uma playlist HLS');
      const signed = text.split(/\r?\n/).filter((line) => line.includes('/_adshield/media/m/')).length;
      console.log(`   playlist ok · ${signed} URI(s) assinada(s)`);
    }
    return bytes;
  });

  console.log('\n✅ Nó de fallback pronto. No Render:');
  console.log(`   ADSHIELD_FALLBACK_URLS=${base}`);
  if (key) console.log('   ADSHIELD_FALLBACK_KEY=<a mesma chave>');
})().catch((error) => {
  console.error('Falha inesperada:', error.message);
  process.exit(1);
});
