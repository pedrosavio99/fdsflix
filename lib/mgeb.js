'use strict';

/**
 * Fonte por ID do TMDB (sem busca): mgeb.lat/embed/<tmdbId> devolve um MP4 direto.
 *
 * De onde veio: é um dos 6 players que o redecanais usa (`/wp-json/dooplayer/v1/<post>/movie/<n>`).
 * Os seis são por ID do TMDB — ou seja, NÃO precisa casar título: o fdsFlix já tem o id. Isso
 * resolve de vez o "refinar busca" para esses provedores.
 *
 * O que a página entrega:
 *   GET https://mgeb.lat/embed/<tmdbId>   ->  HTML com <source src="http://<cdn>/movies/…/xx.mp4?username=…&token=…">
 *
 * Por que dá certo no nosso player:
 *   - o MP4 é `faststart` (moov no começo): começa na hora, sem baixar a cauda (o oposto do TokyVideo);
 *   - H.264/AAC (o `ftyp` anuncia `isomiso2avc1mp41`);
 *   - o CDN aceita Range e NÃO exige Referer;
 *   - serve por https também (a página anuncia http; trocamos para https).
 *   - o CDN NÃO manda Access-Control-Allow-Origin: o <video> tem de ir SEM `crossorigin`.
 *
 * Filme:  /embed/<tmdbId>
 * Série:  /embed/<tmdbId>/<temporada>/<episódio>   (o seletor da página só troca o caminho)
 *
 * Variáveis: MGEB_ENABLED=0 desliga; MGEB_BASE troca o endereço se o domínio mudar.
 */

const { relayFetch } = require('./relayFetch');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function config() {
  const strip = (v) => String(v || '').replace(/\/+$/, '');
  return {
    enabled: String(process.env.MGEB_ENABLED || '1') !== '0',
    base: strip(process.env.MGEB_BASE) || 'https://mgeb.lat'
  };
}

function isEnabled() {
  return config().enabled;
}

async function getText(url, timeoutMs, useRelay) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  const doFetch = useRelay ? relayFetch : fetch;
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7'
      }
    });
    if (!res || !res.ok) return { ok: false, status: res ? res.status : 0 };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'tempo esgotado' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 1 byte do MP4 (o CDN é público; não passa por relay nem gasta cota). */
async function reachable(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: controller.signal });
    if (res.body) res.body.cancel().catch(() => {});
    return res.status === 200 || res.status === 206;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** O arquivo é H.264? Lê só o começo (ftyp). */
async function sniffCodec(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-2047' }, signal: controller.signal });
    if (res.status !== 200 && res.status !== 206) return null;
    const head = Buffer.from(await res.arrayBuffer()).toString('latin1');
    if (head.includes('hvc1') || head.includes('hev1')) return 'hevc';
    if (head.includes('avc1') || head.includes('avc3')) return 'h264';
    return null;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A página anuncia http; trocamos para https (o CDN responde igual) — menos para host local. */
function toHttps(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return url;
    if (u.hostname === 'localhost' || /^127\./.test(u.hostname) || u.hostname.includes(':')) return url;
    u.protocol = 'https:';
    return u.toString();
  } catch (err) {
    return url;
  }
}

/** Tira a URL do MP4 da página do player. */
function extractMp4(html) {
  const text = String(html || '');
  const matches = text.match(/https?:\/\/[^"'\s\\<>]+\.mp4\?[^"'\s\\<>]+/g) || [];
  for (const raw of matches) {
    let url;
    try {
      url = new URL(raw);
    } catch (err) {
      continue;
    }
    // Só o CDN de verdade: o resto é anúncio ou placeholder ("vod_nao_encontrado").
    if (!/\.mp4$/i.test(url.pathname)) continue;
    if (/nao_encontrado|not_found/i.test(url.pathname)) continue;
    if (!url.searchParams.get('token')) continue;
    return url.toString();
  }
  return null;
}

// Relatório da última tentativa (sem URLs) para o diagnóstico do admin.
let lastReport = null;
function getReport() {
  return lastReport;
}

/**
 * @param {{id: string|number, type: string, season?: number, episode?: number}} options
 * @returns {Promise<object|null>} no formato da cascata
 */
async function findStream({ id, type, season = 1, episode = 1, title } = {}) {
  const cfg = config();
  if (!cfg.enabled) return null;

  const trace = { at: new Date().toISOString(), id: String(id), etapas: [], ok: false };
  const step = (msg) => trace.etapas.push(msg);

  try {
    const s = Math.max(1, Number(season) || 1);
    const e = Math.max(1, Number(episode) || 1);
    const pageUrl = type === 'tv'
      ? `${cfg.base}/embed/${encodeURIComponent(id)}/${s}/${e}`
      : `${cfg.base}/embed/${encodeURIComponent(id)}`;
    // Direto primeiro (é público e rápido). Se não vier MP4, tenta pelo relay: o Cloudflare
    // desafia IP de datacenter (é o que acontece no Render) e o relay passa.
    let page = await getText(pageUrl, 8000, false);
    step(`player: HTTP ${page.status}${page.ok ? '' : ' (direto)'}`);
    let mp4 = page.ok ? extractMp4(page.text) : null;

    if (!mp4) {
      const viaRelay = await getText(pageUrl, 9000, true);
      step(`player pelo relay: HTTP ${viaRelay.status}`);
      if (viaRelay.ok) {
        page = viaRelay;
        mp4 = extractMp4(viaRelay.text);
      }
    }

    if (!mp4) {
      step('página sem arquivo MP4 (título sem fonte, episódio inexistente ou bloqueio)');
      return null;
    }

    // A página anuncia http; o CDN também responde por https (o app é https, senão o
    // navegador bloquearia o vídeo como conteúdo misto). Se o https falhar, tenta o http.
    let finalUrl = toHttps(mp4);
    if (!(await reachable(finalUrl, 6000))) {
      if (finalUrl === mp4 || !(await reachable(mp4, 6000))) {
        step('o CDN não abriu o arquivo');
        return null;
      }
      finalUrl = mp4; // host sem https: fica no http (só funciona em app http, ex.: local)
    }

    const codec = await sniffCodec(finalUrl, 4000);
    if (codec === 'hevc') {
      step('arquivo em HEVC (evitando conversão no Render)');
      return null;
    }

    step(`escolhido: "${String(title || '').slice(0, 50)}" · ${codec || 'h264'}`);
    trace.ok = true;
    return {
      url: finalUrl,
      provider: 'MGEB',
      quality: 'auto',
      codec: 'h264',
      isHls: false,
      // O CDN não manda Access-Control-Allow-Origin: o navegador busca SEM `crossorigin`.
      browserDirect: true,
      cors: false,
      captions: []
    };
  } catch (err) {
    step('falhou: ' + String(err.message || err).replace(/https?:\/\/\S+/g, '[url]').slice(0, 90));
    return null;
  } finally {
    lastReport = trace;
  }
}

module.exports = {
  findStream,
  getReport,
  isEnabled,
  // exportados para teste
  extractMp4,
  toHttps
};
