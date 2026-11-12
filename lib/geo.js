'use strict';

/**
 * fdsFlix - Localização aproximada de um IP (país, estado, cidade, provedor de internet).
 *
 * Por que NÃO é offline: a base GeoIP embutida (geoip-lite) ocupa ~150 MB de disco e sobe o
 * processo de 37 para ~185 MB de RAM. O Render Free tem 512 MB e ainda roda o ffmpeg.
 * Então a consulta é feita por HTTPS, uma vez por IP novo, com cache.
 *
 * PRIVACIDADE: cada IP NOVO é enviado ao serviço de geolocalização (padrão: ipwho.is). Para não enviar
 * nada a terceiros, defina GEO_API_URL=off (aí só entram IP, dispositivo e contagens, sem lugar).
 *
 * Variáveis:
 *   GEO_API_URL  modelo da URL com {ip} (padrão https://ipwho.is/{ip}?fields=...). "off" desliga.
 *                A resposta pode ter os campos do ipwho.is (country_code, region, city, connection.isp)
 *                ou do ip-api (countryCode, regionName, city, isp).
 *
 * Qualidade: é aproximada. Em internet móvel a cidade costuma ser a da operadora, não a da pessoa.
 */

const net = require('net');

const DEFAULT_URL = 'https://ipwho.is/{ip}?fields=success,country_code,region,city,connection.isp';
const TTL_MS = 7 * 86400000;
const FAIL_TTL_MS = 10 * 60000;
const MAX_CACHE = 5000;
const MAX_QUEUE = 200;
const TIMEOUT_MS = 4000;
const GAP_MS = 1100; // ~55 consultas por minuto, abaixo dos limites comuns de APIs grátis

const cache = new Map();     // ip -> { geo|null, until }
const inflight = new Map();  // ip -> Promise
let queued = 0;
let chain = Promise.resolve();

function template() {
  const raw = String(process.env.GEO_API_URL === undefined ? DEFAULT_URL : process.env.GEO_API_URL).trim();
  if (!raw || /^(off|0|false|none)$/i.test(raw)) return '';
  return raw.includes('{ip}') ? raw : '';
}

function enabled() {
  return Boolean(template());
}

/** IP que não adianta consultar (rede local, loopback, etc.). */
function isPrivate(ip) {
  const v = net.isIP(ip);
  if (!v) return true;
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const low = ip.toLowerCase();
  return low === '::1' || low === '::' || low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd');
}

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f<>"'`]/g, '').trim().slice(0, max);
}

function parse(data) {
  if (!data || typeof data !== 'object' || data.success === false || data.status === 'fail') return null;
  const country = clean(data.country_code || data.countryCode || '', 2).toUpperCase();
  if (!country) return null;
  const conn = data.connection && typeof data.connection === 'object' ? data.connection : {};
  return {
    country,
    region: clean(data.region || data.regionName || '', 60),
    city: clean(data.city || '', 80),
    isp: clean(conn.isp || data.isp || data.org || '', 80)
  };
}

function remember(ip, geo, ttl) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(ip, { geo, until: Date.now() + ttl });
}

/** Resposta já conhecida (memória), sem rede. undefined = nunca consultado; null = consultou e falhou. */
function peek(ip) {
  const hit = cache.get(ip);
  if (!hit || hit.until < Date.now()) return undefined;
  return hit.geo;
}

/** Guarda uma localização já conhecida (ex.: lida do Supabase) para não consultar de novo. */
function seed(ip, geo) {
  if (!ip || !geo || !geo.country || isPrivate(ip)) return;
  remember(ip, { country: geo.country, region: geo.region || '', city: geo.city || '', isp: geo.isp || '' }, TTL_MS);
}

async function fetchOne(ip, fetchFn) {
  const url = template().replace('{ip}', encodeURIComponent(ip));
  try {
    const res = await fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geo = parse(await res.json());
    remember(ip, geo, geo ? TTL_MS : FAIL_TTL_MS);
    return geo;
  } catch (err) {
    remember(ip, null, FAIL_TTL_MS);
    return null;
  }
}

/** Localização do IP (cache -> fila com intervalo mínimo). Nunca lança; devolve null se não souber. */
function lookup(ip, fetchFn = fetch) {
  if (!enabled() || isPrivate(ip)) return Promise.resolve(null);
  const known = peek(ip);
  if (known !== undefined) return Promise.resolve(known);
  if (inflight.has(ip)) return inflight.get(ip);
  if (queued >= MAX_QUEUE) return Promise.resolve(null);
  queued += 1;
  const job = chain.then(async () => {
    try {
      return await fetchOne(ip, fetchFn);
    } finally {
      queued -= 1;
      inflight.delete(ip);
    }
  });
  inflight.set(ip, job);
  // o próximo só começa depois do intervalo mínimo (sem segurar o resultado deste)
  chain = job.then(() => new Promise((resolve) => {
    const t = setTimeout(resolve, GAP_MS);
    if (t.unref) t.unref();
  }), () => {});
  return job;
}

function reset() {
  cache.clear();
  inflight.clear();
  queued = 0;
  chain = Promise.resolve();
}

module.exports = { enabled, isPrivate, peek, seed, lookup, parse, reset };
