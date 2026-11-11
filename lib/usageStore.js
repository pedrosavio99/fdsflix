'use strict';

/**
 * Cliente mínimo do Supabase (PostgREST) para o histórico de consumo das Vercels.
 * Sem dependências: só fetch. Opcional: sem SUPABASE_URL + SUPABASE_SECRET_KEY o ledger
 * segue só com o arquivo local, como antes.
 *
 *   SUPABASE_URL          https://<ref>.supabase.co
 *   SUPABASE_SECRET_KEY   chave secreta do servidor (sb_secret_... ou service_role). NUNCA no navegador.
 *
 * Tabela/função: supabase/usage-schema.sql (rodar uma vez no SQL Editor).
 */

const TIMEOUT_MS = 8000;
const PAGE = 1000;

const status = {
  lastOkAt: null,
  lastError: '',
  tablesMissing: false
};

function config() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:|\/|$))/i.test(url) && key ? { url, key } : null;
}

function enabled() {
  return Boolean(config());
}

function headers(cfg, extra) {
  // Chaves novas (sb_secret_...) vão só em "apikey"; JWT antigo (service_role) também em Authorization.
  const out = { apikey: cfg.key, 'Content-Type': 'application/json', ...(extra || {}) };
  if (cfg.key.startsWith('eyJ')) out.Authorization = `Bearer ${cfg.key}`;
  return out;
}

async function call(method, pathAndQuery, body, extraHeaders) {
  const cfg = config();
  if (!cfg) throw new Error('Supabase não configurado');
  let res;
  try {
    res = await fetch(`${cfg.url}/rest/v1${pathAndQuery}`, {
      method,
      headers: headers(cfg, extraHeaders),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    status.lastError = `sem resposta do Supabase (${err.name === 'TimeoutError' ? 'tempo esgotado' : err.message})`;
    throw new Error(status.lastError);
  }
  if (res.ok) {
    status.lastOkAt = Date.now();
    status.lastError = '';
    status.tablesMissing = false;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  const info = await res.json().catch(() => ({}));
  const code = String(info.code || '');
  // PGRST205 = tabela fora do cache; PGRST202 = função inexistente; 42P01 = tabela não existe.
  status.tablesMissing = code === 'PGRST205' || code === 'PGRST202' || code === '42P01';
  status.lastError = status.tablesMissing
    ? 'tabelas não criadas: rode supabase/usage-schema.sql no SQL Editor'
    : (res.status === 401 || res.status === 403
      ? 'chave recusada pelo Supabase (confira SUPABASE_SECRET_KEY)'
      : `Supabase HTTP ${res.status}${info.message ? `: ${String(info.message).slice(0, 120)}` : ''}`);
  throw new Error(status.lastError);
}

/** Linhas de vercel_usage_daily a partir de `sinceDay` (YYYY-MM-DD), com paginação. */
async function fetchDaily(sinceDay) {
  const rows = [];
  for (let offset = 0; offset < 50000; offset += PAGE) {
    const query = `/vercel_usage_daily?select=day,base,measured_bytes,adjust_bytes,seconds,reports` +
      `&day=gte.${encodeURIComponent(sinceDay)}&order=day.asc,base.asc&limit=${PAGE}&offset=${offset}`;
    const page = await call('GET', query);
    rows.push(...(page || []));
    if (!page || page.length < PAGE) break;
  }
  return rows;
}

/** Soma atômica de um delta numa linha (dia, base). */
async function addUsage(day, base, delta) {
  await call('POST', '/rpc/fdsflix_add_usage', {
    p_day: day,
    p_base: base,
    p_measured: Math.round(delta.measured || 0),
    p_adjust: Math.round(delta.adjust || 0),
    p_seconds: Math.round(delta.seconds || 0),
    p_reports: Math.round(delta.reports || 0)
  });
}

/** Apaga dias mais antigos que `beforeDay` (manutenção: 1x por dia). */
async function pruneBefore(beforeDay) {
  await call('DELETE', `/vercel_usage_daily?day=lt.${encodeURIComponent(beforeDay)}`, undefined, { Prefer: 'return=minimal' });
}

function getStatus() {
  return { enabled: enabled(), ...status };
}

module.exports = { enabled, fetchDaily, addUsage, pruneBefore, getStatus };
