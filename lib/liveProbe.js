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

function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const segments = [];
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  let pendingBandwidth = 0;
  let encrypted = false;
  let hasMap = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const m = line.match(/BANDWIDTH=(\d+)/);
      pendingBandwidth = m ? Number(m[1]) : 0;
    } else if (line.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(line)) {
      encrypted = true;
    } else if (line.startsWith('#EXT-X-MAP')) {
      hasMap = true;
    } else if (line && !line.startsWith('#')) {
      let abs;
      try { abs = new URL(line, baseUrl).toString(); } catch { continue; }
      if (isMaster) {
        variants.push({ url: abs, bandwidth: pendingBandwidth });
        pendingBandwidth = 0;
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
      const sorted = [...playlist.variants].sort((a, b) => a.bandwidth - b.bandwidth);
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
    const kind = looksLikeFmp4(seg.body) ? 'hls-fmp4' : 'hls';
    return {
      ...base, ok: true, kind, finalUrl: playlistUrl, variants, bandwidth, ms: Date.now() - started
    };
  } catch (error) {
    const msg = error && error.name === 'AbortError' ? 'tempo esgotado' : String((error && error.cause && error.cause.code) || (error && error.message) || error);
    return fail(msg);
  }
}

module.exports = { isPagePlayer, probeSource, parsePlaylist, assertPublicHost, isPrivateIp, fetchLimited };
