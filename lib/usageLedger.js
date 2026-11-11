'use strict';

/**
 * fdsFlix - Contador de consumo das Vercels (pool do Vidsrc).
 *
 * A Vercel não deixa a função saber quanto da cota do mês já foi gasto, e cada
 * requisição pode cair numa instância diferente (não dá para somar em memória lá).
 * Quem sabe quantos bytes chegaram é o navegador (hls.js): ele manda o total para
 * cá a cada ~20 s e ao fechar a aba.
 *
 * MODELO: uma linha por DIA (UTC) e por Vercel: { measured, adjust, seconds, reports }.
 *   usado no ciclo = soma de (measured + adjust) dos dias desde a última renovação;
 *   médias e previsões usam só `measured` (a calibração não distorce a média).
 * Por isso a renovação da cota NÃO apaga nada: o ciclo é só uma janela sobre o histórico.
 *
 * PERSISTÊNCIA: arquivo local (cache) + Supabase (lib/usageStore.js), que sobrevive aos
 * reinícios do Render. Os envios ao Supabase são em lote (soma atômica por dia/Vercel),
 * então o custo é de poucas requisições por minuto. Sem Supabase, funciona só com o arquivo.
 *
 * É uma ESTIMATIVA: não vê quem fechou a aba sem enviar. Use /api/usage/calibrate para
 * acertar o número com o painel da Vercel.
 *
 * Variáveis (todas opcionais):
 *   VIDSRC_PROXY_URLS   lista de Vercels separadas por vírgula/espaço (pool)
 *   VIDSRC_PROXY_URL    uma Vercel só (continua valendo)
 *   VERCEL_QUOTA_GB     cota mensal de uma Vercel que entrega o vídeo pelo EDGE (padrão 100, plano Hobby:
 *                       é o Fast Data Transfer)
 *   VERCEL_FOT_QUOTA_GB cota de uma Vercel que ainda entrega pela função Node (padrão 10, plano Hobby:
 *                       é o Fast Origin Transfer, que o vídeo consome 1:1 junto com o Data Transfer).
 *                       Cada Vercel é classificada sozinha (veja refreshCapabilities), então Vercels
 *                       antigas e novas convivem na mesma pool.
 *   VIDSRC_PROXY_QUOTAS cota fixa por provedor que não é Vercel: `URL=GB` separados por vírgula
 *                       (ex.: https://x.wasmer.app=150). Quem não aparece aqui segue as regras acima.
 *   USAGE_CAPABILITY_PROBE=0  não pergunta às Vercels se entregam pelo Edge (usado nos testes)
 *   USAGE_RESET_DAY     dia do mês em que a cota renova (padrão 1)
 *   USAGE_FILE          onde guardar o cache local (padrão ./.usage.json)
 *   SUPABASE_URL / SUPABASE_SECRET_KEY   histórico durável (veja supabase/usage-schema.sql)
 */

const fs = require('fs');
const path = require('path');
const store = require('./usageStore');

const GB = 1024 ** 3;
const DAY_MS = 86400000;
const MAX_REPORT_BYTES = 600 * 1024 * 1024; // teto por envio: evita número absurdo
const DEFAULT_GB_PER_HOUR = 2.2;            // 1080p ≈ 6 Mbps, até haver média real
const HISTORY_DAYS = 120;                   // quanto histórico fica carregado em memória
const KEEP_DAYS = 400;                      // acima disso o Supabase apaga
const FLUSH_DELAY_MS = 20000;
const RETRY_DELAY_MS = 60000;
const PULL_EVERY_MS = 10 * 60000;
const FILE = path.resolve(process.env.USAGE_FILE || path.join(__dirname, '..', '.usage.json'));

// daily[dia][base] = { measured, adjust, seconds, reports }
const state = { daily: {} };
let pending = {};   // somas ainda não enviadas ao Supabase (mesmo formato)
let inflight = {};  // somas em envio agora (não somem se um pull acontecer no meio)

const sync = {
  hydrated: false, flushing: false, pulling: false,
  lastPullAt: null, lastFlushAt: null, lastPruneDay: '', seeded: false
};
let saveTimer = null;
let flushTimer = null;

/* ----------------------------- datas (sempre UTC) ----------------------------- */

const isoDay = (date) => date.toISOString().slice(0, 10);
const today = (now = new Date()) => isoDay(now);
const addDays = (day, n) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/** Vercels configuradas, sem repetição, na ordem em que foram escritas. */
function getPool() {
  const raw = [process.env.VIDSRC_PROXY_URLS, process.env.VIDSRC_PROXY_URL].filter(Boolean).join(',');
  const list = raw.split(/[\s,;]+/).map(normalizeBase).filter((item) => /^https?:\/\//i.test(item));
  return Array.from(new Set(list));
}

function quotaBytes() {
  const gb = Number(process.env.VERCEL_QUOTA_GB);
  return (Number.isFinite(gb) && gb > 0 ? gb : 100) * GB;
}

function fotQuotaBytes() {
  const gb = Number(process.env.VERCEL_FOT_QUOTA_GB);
  return (Number.isFinite(gb) && gb > 0 ? gb : 10) * GB;
}

/* ------------------ cota por Vercel: Edge (100 GB) ou função Node (10 GB) ------------------
 * O adproxy novo entrega o vídeo pelo Edge runtime (api/hls.js), que não gasta Fast Origin
 * Transfer; o antigo passa o vídeo pela função Node, que gasta FOT e FDT 1:1, e o FOT (10 GB)
 * trava primeiro. A Vercel nova responde `GET /vidsrc/hls?cap=1` com {"adproxy":"edge"}; a
 * antiga responde 400/404 ou HTML. Até saber, vale o limite conservador (10 GB). */
const CAP_REFRESH_MS = 10 * 60000;
const CAP_TIMEOUT_MS = 8000;
const capabilities = new Map(); // base -> { edge, checkedAt }

function isEdge(base) {
  const c = capabilities.get(base);
  return Boolean(c && c.edge);
}

/* ------------------ cota fixa por provedor (Wasmer, Deno, etc.) ------------------
 * VIDSRC_PROXY_QUOTAS="https://app.wasmer.app=150, https://outro.exemplo.dev=20"
 * Cada item é `URL=GB`. Quem aparece aqui tem a cota informada (pode passar de VERCEL_QUOTA_GB)
 * e NÃO passa pela classificação Edge/função Node, que só vale para Vercel. Quem não aparece
 * continua exatamente como antes. */
let quotaMapRaw = null;
let quotaMap = new Map();

function fixedQuotaMap() {
  const raw = String(process.env.VIDSRC_PROXY_QUOTAS || '');
  if (raw === quotaMapRaw) return quotaMap;
  const map = new Map();
  for (const token of raw.split(/[\s,;]+/)) {
    const eq = token.lastIndexOf('=');
    if (eq <= 0) continue;
    const url = normalizeBase(token.slice(0, eq)).toLowerCase();
    const gb = Number(token.slice(eq + 1));
    if (/^https?:\/\//.test(url) && Number.isFinite(gb) && gb > 0) map.set(url, gb);
  }
  quotaMapRaw = raw;
  quotaMap = map;
  return map;
}

/** Cota fixa (em GB) configurada para esta URL, ou 0 se não houver. */
function fixedQuotaGb(base) {
  return fixedQuotaMap().get(normalizeBase(base).toLowerCase()) || 0;
}

function quotaOf(base) {
  const fixed = fixedQuotaGb(base);
  if (fixed) return fixed * GB;
  const full = quotaBytes();
  return isEdge(base) ? full : Math.min(full, fotQuotaBytes());
}

async function probeCapability(base, fetchFn = fetch) {
  let edge;
  try {
    const res = await fetchFn(`${base}/vidsrc/hls?cap=1`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CAP_TIMEOUT_MS)
    });
    const data = await res.json().catch(() => null);
    edge = Boolean(res.ok && data && data.adproxy === 'edge');
  } catch (err) {
    return; // sem resposta agora (rede/cold start): mantém o que já se sabia
  }
  const before = capabilities.get(base);
  capabilities.set(base, { edge, checkedAt: Date.now() });
  if (!before || before.edge !== edge) {
    console.log(`[pool] ${label(base)}: ${edge ? 'Edge (cota ' + quotaBytes() / GB + ' GB)' : 'função Node (cota ' + Math.min(quotaBytes(), fotQuotaBytes()) / GB + ' GB: reenvie o kit para liberar o Edge)'}`);
  }
}

async function refreshCapabilities(fetchFn = fetch) {
  // Provedor com cota fixa não é Vercel: não há o que classificar.
  await Promise.all(getPool().filter((base) => !fixedQuotaGb(base)).map((base) => probeCapability(base, fetchFn)));
}

function startCapabilityProbe() {
  if (String(process.env.USAGE_CAPABILITY_PROBE || '') === '0') return;
  const first = setTimeout(() => refreshCapabilities().catch(() => {}), 0);
  const timer = setInterval(() => refreshCapabilities().catch(() => {}), CAP_REFRESH_MS);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
}

function resetDay() {
  const day = Math.floor(Number(process.env.USAGE_RESET_DAY));
  return Number.isFinite(day) && day >= 1 && day <= 28 ? day : 1;
}

/** Primeiro dia do ciclo atual (ex.: "2026-11-01"): muda quando passa o dia de renovação. */
function currentCycle(now = new Date()) {
  const day = resetDay();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
  if (now < start) start.setUTCMonth(start.getUTCMonth() - 1);
  return isoDay(start);
}

function daysUntilReset(now = new Date()) {
  const day = resetDay();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
  if (now >= next) next.setUTCMonth(next.getUTCMonth() + 1);
  return Math.max(0, Math.ceil((next - now) / DAY_MS));
}

/* ----------------------------- mapa dia/base ----------------------------- */

function cell(map, day, base) {
  if (!map[day]) map[day] = {};
  if (!map[day][base]) map[day][base] = { measured: 0, adjust: 0, seconds: 0, reports: 0 };
  return map[day][base];
}

function addTo(map, day, base, delta) {
  const c = cell(map, day, base);
  c.measured += delta.measured || 0;
  c.adjust += delta.adjust || 0;
  c.seconds += delta.seconds || 0;
  c.reports += delta.reports || 0;
}

function entriesOf(map) {
  const out = [];
  for (const day of Object.keys(map)) {
    for (const base of Object.keys(map[day])) out.push({ day, base, delta: map[day][base] });
  }
  return out;
}

const pendingCount = () => entriesOf(pending).length + entriesOf(inflight).length;

/** Soma `base` em [fromDay, toDay]. */
function sumRange(base, fromDay, toDay) {
  const acc = { measured: 0, adjust: 0, seconds: 0, reports: 0 };
  for (const day of Object.keys(state.daily)) {
    if (day < fromDay || day > toDay) continue;
    const c = state.daily[day][base];
    if (!c) continue;
    acc.measured += c.measured; acc.adjust += c.adjust; acc.seconds += c.seconds; acc.reports += c.reports;
  }
  return acc;
}

const cycleUsed = (base) => {
  const c = sumRange(base, currentCycle(), today());
  return c.measured + c.adjust;
};

/* ----------------------------- cache local ----------------------------- */

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && parsed.v === 2) {
      state.daily = parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : {};
      pending = parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {};
    } else if (parsed && parsed.bases && typeof parsed.bases === 'object') {
      // Arquivo antigo (um total por Vercel no ciclo): vira uma linha no 1º dia daquele ciclo.
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.cycle || '')) ? parsed.cycle : currentCycle();
      for (const base of Object.keys(parsed.bases)) {
        const old = parsed.bases[base] || {};
        const measured = Number(old.measuredBytes === undefined ? old.bytes : old.measuredBytes) || 0;
        addTo(state.daily, day, base, {
          measured, adjust: (Number(old.bytes) || 0) - measured,
          seconds: Number(old.seconds) || 0, reports: Number(old.reports) || 0
        });
      }
    }
  } catch (err) {
    // primeiro uso ou disco novo: começa do zero (o Supabase, se houver, repõe)
  }
  pruneMemory();
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(FILE, JSON.stringify({ v: 2, daily: state.daily, pending: mergeMaps(pending, inflight) }));
    } catch (err) {
      // disco somente leitura: segue em memória
    }
  }, 4000);
  if (saveTimer.unref) saveTimer.unref();
}

function mergeMaps(a, b) {
  const out = {};
  for (const e of [...entriesOf(a), ...entriesOf(b)]) addTo(out, e.day, e.base, e.delta);
  return out;
}

function pruneMemory() {
  const limit = addDays(today(), -KEEP_DAYS);
  for (const day of Object.keys(state.daily)) if (day < limit) delete state.daily[day];
}

/* ----------------------------- escrita ----------------------------- */

/** Soma bytes/segundos de vídeo entregues por uma Vercel da pool. */
function record(base, bytes, seconds) {
  const clean = normalizeBase(base);
  if (!getPool().includes(clean)) return { ok: false, error: 'base fora da pool' };
  const b = Math.floor(Number(bytes));
  if (!Number.isFinite(b) || b <= 0) return { ok: false, error: 'bytes inválido' };
  const delta = { measured: Math.min(b, MAX_REPORT_BYTES), reports: 1 };
  const s = Number(seconds);
  if (Number.isFinite(s) && s > 0) delta.seconds = Math.min(s, 6 * 3600);
  const day = today();
  addTo(state.daily, day, clean, delta);
  addTo(pending, day, clean, delta);
  scheduleSave();
  scheduleFlush();
  return { ok: true };
}

/** Acerta o contador do ciclo com o número real do painel da Vercel (lança um ajuste em hoje). */
function calibrate(base, usedGb) {
  const clean = normalizeBase(base);
  if (!getPool().includes(clean)) return { ok: false, error: 'base fora da pool' };
  const gb = Number(usedGb);
  if (!Number.isFinite(gb) || gb < 0) return { ok: false, error: 'usedGb inválido' };
  const delta = { adjust: Math.round(gb * GB) - cycleUsed(clean) };
  const day = today();
  addTo(state.daily, day, clean, delta);
  addTo(pending, day, clean, delta);
  scheduleSave();
  scheduleFlush();
  return { ok: true };
}

/* ----------------------------- Supabase ----------------------------- */

function scheduleFlush(delay = FLUSH_DELAY_MS) {
  if (!store.enabled() || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => { /* já registrado no status */ });
  }, delay);
  if (flushTimer.unref) flushTimer.unref();
}

/** Envia as somas pendentes. Se algo falhar, o que não foi enviado volta para a fila. */
async function flush() {
  if (!store.enabled() || sync.flushing) return { sent: 0 };
  const batch = entriesOf(pending);
  if (!batch.length) return { sent: 0 };
  sync.flushing = true;
  inflight = pending;
  pending = {};
  let sent = 0;
  try {
    for (const item of batch) {
      await store.addUsage(item.day, item.base, item.delta);
      delete inflight[item.day][item.base];
      sent += 1;
    }
    sync.lastFlushAt = Date.now();
    return { sent };
  } catch (err) {
    scheduleFlush(RETRY_DELAY_MS);
    throw err;
  } finally {
    pending = mergeMaps(pending, inflight); // o que sobrou volta
    inflight = {};
    sync.flushing = false;
    scheduleSave();
  }
}

/** Relê o histórico do Supabase (fonte da verdade) e reaplica o que ainda não foi enviado. */
async function pull() {
  if (!store.enabled() || sync.pulling) return { rows: 0 };
  sync.pulling = true;
  try {
    const since = addDays(today(), -HISTORY_DAYS);
    const rows = await store.fetchDaily(since);
    const fresh = {};
    for (const row of rows) {
      const base = normalizeBase(row.base);
      const day = String(row.day).slice(0, 10);
      addTo(fresh, day, base, {
        measured: Number(row.measured_bytes) || 0, adjust: Number(row.adjust_bytes) || 0,
        seconds: Number(row.seconds) || 0, reports: Number(row.reports) || 0
      });
    }
    // Banco recém-criado e vazio, mas há histórico local (arquivo antigo/sem Supabase até agora): semeia.
    if (!rows.length && !sync.seeded && entriesOf(state.daily).length) {
      // Só o que ainda NÃO está na fila (o que já está pendente seria contado duas vezes).
      const known = mergeMaps(pending, inflight);
      for (const e of entriesOf(state.daily)) {
        if (e.day < since) continue;
        const k = (known[e.day] && known[e.day][e.base]) || { measured: 0, adjust: 0, seconds: 0, reports: 0 };
        const rest = {
          measured: e.delta.measured - k.measured, adjust: e.delta.adjust - k.adjust,
          seconds: e.delta.seconds - k.seconds, reports: e.delta.reports - k.reports
        };
        if (rest.measured || rest.adjust || rest.seconds || rest.reports) addTo(pending, e.day, e.base, rest);
      }
      sync.seeded = true;
    }
    state.daily = mergeMaps(fresh, mergeMaps(pending, inflight));
    sync.hydrated = true;
    sync.lastPullAt = Date.now();
    pruneMemory();
    scheduleSave();
    // Manutenção: no máximo uma vez por dia, apaga o que passa de KEEP_DAYS (ignora falha).
    if (sync.lastPruneDay !== today()) {
      sync.lastPruneDay = today();
      store.pruneBefore(addDays(today(), -KEEP_DAYS)).catch(() => { /* melhor esforço */ });
    }
    return { rows: rows.length };
  } finally {
    sync.pulling = false;
  }
}

/** Botão "Sincronizar agora": envia o que falta, relê o banco e devolve o estado. */
async function syncNow() {
  let error = '';
  try {
    await flush();
    await pull();
  } catch (err) {
    error = err.message;
  }
  return { ok: !error, error, storage: storageStatus() };
}

function storageStatus() {
  const s = store.getStatus();
  return {
    provider: s.enabled ? 'supabase' : 'local',
    configured: s.enabled,
    ok: s.enabled ? Boolean(sync.hydrated && !s.lastError) : false,
    tablesMissing: s.tablesMissing,
    error: s.lastError || '',
    hydrated: sync.hydrated,
    lastPullAt: sync.lastPullAt,
    lastFlushAt: sync.lastFlushAt,
    pendingRows: pendingCount()
  };
}

function start() {
  startCapabilityProbe();
  if (!store.enabled()) return;
  const run = () => pull().then(() => flush()).catch(() => { /* status já guarda o erro */ });
  run();
  const timer = setInterval(run, PULL_EVERY_MS);
  if (timer.unref) timer.unref();
}

/* ----------------------------- leitura / estatísticas ----------------------------- */

function label(base) {
  try {
    const host = new URL(base).hostname.replace(/\.vercel\.app$/, '');
    return host;
  } catch (err) {
    return base;
  }
}

/**
 * Análise do histórico (últimos `days` dias, só o medido pelos navegadores).
 * Regras para não enganar quando há pouco dado:
 *  - média = bytes / dias desde o primeiro dado (não / 30), senão uma instalação nova "gasta pouco";
 *  - ritmo atual = média dos últimos 7 dias se há >= 3 dias de dado; senão a média geral;
 *  - previsão do ciclo = usado + ritmo atual * dias que faltam para renovar.
 */
function analytics(days = 30, now = new Date()) {
  const n = Math.max(1, Math.min(HISTORY_DAYS, Math.floor(Number(days)) || 30));
  const end = today(now);
  const start = addDays(end, -(n - 1));
  const pool = getPool();
  const quota = quotaBytes();

  const series = [];
  let firstDay = null;
  let secondsTotal = 0;
  let measuredTotal = 0;
  let peak = null;
  for (let i = 0; i < n; i += 1) {
    const day = addDays(start, i);
    const byBase = {};
    let total = 0;
    for (const base of pool) {
      const c = state.daily[day] && state.daily[day][base];
      if (!c) continue;
      byBase[base] = c.measured;
      total += c.measured;
      secondsTotal += c.seconds;
    }
    measuredTotal += total;
    if (total > 0 && !firstDay) firstDay = day;
    if (total > 0 && (!peak || total > peak.bytes)) peak = { day, bytes: total };
    series.push({ day, bytes: total, byBase });
  }

  const activeDays = firstDay ? Math.max(1, daysBetween(firstDay, end) + 1) : 0;
  const avgPerDay = activeDays ? measuredTotal / activeDays : 0;
  const last7 = series.slice(-7).reduce((sum, d) => sum + d.bytes, 0);
  const avg7 = activeDays ? last7 / Math.min(7, activeDays) : 0;
  const rate = activeDays >= 3 ? avg7 : avgPerDay;

  const used = pool.reduce((sum, base) => sum + cycleUsed(base), 0);
  const totalQuota = pool.reduce((sum, base) => sum + quotaOf(base), 0);
  const remaining = Math.max(0, totalQuota - used);
  const daysLeft = daysUntilReset(now);
  const projected = used + rate * daysLeft;
  const daysToExhaust = rate > 0 ? remaining / rate : null;
  const willExhaust = daysToExhaust !== null && daysToExhaust < daysLeft;
  const extraVercels = quota > 0 && projected > totalQuota ? Math.ceil((projected - totalQuota) / quota) : 0;

  return {
    days: n,
    from: start,
    to: end,
    activeDays,
    series,
    summary: {
      avgGbPerDay: round2(avgPerDay / GB),
      avgGbPerDay7: round2(avg7 / GB),
      rateGbPerDay: round2(rate / GB),
      last30Gb: round2(measuredTotal / GB),
      gbPerHour: secondsTotal > 600 ? round2(measuredTotal / GB / (secondsTotal / 3600)) : null,
      hoursWatched: round2(secondsTotal / 3600),
      peakDay: peak ? { day: peak.day, gb: round2(peak.bytes / GB) } : null,
      cycleStart: currentCycle(now),
      daysLeft,
      usedGb: round2(used / GB),
      remainingGb: round2(remaining / GB),
      projectedCycleGb: round2(projected / GB),
      totalQuotaGb: round2(totalQuota / GB),
      daysToExhaust: daysToExhaust === null ? null : Math.floor(daysToExhaust * 10) / 10,
      exhaustDate: daysToExhaust === null || !willExhaust ? null : addDays(end, Math.floor(daysToExhaust)),
      willExhaustBeforeReset: willExhaust,
      extraVercelsNeeded: extraVercels
    }
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Retrato do consumo: usado, restante, média e quantas horas de vídeo ainda cabem. */
function snapshot() {
  const daysLeft = daysUntilReset();
  const cycle = currentCycle();
  const daysElapsed = Math.max(1, daysBetween(cycle, today()) + 1);
  const winFrom = addDays(today(), -29);

  const pool = getPool().map((base) => {
    const used = cycleUsed(base);
    const quota = quotaOf(base);
    // Média real (GB por hora de vídeo): janela de 30 dias, para sobreviver à virada do ciclo.
    const win = sumRange(base, winFrom, today());
    const remaining = Math.max(0, quota - used);
    const gbPerHour = win.seconds > 600 ? (win.measured / GB) / (win.seconds / 3600) : DEFAULT_GB_PER_HOUR;
    return {
      base,
      label: label(base),
      edge: isEdge(base),
      fixed: Boolean(fixedQuotaGb(base)),
      tag: fixedQuotaGb(base) ? 'cota fixa' : (isEdge(base) ? 'Edge' : 'função Node'),
      usedBytes: used,
      quotaBytes: quota,
      remainingBytes: remaining,
      pct: Math.min(100, (used / quota) * 100),
      gbPerHour: Number(gbPerHour.toFixed(2)),
      gbPerHourMeasured: win.seconds > 600,
      hoursLeft: Number(((remaining / GB) / gbPerHour).toFixed(1)),
      gbPerDay: Number((used / GB / daysElapsed).toFixed(2)),
      reports: sumRange(base, cycle, today()).reports
    };
  });

  const totalUsed = pool.reduce((sum, p) => sum + p.usedBytes, 0);
  const totalQuota = pool.reduce((sum, p) => sum + p.quotaBytes, 0);
  const stats = analytics(30);
  return {
    cycleStart: cycle,
    daysLeft,
    quotaGb: quotaBytes() / GB,
    fotQuotaGb: fotQuotaBytes() / GB,
    pool,
    total: {
      usedBytes: totalUsed,
      quotaBytes: totalQuota,
      remainingBytes: Math.max(0, totalQuota - totalUsed),
      pct: totalQuota ? Math.min(100, (totalUsed / totalQuota) * 100) : 0,
      hoursLeft: Number(pool.reduce((sum, p) => sum + p.hoursLeft, 0).toFixed(1))
    },
    stats: stats.summary,
    storage: storageStatus(),
    note: 'Estimativa feita pelos navegadores que assistiram; confira o número real no painel da Vercel (Usage).'
  };
}

/**
 * Ordem para tentar as Vercels: a com MAIS cota sobrando primeiro (equilibra o
 * gasto). Esgotadas (>= 98%) só entram no fim, caso todas as outras falhem.
 */
function rankedPool() {
  return getPool()
    .map((base) => {
      const quota = quotaOf(base);
      const used = cycleUsed(base);
      // Ordena pela FOLGA (cota - usado), não pelo usado: uma Vercel Edge de 100 GB com 9 GB gastos
      // tem muito mais sobra do que uma função Node de 10 GB com 8 GB gastos.
      return { base, used, quota, free: quota - used, edge: isEdge(base) };
    })
    .sort((a, b) => {
      const exhaustedA = a.used >= a.quota * 0.98;
      const exhaustedB = b.used >= b.quota * 0.98;
      if (exhaustedA !== exhaustedB) return exhaustedA ? 1 : -1;
      return b.free - a.free || Math.random() - 0.5;
    })
    .map((item) => ({
      base: item.base,
      usedPct: Math.round((item.used / item.quota) * 1000) / 10,
      exhausted: item.used >= item.quota * 0.98,
      edge: item.edge
    }));
}

/** CSV do histórico (um dia por linha, GB por Vercel): para planilha. */
function toCsv(days = 90) {
  const a = analytics(days);
  const pool = getPool();
  const head = ['dia', 'total_gb', ...pool.map(label)];
  const lines = [head.join(',')];
  for (const d of a.series) {
    lines.push([d.day, round2(d.bytes / GB), ...pool.map((b) => round2((d.byBase[b] || 0) / GB))].join(','));
  }
  return lines.join('\n') + '\n';
}

load();
start();

module.exports = {
  getPool, record, calibrate, snapshot, rankedPool, normalizeBase,
  analytics, toCsv, syncNow, storageStatus, flush, pull,
  refreshCapabilities, isEdge, quotaOf, fixedQuotaGb
};
