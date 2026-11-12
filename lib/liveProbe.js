'use strict';

/**
 * fdsFlix - Teste de saúde de uma fonte de TV ao vivo.
 *
 * Uma fonte só conta como "viva" se de fato entrega vídeo: baixa a playlist, escolhe uma
 * variante, baixa o último segmento (alguns KB) e confere se é MPEG-TS/fMP4 de verdade.
 * Playlist que responde 200 mas cujo segmento dá 403/404 (o caso mais comum em IPTV pirata)
 * é descartada aqui, antes de chegar ao player.
 *
 * Custo de banda: só entrada no servidor (alguns KB por teste). Nada sai do Render.
 */

const dns = require('dns').promises;
const net = require('net');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_REDIRECTS = 4;
const PLAYLIST_CAP = 256 * 1024;
const SEGMENT_PEEK = 4096;

/**
 * Hosts de PÁGINAS de player (HTML com o vídeo dentro, geralmente cheias de anúncio). Não dá para testar o vídeo
 * delas daqui (é JavaScript), então basta a página abrir. O fdsFlix as entrega pelo AdShield da Vercel, que tira
 * os anúncios e bloqueia pop-ups, igual ao player do VidLink. LIVE_PAGE_HOSTS soma hosts (separados por vírgula).
 */

function pageHosts() {
  const extra = String(process.env.LIVE_PAGE_HOSTS || '').split(/[\s,;]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...require('./liveChannels').PAGE_HOSTS, ...extra];
}

function isPagePlayer(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return pageHosts().some((h) => host === h || host.endsWith(`.${h}`));
  } catch (error) {
    return false;
  }
}

/* ------------------------------ segurança de rede ------------------------------ */

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIp(mapped[1]) : false;
  }
  return true;
}

/** Só fala com hosts públicos: uma lista .m3u de terceiros nunca aponta o servidor para dentro de casa. */
async function assertPublicHost(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocolo não permitido');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('host local');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('IP privado');
    return;
  }
  const answers = await dns.lookup(host, { all: true });
  if (!answers.length || answers.some((a) => isPrivateIp(a.address))) throw new Error('host resolve para IP privado');
}

/* --------------------------------- rede ---------------------------------------- */

async function fetchLimited(url, options = {}) {
  // LIVE_ALLOW_PRIVATE_HOSTS=1 existe só para testar com uma fonte local; em produção deixe desligado.
  const { timeoutMs = 8000, cap = PLAYLIST_CAP, headers = {}, fetchImpl = fetch } = options;
  const skipHostCheck = options.skipHostCheck === undefined ? process.env.LIVE_ALLOW_PRIVATE_HOSTS === '1' : options.skipHostCheck;
  let current = url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!skipHostCheck) await assertPublicHost(current);
      const res = await fetchImpl(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': UA, Accept: '*/*', ...headers }
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        try { await res.body?.cancel(); } catch { /* ignora */ }
        current = new URL(res.headers.get('location'), current).toString();
        continue;
      }
      const chunks = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        try {
          while (total < cap) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
            total += value.length;
          }
        } finally {
          try { await reader.cancel(); } catch { /* ignora */ }
        }
      }
      const body = Buffer.concat(chunks).subarray(0, cap);
      return {
        status: res.status,
        finalUrl: current,
        contentType: String(res.headers.get('content-type') || ''),
        cors: String(res.headers.get('access-control-allow-origin') || ''),
        body
      };
    }
    throw new Error('redirecionamentos demais');
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ leitura de HLS --------------------------------- */

function looksLikeTs(buf) {
  if (buf.length >= 189 && buf[0] === 0x47 && buf[188] === 0x47) return true;
  return buf.length >= 1 && buf[0] === 0x47 && buf.length < 189;
}
function looksLikeFmp4(buf) {
  if (buf.length < 8) return false;
  const tag = buf.subarray(4, 8).toString('latin1');
  return tag === 'ftyp' || tag === 'styp' || tag === 'moof' || tag === 'moov';
}
function looksLikeAdts(buf) {
  return buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0;
}

/** A variante do master tem imagem? RESOLUTION ou um codec de vídeo no CODECS; sem nenhum dos dois, assume que sim. */
function variantHasVideo(line) {
  if (/RESOLUTION=\d+x\d+/i.test(line)) return true;
  const codecs = line.match(/CODECS="([^"]*)"/i);
  if (!codecs) return true;
  return /avc1|avc3|hvc1|hev1|av01|vp09|vp08|mp4v|dvh1|dvhe/i.test(codecs[1]);
}

const TS_VIDEO_TYPES = new Set([0x01, 0x02, 0x10, 0x1b, 0x1e, 0x20, 0x24, 0x42, 0xd1]);

/**
 * Lê o PAT/PMT do começo de um segmento MPEG-TS e diz que tipos de fluxo ele tem.
 * @returns {{video: boolean, audio: boolean, types: number[]}|null} null = não deu para saber (PMT fora do trecho lido)
 */
function tsStreams(buf) {
  let start = -1;
  for (let i = 0; i < Math.min(188, buf.length); i += 1) {
    if (buf[i] === 0x47 && (buf.length <= i + 188 || buf[i + 188] === 0x47)) { start = i; break; }
  }
  if (start < 0) return null;
  const section = (pid) => {
    for (let o = start; o + 188 <= buf.length; o += 188) {
      if (buf[o] !== 0x47) return null;
      const p = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];
      if (p !== pid || !(buf[o + 1] & 0x40)) continue;
      const afc = (buf[o + 3] >> 4) & 3;
      let at = o + 4;
      if (afc & 2) at += 1 + buf[at];
      if (!(afc & 1)) continue;
      at += 1 + buf[at]; // pointer_field
      return buf.subarray(at, o + 188);
    }
    return null;
  };
  const pat = section(0);
  if (!pat || pat.length < 12) return null;
  let pmtPid = -1;
  const patEnd = Math.min(pat.length, 3 + (((pat[1] & 0x0f) << 8) | pat[2]) - 4);
  for (let i = 8; i + 4 <= patEnd; i += 4) {
    const program = (pat[i] << 8) | pat[i + 1];
    if (program !== 0) { pmtPid = ((pat[i + 2] & 0x1f) << 8) | pat[i + 3]; break; }
  }
  if (pmtPid < 0) return null;
  const pmt = section(pmtPid);
  if (!pmt || pmt.length < 13 || pmt[0] !== 0x02) return null;
  const end = Math.min(pmt.length, 3 + (((pmt[1] & 0x0f) << 8) | pmt[2]) - 4);
  let i = 12 + (((pmt[10] & 0x0f) << 8) | pmt[11]);
  const types = [];
  while (i + 5 <= end) {
    types.push(pmt[i]);
    i += 5 + (((pmt[i + 3] & 0x0f) << 8) | pmt[i + 4]);
  }
  if (!types.length) return null;
  return { types, video: types.some((t) => TS_VIDEO_TYPES.has(t)), audio: types.some((t) => [0x03, 0x04, 0x0f, 0x11, 0x81, 0x87].includes(t)) };
}

function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const segments = [];
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  let pendingBandwidth = 0;
  let pendingVideo = true;
  let encrypted = false;
  let hasMap = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const m = line.match(/BANDWIDTH=(\d+)/);
      pendingBandwidth = m ? Number(m[1]) : 0;
      pendingVideo = variantHasVideo(line);
    } else if (line.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(line)) {
      encrypted = true;
    } else if (line.startsWith('#EXT-X-MAP')) {
      hasMap = true;
    } else if (line && !line.startsWith('#')) {
      let abs;
      try { abs = new URL(line, baseUrl).toString(); } catch { continue; }
      if (isMaster) {
        variants.push({ url: abs, bandwidth: pendingBandwidth, video: pendingVideo });
        pendingBandwidth = 0;
        pendingVideo = true;
      } else {
        segments.push(abs);
      }
    }
  }
  return { variants, segments, encrypted, hasMap, isMaster: variants.length > 0 };
}

/**
 * @param {string} url
 * @param {{timeoutMs?: number, fetchImpl?: Function, skipHostCheck?: boolean}} [options]
 * @returns {Promise<{ok: boolean, kind: string|null, reason?: string, ms: number, finalUrl?: string, https: boolean,
 *   port: string, cors: boolean, variants?: number, bandwidth?: number}>}
 */
async function probeSource(url, options = {}) {
  const started = Date.now();
  const parsed = (() => { try { return new URL(url); } catch { return null; } })();
  const base = {
    ok: false, kind: null, ms: 0, https: !!parsed && parsed.protocol === 'https:',
    port: parsed ? (parsed.port || (parsed.protocol === 'https:' ? '443' : '80')) : '', cors: false
  };
  const fail = (reason, extra = {}) => ({ ...base, ...extra, ok: false, reason, ms: Date.now() - started });
  if (!parsed) return fail('URL inválida');

  const fetchOpts = {
    timeoutMs: options.timeoutMs || 8000,
    fetchImpl: options.fetchImpl,
    skipHostCheck: options.skipHostCheck
  };

  try {
    const first = await fetchLimited(url, fetchOpts);
    if (first.status !== 200 && first.status !== 206) return fail(`HTTP ${first.status}`);
    base.cors = first.cors !== '';

    const head = first.body.subarray(0, 8).toString('latin1');
    if (!head.startsWith('#EXTM3U')) {
      if (looksLikeTs(first.body)) {
        const info = tsStreams(first.body);
        if (info && !info.video) return fail('só áudio (o fluxo TS não tem vídeo)');
      }
      if (looksLikeTs(first.body)) return { ...base, ok: true, kind: 'ts', finalUrl: first.finalUrl, ms: Date.now() - started };
      if (isPagePlayer(url) && /html/i.test(first.contentType) && first.body.length > 200) {
        return { ...base, ok: true, kind: 'page', finalUrl: first.finalUrl, ms: Date.now() - started };
      }
      return fail(`resposta não é vídeo (${first.contentType || 'sem tipo'})`);
    }

    let playlist = parsePlaylist(first.body.toString('utf8'), first.finalUrl);
    let playlistUrl = first.finalUrl;
    let bandwidth = 0;
    const variants = playlist.variants.length;

    if (playlist.isMaster) {
      // Escolhe a variante do meio da lista por banda: nem a mais leve (ruim), nem a mais pesada.
      const withVideo = playlist.variants.filter((v) => v.video);
      if (!withVideo.length) return fail('só áudio (nenhuma variante tem vídeo)', { variants });
      const sorted = [...withVideo].sort((a, b) => a.bandwidth - b.bandwidth);
      const pick = sorted[Math.floor((sorted.length - 1) / 2)];
      bandwidth = pick.bandwidth;
      const sub = await fetchLimited(pick.url, fetchOpts);
      if (sub.status !== 200) return fail(`variante HTTP ${sub.status}`, { variants });
      playlist = parsePlaylist(sub.body.toString('utf8'), sub.finalUrl);
      playlistUrl = sub.finalUrl;
    }

    if (playlist.encrypted) return fail('stream criptografado (AES/DRM)', { variants });
    if (!playlist.segments.length) return fail('playlist sem segmentos', { variants });

    const target = playlist.segments[playlist.segments.length - 1];
    const seg = await fetchLimited(target, { ...fetchOpts, cap: SEGMENT_PEEK });
    if (seg.status !== 200 && seg.status !== 206) return fail(`segmento HTTP ${seg.status}`, { variants });
    if (!looksLikeTs(seg.body) && !looksLikeFmp4(seg.body) && !looksLikeAdts(seg.body)) {
      return fail('segmento não é MPEG-TS/fMP4', { variants });
    }
    if (looksLikeAdts(seg.body) && !looksLikeTs(seg.body)) return fail('só áudio (segmento AAC/ADTS)', { variants });
    if (looksLikeTs(seg.body)) {
      const info = tsStreams(seg.body);
      if (info && !info.video) return fail('só áudio (o segmento não tem vídeo)', { variants });
    }
    const kind = looksLikeFmp4(seg.body) ? 'hls-fmp4' : 'hls';
    return {
      ...base, ok: true, kind, finalUrl: playlistUrl, variants, bandwidth, ms: Date.now() - started
    };
  } catch (error) {
    const msg = error && error.name === 'AbortError' ? 'tempo esgotado' : String((error && error.cause && error.cause.code) || (error && error.message) || error);
    return fail(msg);
  }
}

module.exports = { isPagePlayer, probeSource, parsePlaylist, tsStreams, assertPublicHost, isPrivateIp, fetchLimited };
