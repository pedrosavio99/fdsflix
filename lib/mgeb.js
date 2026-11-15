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

const { fetchSmart } = require('./extractFetch');

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


/**
 * Todas as opções MP4 que a página oferece (`var sources = [...]`), na ordem da página.
 * Antes só valia a URL com `token=` (o CDN do fontedecanais). Quando esse CDN estoura a cota
 * ("Limite de 10 TB atingido", HTTP 403 para qualquer IP) a página continua listando outras
 * opções (ex.: MP4 hospedado fora, sem token) que estavam sendo ignoradas.
 */
function extractMp4Candidates(html) {
  const text = String(html || '');
  const out = [];
  const seen = new Set();
  const add = (raw, label) => {
    let url;
    try {
      url = new URL(String(raw).replace(/\\\//g, '/'));
    } catch (err) {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || !/\.mp4$/i.test(url.pathname)) return;
    if (/nao_encontrado|not_found/i.test(url.pathname)) return;
    const key = url.toString();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: key, tokened: Boolean(url.searchParams.get('token')), label: label || '' });
  };
  const m = text.match(/var sources\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (m) {
    try {
      for (const item of JSON.parse(m[1])) {
        if (item && /mp4/i.test(String(item.type || 'mp4'))) add(item.file, item.label);
      }
    } catch (err) { /* cai no regex abaixo */ }
  }
  const first = extractMp4(text);
  if (first) add(first, '');
  return out;
}

/** Duração (s) lida do átomo `mvhd`, se o `moov` estiver no começo do arquivo (faststart). */
function mp4DurationSec(buf) {
  const i = buf.indexOf('mvhd', 0, 'latin1');
  if (i < 0 || i + 24 > buf.length) return null;
  const version = buf[i + 4];
  try {
    if (version === 1) {
      const timescale = buf.readUInt32BE(i + 24);
      const duration = Number(buf.readBigUInt64BE(i + 28));
      return timescale ? duration / timescale : null;
    }
    const timescale = buf.readUInt32BE(i + 16);
    const duration = buf.readUInt32BE(i + 20);
    return timescale ? duration / timescale : null;
  } catch (err) {
    return null;
  }
}

/**
 * Abre os primeiros 8 KB do MP4: confirma que é vídeo de verdade (e não o aviso de cota/erro),
 * o codec e a duração.
 * @returns {Promise<{ok:boolean, reason?:string, codec?:string|null, durationSec?:number|null}>}
 */
async function probeMp4(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-8191' }, signal: controller.signal });
    if (res.status !== 200 && res.status !== 206) {
      const body = (await res.text().catch(() => '')).slice(0, 80).replace(/\s+/g, ' ');
      return { ok: false, reason: `HTTP ${res.status}${body ? ` (${body})` : ''}` };
    }
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, 8192);
    if (buf.indexOf('ftyp', 0, 'latin1') < 0 || buf.indexOf('ftyp', 0, 'latin1') > 64) {
      return { ok: false, reason: 'resposta não é um MP4' };
    }
    const head = buf.toString('latin1');
    const codec = head.includes('hvc1') || head.includes('hev1') ? 'hevc'
      : (head.includes('avc1') || head.includes('avc3') ? 'h264' : null);
    return { ok: true, codec, durationSec: mp4DurationSec(buf) };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'tempo esgotado' : err.message };
  } finally {
    clearTimeout(timer);
  }
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
    // Extracção em cadeia: direto → relay residencial → Worker (ver lib/extractFetch.js).
    // No Render o direto leva o desafio do Cloudflare; o relay residencial passa.
    const page = await fetchSmart(pageUrl, { timeoutMs: 12000 });
    step(`player: HTTP ${page.status} (${page.via})`);
    const candidates = page.ok && page.text ? extractMp4Candidates(page.text) : [];

    if (!candidates.length) {
      step('página sem arquivo MP4 (título sem fonte, episódio inexistente ou bloqueio)');
      return null;
    }

    // Testa as opções em ordem. Fonte com token (CDN do fontedecanais) vale pelo aviso do próprio
    // CDN; fonte sem token (MP4 hospedado fora) só entra se a duração for de filme/episódio.
    const minSec = type === 'tv' ? 8 * 60 : 40 * 60;
    let n = 0;
    for (const cand of candidates.slice(0, 5)) {
      n += 1;
      const tag = `opção ${n}`;
      let finalUrl = toHttps(cand.url);
      let probe = await probeMp4(finalUrl, 7000);
      if (!probe.ok && finalUrl !== cand.url) {
        const retry = await probeMp4(cand.url, 7000); // host sem https: fica no http
        if (retry.ok) { finalUrl = cand.url; probe = retry; }
      }
      if (!probe.ok) { step(`${tag}: ${probe.reason}`); continue; }
      if (probe.codec === 'hevc') { step(`${tag}: HEVC (evitando conversão no Render)`); continue; }
      if (!cand.tokened) {
        if (probe.durationSec == null || probe.durationSec < minSec) {
          step(`${tag}: duração ${probe.durationSec == null ? 'desconhecida' : Math.round(probe.durationSec / 60) + ' min'} (não parece o título inteiro)`);
          continue;
        }
      }
      step(`${tag} escolhida: "${String(title || '').slice(0, 50)}" · ${probe.codec || 'h264'}${probe.durationSec ? ' · ' + Math.round(probe.durationSec / 60) + ' min' : ''}`);
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
    }
    step('nenhuma opção MP4 abriu');
    return null;
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
  extractMp4Candidates,
  mp4DurationSec,
  toHttps
};
