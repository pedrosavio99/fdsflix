'use strict';

/**
 * Proxy de MÍDIA genérico — a "AdShield de fallback" do módulo de filmes.
 *
 * Por que existe: no Render (5 GB/mês) o vídeo não pode passar pelo servidor. Hoje só o
 * Vidsrc pelas Vercels/Wasmers entrega assim; quando a pool inteira falha, as outras fontes
 * (VidLink Pro, AnimeFire, CinePro…) são PULADAS porque teriam que sair pelo Render. Este
 * módulo deixa um nó do adproxy (uma conta/projeto separado) buscar e entregar QUALQUER
 * mídia — playlist HLS, segmento, mp4 progressivo — com o token dele, sem gastar o Render.
 *
 * É opt-in: só existe quando o nó sobe com MEDIA_PROXY=1. Sem essa variável as rotas
 * respondem 404 e nada do comportamento atual muda.
 *
 * Fluxo:
 *   1) Render -> GET /_adshield/media/prepare?u=<URL da mídia>[&r=referer][&o=origin][&a=ua]
 *      (header x-media-key, quando MEDIA_PROXY_KEY estiver definida no nó)
 *      O nó sonda a URL (1 KB) e devolve {ok, kind: "hls"|"file", url}.
 *   2) Navegador -> a URL devolvida (/_adshield/media/m/<token>) e daí em diante tudo
 *      (variantes, chaves, segmentos) passa pelo nó, porque a playlist é reescrita com
 *      novos tokens.
 *
 * Segurança: toda URL é ASSINADA (HMAC com config.secret) e expira. O nó nunca busca uma
 * URL que ele mesmo não assinou, então não é proxy aberto; e o preparo pode exigir uma
 * chave compartilhada. Destinos privados (localhost/rede interna) continuam bloqueados.
 */

const crypto = require('crypto');
const { Readable } = require('stream');

const { assertSafeDestination } = require('./urls');

const DEFAULT_TTL_SEC = 6 * 60 * 60;
const MAX_REDIRECTS = 4;
const NEUTRAL_USER_AGENT = 'fdsFlix/2.0 (+media relay)';

// Alguns CDNs recusam UA de navegador (428/429) e outros recusam UA vazio. Em vez de apostar num só,
// o prepare TENTA em ordem e assina o token com o que a origem aceitou. É o que faz o nó funcionar
// com VidLink (UA neutro) e com fontes que exigem UA de navegador (AnimeFire) sem código diferente.
const UA_FALLBACKS = [NEUTRAL_USER_AGENT, 'fdsFlix/2.0', ''];

function uaCandidates(preferred) {
  const list = [String(preferred || '').trim(), ...UA_FALLBACKS].filter((value, index, all) => value !== undefined && all.indexOf(value) === index);
  return list;
}

/** 4xx típico de "não gosto do seu UA/IP": vale tentar outro UA; 5xx não. */
function uaRetryable(status) {
  return [401, 403, 405, 406, 427, 428, 429, 451].includes(Number(status));
}
const PROBE_TIMEOUT_MS = 15000;
const PROBE_BYTES = 1024;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

function isEnabled(config) {
  return Boolean(config && config.mediaProxy);
}

function ttlSec(config) {
  return Number(config && config.mediaProxyTtlSec) || DEFAULT_TTL_SEC;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
}

/* ------------------------------------------------------------------ */
/* Tokens assinados                                                    */
/* ------------------------------------------------------------------ */

function signToken(options, config) {
  const payload = {
    u: String(options.url),
    r: options.referer ? String(options.referer) : '',
    o: options.origin ? String(options.origin) : '',
    a: options.userAgent ? String(options.userAgent).slice(0, 300) : '',
    e: Math.floor(Date.now() / 1000) + ttlSec(config)
  };
  if (options.hvc1) payload.h = 1; // só iPhone/Safari: pede a troca hev1->hvc1 (os demais navegadores recebem o arquivo intacto)
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', config.secret).update(`media1.${body}`).digest('base64url');
  return `${body}.${mac}`;
}

function verifyToken(token, config) {
  const raw = String(token || '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;

  const body = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', config.secret).update(`media1.${body}`).digest('base64url');

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }
  if (!parsed || typeof parsed.u !== 'string') return null;

  let url;
  try {
    url = new URL(parsed.u);
  } catch (error) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (Number(parsed.e) && Date.now() > Number(parsed.e) * 1000) return null;

  return {
    url: url.toString(),
    referer: safeHttpUrl(parsed.r),
    origin: safeHttpUrl(parsed.o),
    userAgent: typeof parsed.a === 'string' ? parsed.a : '',
    hvc1: parsed.h === 1
  };
}

function mediaPath(options, config) {
  return `${config.controlPrefix}/media/m/${signToken(options, config)}`;
}

/** Base pública do nó (Vercel/Wasmer põem o host e o protocolo nos cabeçalhos). */
function publicBase(req) {
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  // Sem cabeçalho de proxy: em produção o player precisa de https (senão o navegador bloqueia
  // por mixed content); só em endereço local aceitamos http.
  const local = /^(?:localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(host);
  const proto = forwarded || (req.secure ? 'https' : local ? 'http' : 'https');
  return `${proto}://${host}`;
}

function safeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch (error) {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Busca no upstream (com desvio de redirecionamento validado)         */
/* ------------------------------------------------------------------ */

function buildHeaders(options, range) {
  const headers = {
    'User-Agent': options.userAgent || NEUTRAL_USER_AGENT,
    Accept: '*/*',
    'Accept-Encoding': 'identity'
  };
  if (options.referer) headers.Referer = options.referer;
  if (options.origin) headers.Origin = options.origin;
  if (range) headers.Range = range;
  return headers;
}

async function openUpstream(rawUrl, options) {
  let current = new URL(rawUrl);
  let response = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertSafeDestination(current, options.config);
    response = await fetch(current.toString(), {
      method: options.method || 'GET',
      headers: buildHeaders(options, options.range),
      redirect: 'manual',
      signal: options.signal
    });

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.arrayBuffer().catch(() => null);
      current = new URL(location, current);
      continue;
    }
    return { response, finalUrl: current.toString() };
  }

  throw new Error('redirecionamentos demais');
}

/* ------------------------------------------------------------------ */
/* Reescrita das playlists                                             */
/* ------------------------------------------------------------------ */

function rewritePlaylist(text, upstreamUrl, options, config) {
  const cache = new Map();
  const map = (raw) => {
    const value = String(raw || '').trim();
    if (!value || value.startsWith('#') || /^(?:data|blob):/i.test(value)) return raw;
    if (cache.has(value)) return cache.get(value);
    let url;
    try {
      url = new URL(value, upstreamUrl);
    } catch (error) {
      return raw;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;
    const mapped = mediaPath({ ...options, url: url.toString() }, config);
    cache.set(value, mapped);
    return mapped;
  };

  return String(text || '')
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (match, uri) => `URI="${map(uri)}"`);
      }
      return map(line);
    })
    .join('\n');
}

function isPlaylistContentType(contentType) {
  return /(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)/i.test(String(contentType || ''));
}

/** Tipo de conteúdo para o player: CDNs às vezes mandam segmentos .ts como text/html. */
function mediaContentType(contentType, finalUrl, firstByte) {
  const raw = String(contentType || '').toLowerCase();
  const path = (() => {
    try {
      return new URL(finalUrl).pathname.toLowerCase();
    } catch (error) {
      return '';
    }
  })();

  if (/\.ts$/.test(path) || (firstByte === 0x47 && /text\/html|text\/plain|application\/octet-stream/.test(raw))) {
    return 'video/mp2t';
  }
  if (!raw || raw.startsWith('text/html')) return 'application/octet-stream';
  return contentType;
}

/* ------------------------------------------------------------------ */
/* Rotas                                                               */
/* ------------------------------------------------------------------ */

function keyMatches(req, config) {
  if (!config.mediaProxyKey) return true;
  const provided = String(req.get('x-media-key') || req.query.k || '');
  const expected = config.mediaProxyKey;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * GET /_adshield/media/prepare?u=<url>&r=<referer>&o=<origin>&a=<user-agent>
 * Sonda a URL e devolve a URL assinada por onde o navegador deve buscar.
 */
async function prepareMedia(req, res, config) {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (!isEnabled(config)) {
    return res.status(404).json({ ok: false, error: 'MEDIA_PROXY desligado neste nó' });
  }
  if (!keyMatches(req, config)) {
    return res.status(403).json({ ok: false, error: 'chave do proxy de mídia inválida' });
  }

  const raw = String(req.query.u || '').trim();
  if (!raw || raw.length > 4096) return res.status(400).json({ ok: false, error: 'u inválido' });

  let target;
  try {
    target = new URL(raw);
  } catch (error) {
    return res.status(400).json({ ok: false, error: 'URL inválida' });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return res.status(400).json({ ok: false, error: 'a URL precisa ser http(s)' });
  }

  const options = {
    config,
    referer: safeHttpUrl(req.query.r),
    origin: safeHttpUrl(req.query.o),
    userAgent: String(req.query.a || '').trim().slice(0, 300),
    hvc1: String(req.query.h || '') === '1'
  };

  const started = Date.now();
  let attempt = null;

  for (const userAgent of uaCandidates(options.userAgent)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let probe;
    try {
      probe = await probeOnce(target.toString(), { ...options, userAgent }, controller.signal);
    } catch (error) {
      probe = { ok: false, status: 0, error: error.name === 'AbortError' ? 'tempo esgotado na origem' : error.message };
    } finally {
      clearTimeout(timer);
    }
    attempt = { ...probe, userAgent };
    if (probe.ok || probe.page) break; // deu certo ou é página HTML (não adianta trocar UA)
    if (!uaRetryable(probe.status)) break; // 404/5xx: outro UA não resolve
  }

  try {
    if (!attempt || !attempt.ok) {
      if (attempt && attempt.page) {
        return res.status(415).json({
          ok: false,
          error: 'a URL é uma página HTML, não uma mídia (o fallback só entrega playlist/arquivo)',
          status: attempt.status,
          contentType: attempt.contentType
        });
      }
      return res.status(502).json({
        ok: false,
        error: (attempt && attempt.error) || 'a origem não respondeu',
        status: attempt ? attempt.status : 0,
        ms: Date.now() - started
      });
    }

    const { kind, contentType, status, length, finalUrl } = attempt;
    const signed = { ...options, userAgent: attempt.userAgent, url: finalUrl };

    return res.json({
      ok: true,
      kind,
      url: `${publicBase(req)}${mediaPath(signed, config)}`,
      contentType: contentType || null,
      status,
      length: length || null,
      ua: attempt.userAgent && attempt.userAgent !== NEUTRAL_USER_AGENT ? 'personalizado' : 'neutro',
      // Este nó entrega HEVC "hev1" como "hvc1" (Safari toca). Nós antigos não mandam este campo.
      hvc1: true,
      ms: Date.now() - started,
      expiresInSec: ttlSec(config)
    });
  } finally {
    /* nada a limpar: cada tentativa fechou o próprio timer */
  }
}

/* ------------------------------------------------------------------ */
/* Safari e HEVC: o arquivo vem com o sample entry "hev1" e o Safari     */
/* só aceita "hvc1". A troca é de 4 BYTES dentro do moov (metadado),     */
/* sem re-encode e sem passar o vídeo por outro servidor.               */
/* ------------------------------------------------------------------ */

const HVC1_CACHE_MS = 60 * 60 * 1000;
const HVC1_SCAN_BYTES = 2 * 1024 * 1024;
const hvc1Cache = new Map(); // url -> { offset: number|null, at }

/** Procura "stsd" e, logo depois dele, o sample entry "hev1" no trecho. */
function findHev1In(buffer, baseOffset) {
  let at = buffer.indexOf('stsd', 0, 'latin1');
  while (at !== -1) {
    const limit = Math.min(buffer.length, at + 4096);
    let entry = buffer.indexOf('hev1', at + 4, 'latin1');
    if (entry !== -1 && entry < limit) return baseOffset + entry;
    at = buffer.indexOf('stsd', at + 4, 'latin1');
  }
  return null;
}

function totalFromContentRange(value) {
  const match = /\/(\d+)\s*$/.exec(String(value || ''));
  return match ? Number(match[1]) : 0;
}

/**
 * Descobre o offset absoluto do sample entry "hev1" (cache por URL). Tenta o começo do
 * arquivo e, se o moov estiver no fim (comum), a cauda. Devolve null quando não há o que
 * trocar (já é hvc1, não é MP4, ou não deu para ler).
 */
async function findHvc1Offset(url, options) {
  const hit = hvc1Cache.get(url);
  if (hit && Date.now() - hit.at < HVC1_CACHE_MS) return hit.offset;

  const probe = async (range) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const { response } = await openUpstream(url, { ...options, range, signal: controller.signal });
      // Lê no máximo HVC1_SCAN_BYTES: se a origem ignorar o Range e mandar o arquivo inteiro, não baixa o filme.
      const chunks = [];
      let total = 0;
      const reader = response.body && response.body.getReader ? response.body.getReader() : null;
      if (!reader) return { response, buffer: Buffer.alloc(0), partial: false };
      while (total < HVC1_SCAN_BYTES) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        total += value.length;
      }
      reader.cancel().catch(() => null);
      return { response, buffer: Buffer.concat(chunks).subarray(0, HVC1_SCAN_BYTES), partial: response.status !== 206 };
    } finally {
      clearTimeout(timer);
    }
  };

  let offset = null;
  try {
    const head = await probe(`bytes=0-${HVC1_SCAN_BYTES - 1}`);
    const cr = head.response.headers.get('content-range') || '';
    const start = Number((/bytes (\d+)-/.exec(cr) || [])[1]) || 0;
    offset = findHev1In(head.buffer, start);
    if (offset === null) {
      const total = totalFromContentRange(cr);
      if (total > 0) {
        const from = Math.max(0, total - HVC1_SCAN_BYTES);
        const tail = await probe(`bytes=${from}-${total - 1}`);
        const tailStart = Number((/bytes (\d+)-/.exec(tail.response.headers.get('content-range') || '') || [])[1]) || from;
        if (!tail.partial) offset = findHev1In(tail.buffer, tailStart); // origem sem Range: o "fim" seria o começo de novo
      }
    }
  } catch (error) {
    offset = null;
  }

  hvc1Cache.set(url, { offset, at: Date.now() });
  while (hvc1Cache.size > 300) hvc1Cache.delete(hvc1Cache.keys().next().value);
  return offset;
}

/** Troca os 4 bytes "hev1" por "hvc1" se o pedaço atual cobrir o offset. */
function patchHev1Chunk(buffer, position, offset) {
  if (offset === null || offset === undefined) return buffer;
  const local = offset - position;
  if (local < 0 || local + 4 > buffer.length) return buffer;
  if (buffer.toString('latin1', local, local + 4) !== 'hev1') return buffer;
  buffer.write('hvc1', local, 'latin1');
  return buffer;
}

/** Uma sondagem com um UA: 1 KB da origem + tipo de conteúdo. Nunca responde: devolve o resultado. */
async function probeOnce(rawUrl, options, signal) {
  const { response, finalUrl } = await openUpstream(rawUrl, {
    ...options,
    range: `bytes=0-${PROBE_BYTES - 1}`,
    signal
  });
  const contentType = String(response.headers.get('content-type') || '');
  const status = response.status;

  let head = Buffer.alloc(0);
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (head.length < PROBE_BYTES) {
        const { value, done } = await reader.read();
        if (done) break;
        head = Buffer.concat([head, Buffer.from(value)]);
      }
    } finally {
      reader.cancel().catch(() => null);
    }
  }

  const looksPlaylist =
    head.toString('utf8').trimStart().startsWith('#EXTM3U') || isPlaylistContentType(contentType);
  const page = !looksPlaylist && /text\/html|application\/xhtml/i.test(contentType);
  const lengthHeader = response.headers.get('content-range') || response.headers.get('content-length') || '';

  if (!response.ok && status !== 206) {
    return { ok: false, status, error: `origem HTTP ${status}`, contentType, page: false };
  }
  if (page) return { ok: false, status, page: true, contentType };

  return {
    ok: true,
    kind: looksPlaylist ? 'hls' : 'file',
    status,
    contentType,
    length: lengthHeader || null,
    finalUrl
  };
}

/**
 * GET/HEAD /_adshield/media/m/:token
 * Entrega playlist (reescrita), segmento ou arquivo. Repassa Range para o player poder buscar.
 */
async function serveMedia(req, res, config) {
  setCors(res);
  if (!isEnabled(config)) return res.status(404).end();

  const entry = verifyToken(req.params.token, config);
  if (!entry) return res.status(403).type('text').send('Token de mídia inválido.');

  const options = { config, referer: entry.referer, origin: entry.origin, userAgent: entry.userAgent };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  const cleanup = () => {
    clearTimeout(timer);
    controller.abort();
  };
  res.on('close', cleanup);

  try {
    const { response, finalUrl } = await openUpstream(entry.url, {
      ...options,
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      range: req.headers.range,
      signal: controller.signal
    });

    const contentType = String(response.headers.get('content-type') || '');

    if (response.status >= 400) {
      const body = await response.text().catch(() => '');
      clearTimeout(timer);
      return res.status(response.status).type('text').send(body.slice(0, 300) || `origem HTTP ${response.status}`);
    }

    if (!response.body || req.method === 'HEAD') {
      clearTimeout(timer);
      res.status(response.status);
      res.setHeader('Content-Type', mediaContentType(contentType, finalUrl));
      for (const name of ['content-range', 'accept-ranges', 'content-length']) {
        const value = response.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.end();
    }

    const reader = response.body.getReader();
    let head = Buffer.alloc(0);
    while (head.length < 9) {
      const { value, done } = await reader.read();
      if (done) break;
      head = Buffer.concat([head, Buffer.from(value)]);
    }

    const playlist =
      isPlaylistContentType(contentType) || head.toString('utf8').trimStart().startsWith('#EXTM3U');

    if (playlist) {
      const chunks = [head];
      let total = head.length;
      while (total < MAX_PLAYLIST_BYTES) {
        const { value, done } = await reader.read();
        if (done) break;
        const buffer = Buffer.from(value);
        chunks.push(buffer);
        total += buffer.length;
      }
      reader.cancel().catch(() => null);
      clearTimeout(timer);

      const text = Buffer.concat(chunks).toString('utf8');
      const rewritten = rewritePlaylist(text, finalUrl, options, config);
      const out = Buffer.from(rewritten, 'utf8');
      res.status(200);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Content-Length', String(out.length));
      res.setHeader('Cache-Control', 'no-store');
      return res.end(out);
    }

    res.status(response.status);
    res.setHeader('Content-Type', mediaContentType(contentType, finalUrl, head[0]));
    for (const name of ['content-range', 'accept-ranges', 'content-length']) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Safari não toca HEVC marcado como "hev1": troca os 4 bytes do sample entry para "hvc1"
    // no próprio stream (sem re-encode e sem sair do nó). Custa 2 MB de leitura por arquivo/hora.
    let hvc1Offset = null;
    const looksMp4 = /video\/mp4/i.test(contentType) || /\.mp4(?:$|\?)/i.test(finalUrl);
    if (looksMp4 && entry.hvc1) {
      try {
        hvc1Offset = await findHvc1Offset(entry.url, options);
      } catch (error) {
        hvc1Offset = null;
      }
    }
    let position = Number((/bytes (\d+)-/.exec(response.headers.get('content-range') || '') || [])[1]) || 0;

    const stream = Readable.from(
      (async function* pipeBody() {
        if (head.length) {
          yield patchHev1Chunk(head, position, hvc1Offset);
          position += head.length;
        }
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          const chunk = Buffer.from(value);
          yield patchHev1Chunk(chunk, position, hvc1Offset);
          position += chunk.length;
        }
      })()
    );
    stream.on('error', () => res.destroy());
    res.on('close', () => {
      reader.cancel().catch(() => null);
      stream.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    clearTimeout(timer);
    if (res.headersSent) return res.destroy();
    const status = error.name === 'AbortError' ? 504 : Number(error.status) || 502;
    return res.status(status).type('text').send(`Falha no proxy de mídia: ${error.message}`);
  }
}

module.exports = {
  isEnabled,
  prepareMedia,
  serveMedia,
  rewritePlaylist,
  signToken,
  verifyToken,
  mediaPath,
  mediaContentType,
  NEUTRAL_USER_AGENT
};
