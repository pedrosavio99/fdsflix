'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// Segmentos e playlists ficam em domínios que mudam por título (ex.: master em
// oakhollowoutpost.space, segmentos em sageandsolstice.space), então não há lista
// fixa de hosts. Em vez disso, toda URL que o proxy emite é ASSINADA (HMAC) e o
// proxy só busca URLs assinadas por ele: não vira proxy aberto nem alvo de SSRF.
let signingSecret = null;

function configureSigning(config) {
  if (signingSecret) return;
  if (config && config.secretStable) {
    signingSecret = config.secret;
    return;
  }
  const seed =
    process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_PROJECT_ID || process.env.VERCEL_URL || '';
  signingSecret = seed
    ? crypto.createHash('sha256').update(`fdsflix-vidsrc|${seed}`).digest('hex')
    : (config && config.secret) || crypto.randomBytes(32).toString('hex');
}

function sign(url) {
  return crypto.createHmac('sha256', signingSecret).update(url).digest('base64url').slice(0, 22);
}

function verify(url, signature) {
  if (!signingSecret || !signature) return false;
  const expected = Buffer.from(sign(url));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function proxiedPath(url) {
  return `/vidsrc/hls?u=${encodeURIComponent(url)}&s=${sign(url)}`;
}

function withTimeout(controller, ms) {
  return setTimeout(() => controller.abort(), ms);
}

/** Cookie jar mínimo: alguns passos devolvem cookie e o passo seguinte espera recebê-lo. */
function createJar() {
  const jar = new Map();
  return {
    header() {
      return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    absorb(response) {
      try {
        const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
        for (const raw of list) {
          const pair = String(raw).split(';')[0];
          const eq = pair.indexOf('=');
          if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
      } catch (error) {
        /* sem cookies */
      }
    },
    size() {
      return jar.size;
    }
  };
}

async function fetchText(url, headers = {}, timeoutMs = 20000, jar = null) {
  const controller = new AbortController();
  const timer = withTimeout(controller, timeoutMs);
  const started = Date.now();
  try {
    const cookies = jar ? jar.header() : '';
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        ...(cookies ? { Cookie: cookies } : {}),
        ...headers
      },
      redirect: 'follow',
      signal: controller.signal
    });
    if (jar) jar.absorb(response);
    return { response, text: await response.text(), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function parseJsonAssignment(text, name) {
  const re = new RegExp(`(?:window\\.|self\\.|globalThis\\.)?${name}\\s*=\\s*(\\{[\\s\\S]*?\\});`);
  const match = String(text || '').match(re);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    return null;
  }
}

/**
 * Último recurso: o token pode aparecer em outro objeto da página (o Vidsrc já trocou o nome do
 * objeto algumas vezes). Em vez de falhar, procuramos a string `apiToken` em qualquer lugar.
 */
function findApiToken(text) {
  const source = String(text || '');
  const quoted = source.match(/"api_?token"\s*:\s*"([A-Za-z0-9._~\-]{8,})"/i);
  if (quoted) return quoted[1];
  const loose = source.match(/api_?token\s*[=:]\s*["']?([A-Za-z0-9._~\-]{16,})/i);
  return loose ? loose[1] : null;
}

function pageTitle(text) {
  const match = String(text || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim().slice(0, 60) : '';
}

/** O que veio numa página (para o diagnóstico e para as mensagens de erro). */
function pageInfo(result) {
  if (!result) return { status: 0, bytes: 0, title: '', finalHost: null };
  let finalHost = null;
  try {
    finalHost = result.response && result.response.url ? new URL(result.response.url).host : null;
  } catch (error) {
    finalHost = null;
  }
  return {
    status: result.response ? result.response.status : 0,
    bytes: String(result.text || '').length,
    title: pageTitle(result.text),
    finalHost
  };
}

/** Resumo de uma página para a mensagem de erro: o que veio, em vez de só "não achei". */
function pageSummary(result) {
  if (!result) return 'sem resposta';
  const info = pageInfo(result);
  return [
    `HTTP ${info.status}`,
    `${info.bytes} bytes`,
    info.title ? `título "${info.title}"` : 'sem título',
    info.finalHost ? `final ${info.finalHost}` : ''
  ].filter(Boolean).join(', ');
}

async function decryptStreamUrls(streamUrls, vs) {
  if (Array.isArray(streamUrls)) return streamUrls;
  if (typeof streamUrls !== 'string' || !vs) return [];

  let wasm;
  if (vs.wasm_url) {
    const response = await fetch(vs.wasm_url, {
      headers: { 'User-Agent': UA, Accept: 'application/wasm,*/*' }
    });
    if (!response.ok) throw new Error(`WASM HTTP ${response.status}`);
    wasm = await response.arrayBuffer();
  } else if (vs.wasm) {
    wasm = Buffer.from(vs.wasm, 'base64');
  } else {
    return [];
  }

  const { instance } = await WebAssembly.instantiate(wasm, {});
  const exports = instance.exports;
  const encrypted = Buffer.from(streamUrls, 'base64');
  const pointer = exports.alloc(encrypted.length);
  new Uint8Array(exports.memory.buffer, pointer, encrypted.length).set(encrypted);
  const length = exports.decrypt(pointer, encrypted.length);
  const text = new TextDecoder().decode(
    new Uint8Array(exports.memory.buffer, pointer + 12, length)
  );
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Uma passada da cadeia do Vidsrc. `onStep` recebe o que aconteceu em cada passo (para o /vidsrc/selftest).
 * O jar leva cookies de um passo para o outro e é refeito a cada tentativa.
 */
async function resolveVidsrcOnce(options, jar, onStep = () => {}) {
  const { id, type = 'movie', season = 1, episode = 1 } = options;
  const isTv = type === 'tv';
  const embed = isTv
    ? `https://vidsrc.sh/embed/tv/${encodeURIComponent(id)}/${Number(season) || 1}/${Number(episode) || 1}/`
    : `https://vidsrc.sh/embed/movie/${encodeURIComponent(id)}/`;

  const page = await fetchText(embed, { Referer: 'https://vidsrc.sh/' }, 20000, jar);
  onStep({ name: 'embed', ...pageInfo(page), ms: page.ms, hasDataApi: /data-api=/i.test(page.text) });
  if (!page.response.ok) throw new Error(`embed HTTP ${page.response.status}`);
  const apiPathMatch = page.text.match(/data-api="([^"]+)"/i);
  if (!apiPathMatch) throw new Error(`data-api não encontrado (${pageSummary(page)})`);
  const apiPath = decodeEntities(apiPathMatch[1]);

  const srcResponse = await fetchText(new URL(apiPath, embed).toString(), { Referer: embed }, 20000, jar);
  onStep({ name: 'vs_src', ...pageInfo(srcResponse), ms: srcResponse.ms, body: String(srcResponse.text || '').slice(0, 120) });
  if (!srcResponse.response.ok) throw new Error(`vs_src HTTP ${srcResponse.response.status}`);
  let srcJson;
  try {
    srcJson = JSON.parse(srcResponse.text);
  } catch (error) {
    throw new Error(`vs_src não é JSON (${String(srcResponse.text || '').slice(0, 80)})`);
  }
  if (!srcJson || !srcJson.src) throw new Error('vs_src sem src');

  const stellarUrl = new URL(srcJson.src, 'https://stellarconductornexus.com').toString();
  const stellar = await fetchText(stellarUrl, { Referer: embed }, 20000, jar);
  const cfg = parseJsonAssignment(stellar.text, 'CFG');
  onStep({ name: 'stellar', ...pageInfo(stellar), ms: stellar.ms, hasCfg: Boolean(cfg && cfg.playerUrl) });
  if (!cfg || !cfg.playerUrl) throw new Error(`CFG/playerUrl ausente (${pageSummary(stellar)})`);

  const playerUrl = new URL(cfg.playerUrl, 'https://stellarconductornexus.com').toString();
  const player = await fetchText(playerUrl, { Referer: srcJson.src }, 20000, jar);
  let config = parseJsonAssignment(player.text, 'CONFIG');
  let tokenFromPage = '';
  if (!config || !config.apiToken) {
    // O objeto pode ter mudado de nome/formato: tenta achar o token direto na página.
    const scraped = findApiToken(player.text);
    if (scraped) {
      tokenFromPage = scraped;
      config = { ...(config || {}), apiToken: scraped };
    }
  }
  onStep({
    name: 'player',
    ...pageInfo(player),
    ms: player.ms,
    hasConfig: Boolean(config && config.apiToken),
    scrapedToken: Boolean(tokenFromPage)
  });
  if (!config || !config.apiToken) throw new Error(`CONFIG/apiToken ausente (${pageSummary(player)})`);

  const meta = await fetchText(cfg.metaApi, { Referer: srcJson.src }, 20000, jar);
  let metaJson;
  try {
    metaJson = JSON.parse(meta.text);
  } catch (error) {
    throw new Error(`metaApi não é JSON (${pageSummary(meta)})`);
  }
  const host = metaJson && metaJson.data && metaJson.data.stream_urls_api_host;
  onStep({ name: 'meta', ...pageInfo(meta), ms: meta.ms, host: host || null });
  if (!host) throw new Error('stream_urls_api_host ausente');

  const apiUrl =
    `https://${host}/api.php?type=${encodeURIComponent(type)}&tmdb=${encodeURIComponent(id)}` +
    `&stream_urls&api_token=${encodeURIComponent(config.apiToken)}`;
  const api = await fetchText(apiUrl, { Referer: playerUrl }, 20000, jar);
  onStep({ name: 'stream_api', ...pageInfo(api), ms: api.ms });
  if (!api.response.ok) throw new Error(`stream API HTTP ${api.response.status}`);
  let apiJson;
  try {
    apiJson = JSON.parse(api.text);
  } catch (error) {
    throw new Error(`stream API não é JSON (${pageSummary(api)})`);
  }
  if (!apiJson || !apiJson.data || apiJson.data.stream_urls == null) {
    throw new Error(`stream API sem stream_urls (${String(api.text || '').slice(0, 80)})`);
  }

  const streams = await decryptStreamUrls(apiJson.data.stream_urls, apiJson.vs);
  onStep({ name: 'decrypt', playlists: streams.length });
  if (!streams.length) throw new Error('nenhuma playlist decriptada');

  const tokenResponse = await fetchText(
    `https://${host}/generate.php?api_token=${encodeURIComponent(config.apiToken)}`,
    { Referer: playerUrl },
    20000,
    jar
  );
  const token = String(tokenResponse.text || '').trim();
  onStep({ name: 'generate', ...pageInfo(tokenResponse), ms: tokenResponse.ms, hasToken: Boolean(token) });
  if (!token) throw new Error('generate.php sem token');

  return {
    provider: 'Vidsrc',
    host,
    apiToken: config.apiToken,
    tokenSource: tokenFromPage ? 'page-scrape' : 'config',
    pageUrl: embed,
    playerUrl,
    token,
    rawUrls: streams,
    urls: streams.map((url) => `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`),
    subtitles: Array.isArray(apiJson.default_subs) ? apiJson.default_subs : [],
    title: (metaJson.data && metaJson.data.title) || null
  };
}

/**
 * Extrai as playlists HLS do Vidsrc (vidsrc.sh -> stellar -> API + WASM).
 *
 * A cadeia tem 4 saltos e cada um pode falhar sozinho (rate limit, cookie, página diferente por IP).
 * Por isso: (1) cookies acompanham a cadeia; (2) se o miolo falha, repete UMA vez com token novo —
 * é o que resolve a maioria dos `CONFIG/apiToken ausente`; (3) o erro diz o que veio em cada página.
 */
async function resolveVidsrc(options) {
  let firstError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await resolveVidsrcOnce(options, createJar());
    } catch (error) {
      if (!firstError) firstError = error;
      const retryable = /CONFIG|CFG|apiToken|vs_src|embed HTTP 5|socket|ECONN|tempo/i.test(String(error.message));
      if (!retryable) break;
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }
  throw firstError;
}

/** Diagnóstico passo a passo (rota /vidsrc/selftest): mostra onde a cadeia parou, sem segredo. */
async function selfTestVidsrc(options) {
  const started = Date.now();
  const steps = [];
  const jar = createJar();
  try {
    const result = await resolveVidsrcOnce(options, jar, (step) => steps.push(step));
    return {
      ok: true,
      ms: Date.now() - started,
      cookies: jar.size(),
      host: result.host,
      tokenSource: result.tokenSource,
      playlists: result.urls.length,
      title: result.title,
      steps
    };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      cookies: jar.size(),
      error: error.message,
      steps
    };
  }
}

// ---------------------------------------------------------------------------
// Token por instância
//
// O CDN do Vidsrc amarra o JWT (`token`) ao CIDR do IP que o gerou (/24 no IPv4,
// /64 no IPv6). O caminho `/pl/...` NÃO é amarrado, e o token vale para qualquer
// título por ~4h. Como cada instância serverless pode sair por um IP diferente,
// cada uma guarda o PRÓPRIO token e o aplica em qualquer caminho. Se o CDN
// responder "not in range" (IP mudou), o token é refeito e a requisição repete.
// ---------------------------------------------------------------------------
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000;
const CANARY_TMDB = '603';
const tokenState = { token: null, expires: 0, pending: null };
const resolveCache = new Map();
const RESOLVE_TTL_MS = 10 * 60 * 1000;

function rememberToken(host, token) {
  if (token) {
    tokenState.token = token;
    tokenState.expires = Date.now() + TOKEN_TTL_MS;
  }
}

async function getEdgeToken(staleToken) {
  // `staleToken`: token que acabou de falhar. Se outra requisição já o trocou,
  // reaproveita o novo em vez de refazer a cadeia inteira (evita rajada de mints).
  const fresh = tokenState.token && Date.now() < tokenState.expires && tokenState.token !== staleToken;
  if (fresh) return tokenState.token;
  if (!tokenState.pending) {
    tokenState.pending = resolveVidsrc({ id: CANARY_TMDB, type: 'movie' })
      .then((result) => {
        rememberToken(result.host, result.token);
        return result.token;
      })
      .finally(() => {
        tokenState.pending = null;
      });
  }
  return tokenState.pending;
}

function stripToken(raw) {
  const url = new URL(raw);
  url.searchParams.delete('token');
  return url.toString();
}

function withToken(raw, token) {
  const url = new URL(raw);
  url.searchParams.set('token', token);
  return url.toString();
}

/** Igual a resolveVidsrc, mas com cache e URLs SEM token (o proxy aplica o dele). */
async function resolveVidsrcCached(options, config) {
  configureSigning(config);
  const key = [options.type || 'movie', options.id, options.season || 1, options.episode || 1].join(':');
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.value;
  const result = await resolveVidsrc(options);
  rememberToken(result.host, result.token);
  const value = {
    provider: result.provider,
    title: result.title,
    subtitles: result.subtitles,
    urls: result.rawUrls.map(stripToken)
  };
  resolveCache.set(key, { at: Date.now(), value });
  if (resolveCache.size > 200) resolveCache.delete(resolveCache.keys().next().value);
  return value;
}

function rewriteHls(text, upstreamUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const map = (raw) => {
    const value = String(raw || '').trim();
    if (!value || value.startsWith('#')) return raw;
    let url;
    try {
      url = new URL(value, upstreamUrl);
      url.searchParams.delete('token');
    } catch (error) {
      return raw;
    }
    return proxiedPath(url.toString());
  };

  return lines
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (match, uri) => `URI="${map(uri)}"`);
      }
      return map(line);
    })
    .join('\n');
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

async function fetchCdn(upstream, token, rangeHeader) {
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    Referer: 'https://stellarconductornexus.com/'
  };
  if (rangeHeader) headers.Range = rangeHeader;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(withToken(upstream.toString(), token), {
      headers,
      redirect: 'follow',
      signal: controller.signal
    });
    return { response, timer };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function proxyVidsrcHls(req, res, config) {
  configureSigning(config);
  setCors(res);
  const raw = String(req.query.u || '');
  let upstream;
  try {
    upstream = new URL(raw);
  } catch (error) {
    return res.status(400).json({ error: 'URL inválida' });
  }

  if (upstream.protocol !== 'https:' || !verify(upstream.toString(), String(req.query.s || ''))) {
    return res.status(403).json({ error: 'URL não assinada pelo proxy' });
  }

  let token = await getEdgeToken();

  let attempt = await fetchCdn(upstream, token, req.headers.range);
  if (attempt.response.status === 403) {
    // IP de saída mudou desde que o token foi gerado: refaz e tenta de novo.
    clearTimeout(attempt.timer);
    await attempt.response.arrayBuffer().catch(() => null);
    token = await getEdgeToken(token);
    attempt = await fetchCdn(upstream, token, req.headers.range);
  }
  for (let retry = 0; retry < 3 && attempt.response.status === 429; retry += 1) {
    // Rate limit do CDN: espera um pouco (respeitando Retry-After) e repete.
    clearTimeout(attempt.timer);
    const wait = Math.min(2000, (Number(attempt.response.headers.get('retry-after')) || 0) * 1000 || 250 * (retry + 1) ** 2);
    await attempt.response.arrayBuffer().catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, wait));
    attempt = await fetchCdn(upstream, token, req.headers.range);
  }

  const { response, timer } = attempt;
  res.on('close', () => clearTimeout(timer));
  res.setHeader('Cache-Control', 'no-store');

  if (!response.ok && response.status !== 206) {
    clearTimeout(timer);
    return res.status(response.status).type('text').send(await response.text());
  }

  const contentType = String(response.headers.get('content-type') || '');
  const isPlaylist =
    /mpegurl/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(upstream.pathname + upstream.search);

  if (isPlaylist) {
    const text = await response.text();
    clearTimeout(timer);
    res.status(response.status);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    return res.send(rewriteHls(text, upstream.toString()));
  }

  res.status(response.status);
  // O CDN serve os segmentos MPEG-TS como text/html; normaliza para o player.
  res.setHeader('Content-Type', /html|text/i.test(contentType) || !contentType ? 'video/mp2t' : contentType);
  for (const name of ['content-range', 'accept-ranges', 'content-length']) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!response.body) {
    clearTimeout(timer);
    return res.end();
  }
  const stream = Readable.fromWeb(response.body);
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function egressIp() {
  try {
    const { text } = await fetchText('https://api.ipify.org', {}, 8000);
    return text.trim();
  } catch (error) {
    return null;
  }
}

async function probeStep(url, headers, wantBytes) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity', ...headers },
      redirect: 'follow'
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      ms: Date.now() - started,
      bytes: buffer.length,
      contentType: response.headers.get('content-type'),
      head: wantBytes ? undefined : buffer.toString('utf8', 0, 160),
      text: wantBytes ? undefined : buffer.toString('utf8'),
      first: wantBytes ? buffer.subarray(0, 4).toString('hex') : undefined
    };
  } catch (error) {
    return { status: 0, error: error.message, ms: Date.now() - started };
  }
}

/**
 * Teste do IP binding: baixa master -> variante -> 1 segmento a partir do IP
 * DESTA função. Se `url` vier, usa essa master (resolvida em outra invocação).
 */
async function probeVidsrc(options) {
  const out = { egressIp: await egressIp(), steps: {} };
  const referer = { Referer: 'https://stellarconductornexus.com/' };
  let master = options.url;
  if (!master) {
    const started = Date.now();
    const resolved = await resolveVidsrc(options);
    out.resolveMs = Date.now() - started;
    out.resolvedFromIp = out.egressIp;
    master = resolved.urls[resolved.urls.length - 1];
    out.master = master;
  }
  const m = await probeStep(master, referer, false);
  out.steps.master = { status: m.status, ms: m.ms, bytes: m.bytes, head: m.head, error: m.error };
  if (m.status !== 200) return out;

  const lines = String(m.text).split(/\r?\n/).map((l) => l.trim());
  const variant = lines.find((l) => l && !l.startsWith('#'));
  if (!variant) return out;
  const variantUrl = new URL(variant, master).toString();
  const v = await probeStep(variantUrl, referer, false);
  out.steps.variant = { status: v.status, ms: v.ms, bytes: v.bytes, head: v.head, error: v.error };
  if (v.status !== 200) return out;

  const seg = String(v.text).split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!seg) return out;
  const segUrl = new URL(seg, variantUrl).toString();
  const s = await probeStep(segUrl, { ...referer, Range: 'bytes=0-262143' }, true);
  out.steps.segment = { status: s.status, ms: s.ms, bytes: s.bytes, contentType: s.contentType, first: s.first, error: s.error };
  return out;
}

module.exports = {
  resolveVidsrc,
  resolveVidsrcOnce,
  selfTestVidsrc,
  parseJsonAssignment,
  findApiToken,
  resolveVidsrcCached,
  proxyVidsrcHls,
  rewriteHls,
  probeVidsrc,
  getEdgeToken,
  setCors,
  proxiedPath,
  configureSigning,
  rememberToken
};
