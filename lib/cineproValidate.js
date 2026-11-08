'use strict';

/**
 * Valida uma fonte do CinePro ANTES de entregá-la ao player.
 *
 * Motivo: o CinePro devolve várias fontes e a playlist de algumas delas carrega
 * (200) enquanto os segmentos são recusados pela origem (403 em HTML). Sem validar,
 * o player fica "armazenando buffer" para sempre. Aqui baixamos de verdade o
 * começo do primeiro segmento (ou do arquivo) e só aprovamos se for mídia.
 *
 * Tudo roda DENTRO do servidor, falando só com o CinePro embutido.
 */

const { normalizeCineProUrl } = require('./cineproUrl');

const UA = 'fdsFlix/2.0 (+validador)';
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

function snippet(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

async function readHead(res, maxBytes) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(Buffer.from(part.value));
      total += part.value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/** Heurística: parece mídia (e não uma página HTML/JSON de erro)? */
function looksLikeMedia(contentType, head) {
  const ct = String(contentType || '').toLowerCase();
  if (/text\/html|json/.test(ct)) return false;
  const first = head.subarray(0, 1).toString('latin1');
  if (first === '<' || first === '{') return false;
  return head.length > 0;
}

/**
 * @param {{url: string, type: string}} source URLs já normalizadas para a base do CinePro
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, reason?: string, ms: number}>}
 */
async function validateSource(source, options = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 9000);
  const done = (ok, reason) => ({ ok, reason, ms: Date.now() - started });
  const get = (url, headers) =>
    fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity', ...(headers || {}) }, signal: controller.signal, redirect: 'manual' });

  try {
    const kind = String(source.type || '').toLowerCase();

    if (kind !== 'hls') {
      const res = await get(source.url, { Range: 'bytes=0-2047' });
      const head = await readHead(res, 2048);
      if (res.status !== 200 && res.status !== 206) return done(false, `arquivo HTTP ${res.status} ${snippet(head.toString('utf8'))}`);
      if (!looksLikeMedia(res.headers.get('content-type'), head)) return done(false, `arquivo não é mídia (${res.headers.get('content-type')}) ${snippet(head.toString('utf8'))}`);
      return done(true);
    }

    let playlistUrl = source.url;
    for (let depth = 0; depth < 3; depth++) {
      const res = await get(playlistUrl);
      const buf = await readHead(res, MAX_PLAYLIST_BYTES);
      const text = buf.toString('utf8');
      if (res.status !== 200) return done(false, `playlist HTTP ${res.status} ${snippet(text)}`);
      if (!/^\s*#EXTM3U/.test(text)) return done(false, `playlist inválida ${snippet(text)}`);

      const lines = text.split(/\r?\n/).map((l) => l.trim());

      if (/#EXT-X-STREAM-INF/.test(text)) {
        // master: segue a primeira variante
        const i = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
        const variant = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
        const next = variant && normalizeCineProUrl(variant, playlistUrl);
        if (!next) return done(false, 'variante fora do CinePro');
        playlistUrl = next;
        continue;
      }

      // mídia: prefere o init segment (EXT-X-MAP) e depois o primeiro segmento
      const mapMatch = text.match(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/);
      const firstSeg = lines.find((l) => l && !l.startsWith('#'));
      const target = normalizeCineProUrl((mapMatch && mapMatch[1]) || firstSeg, playlistUrl);
      if (!target) return done(false, 'segmento ausente ou fora do CinePro');

      const seg = await get(target, { Range: 'bytes=0-4095' });
      const head = await readHead(seg, 4096);
      if (seg.status !== 200 && seg.status !== 206) return done(false, `segmento HTTP ${seg.status} ${snippet(head.toString('utf8'))}`);
      if (!looksLikeMedia(seg.headers.get('content-type'), head)) return done(false, `segmento não é mídia (${seg.headers.get('content-type')}) ${snippet(head.toString('utf8'))}`);
      return done(true);
    }
    return done(false, 'playlist aninhada demais');
  } catch (err) {
    return done(false, controller.signal.aborted ? 'tempo esgotado' : err.message);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { validateSource, looksLikeMedia };
