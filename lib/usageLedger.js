'use strict';

/**
 * fdsFlix - Contador de consumo das Vercels (pool do Vidsrc).
 *
 * A Vercel não deixa a função saber quanto da cota do mês já foi gasto, e cada
 * requisição pode cair numa instância diferente (não dá para somar em memória lá).
 * Quem sabe quantos bytes chegaram é o navegador (hls.js): ele manda o total para
 * cá a cada ~20 s e ao fechar a aba. Aqui somamos por Vercel e por ciclo.
 *
 * É uma ESTIMATIVA: não vê quem fechou a aba sem enviar, e no Render gratuito o
 * disco é apagado quando o serviço reinicia (use /api/usage/calibrate para
 * acertar o número com o painel da Vercel).
 *
 * Variáveis (todas opcionais):
 *   VIDSRC_PROXY_URLS   lista de Vercels separadas por vírgula/espaço (pool)
 *   VIDSRC_PROXY_URL    uma Vercel só (continua valendo)
 *   VERCEL_QUOTA_GB     cota mensal de cada Vercel (padrão 100, plano Hobby)
 *   USAGE_RESET_DAY     dia do mês em que a cota renova (padrão 1)
 *   USAGE_FILE          onde guardar o contador (padrão ./.usage.json)
 */

const fs = require('fs');
const path = require('path');

const GB = 1024 ** 3;
const MAX_REPORT_BYTES = 600 * 1024 * 1024; // teto por envio: evita número absurdo
const DEFAULT_GB_PER_HOUR = 2.2;            // 1080p ≈ 6 Mbps, até haver média real
const FILE = path.resolve(process.env.USAGE_FILE || path.join(__dirname, '..', '.usage.json'));

const state = { cycle: '', bases: {} };
let saveTimer = null;

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

function resetDay() {
  const day = Math.floor(Number(process.env.USAGE_RESET_DAY));
  return Number.isFinite(day) && day >= 1 && day <= 28 ? day : 1;
}

/** Identifica o ciclo atual (ex.: "2026-11-01"): muda quando passa o dia de renovação. */
function currentCycle(now = new Date()) {
  const day = resetDay();
  const start = new Date(now.getFullYear(), now.getMonth(), day);
  if (now < start) start.setMonth(start.getMonth() - 1);
  return start.toISOString().slice(0, 10);
}

function daysUntilReset(now = new Date()) {
  const day = resetDay();
  const next = new Date(now.getFullYear(), now.getMonth(), day);
  if (now >= next) next.setMonth(next.getMonth() + 1);
  return Math.max(0, Math.ceil((next - now) / 86400000));
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      state.cycle = String(parsed.cycle || '');
      state.bases = parsed.bases && typeof parsed.bases === 'object' ? parsed.bases : {};
    }
  } catch (err) {
    // primeiro uso ou disco novo: começa do zero
  }
  rollover();
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(FILE, JSON.stringify(state));
    } catch (err) {
      // disco somente leitura: segue só em memória
    }
  }, 4000);
  if (saveTimer.unref) saveTimer.unref();
}

function rollover() {
  const cycle = currentCycle();
  if (state.cycle !== cycle) {
    state.cycle = cycle;
    state.bases = {};
    scheduleSave();
  }
}

function entry(base) {
  if (!state.bases[base]) state.bases[base] = { bytes: 0, seconds: 0, measuredBytes: 0, reports: 0 };
  // Ledgers antigos não têm measuredBytes: usa o que havia.
  if (state.bases[base].measuredBytes === undefined) state.bases[base].measuredBytes = state.bases[base].bytes;
  return state.bases[base];
}

/** Soma bytes/segundos de vídeo entregues por uma Vercel da pool. */
function record(base, bytes, seconds) {
  const clean = normalizeBase(base);
  if (!getPool().includes(clean)) return { ok: false, error: 'base fora da pool' };
  const b = Math.floor(Number(bytes));
  if (!Number.isFinite(b) || b <= 0) return { ok: false, error: 'bytes inválido' };
  rollover();
  const item = entry(clean);
  const counted = Math.min(b, MAX_REPORT_BYTES);
  item.bytes += counted;
  item.measuredBytes += counted; // base da média: a calibração não mexe aqui
  const s = Number(seconds);
  if (Number.isFinite(s) && s > 0) item.seconds += Math.min(s, 6 * 3600);
  item.reports += 1;
  scheduleSave();
  return { ok: true };
}

/** Acerta o contador com o número real do painel da Vercel. */
function calibrate(base, usedGb) {
  const clean = normalizeBase(base);
  if (!getPool().includes(clean)) return { ok: false, error: 'base fora da pool' };
  const gb = Number(usedGb);
  if (!Number.isFinite(gb) || gb < 0) return { ok: false, error: 'usedGb inválido' };
  rollover();
  entry(clean).bytes = Math.round(gb * GB);
  scheduleSave();
  return { ok: true };
}

function label(base) {
  try {
    const host = new URL(base).hostname.replace(/\.vercel\.app$/, '');
    return host;
  } catch (err) {
    return base;
  }
}

/** Retrato do consumo: usado, restante, média e quantas horas de vídeo ainda cabem. */
function snapshot() {
  rollover();
  const quota = quotaBytes();
  const daysLeft = daysUntilReset();
  const cycleStart = new Date(state.cycle + 'T00:00:00');
  const daysElapsed = Math.max(1, Math.ceil((Date.now() - cycleStart.getTime()) / 86400000));

  const pool = getPool().map((base) => {
    const item = state.bases[base] || { bytes: 0, seconds: 0, measuredBytes: 0, reports: 0 };
    const measured = item.measuredBytes === undefined ? item.bytes : item.measuredBytes;
    const used = item.bytes;
    const remaining = Math.max(0, quota - used);
    // Média real (bytes por hora de vídeo assistido); sem dados, assume 1080p.
    const gbPerHour = item.seconds > 600 ? (measured / GB) / (item.seconds / 3600) : DEFAULT_GB_PER_HOUR;
    return {
      base,
      label: label(base),
      usedBytes: used,
      quotaBytes: quota,
      remainingBytes: remaining,
      pct: Math.min(100, (used / quota) * 100),
      gbPerHour: Number(gbPerHour.toFixed(2)),
      gbPerHourMeasured: item.seconds > 600,
      hoursLeft: Number(((remaining / GB) / gbPerHour).toFixed(1)),
      gbPerDay: Number((used / GB / daysElapsed).toFixed(2)),
      reports: item.reports
    };
  });

  const totalUsed = pool.reduce((sum, p) => sum + p.usedBytes, 0);
  const totalQuota = quota * pool.length;
  return {
    cycleStart: state.cycle,
    daysLeft,
    quotaGb: quota / GB,
    pool,
    total: {
      usedBytes: totalUsed,
      quotaBytes: totalQuota,
      remainingBytes: Math.max(0, totalQuota - totalUsed),
      pct: totalQuota ? Math.min(100, (totalUsed / totalQuota) * 100) : 0,
      hoursLeft: Number(pool.reduce((sum, p) => sum + p.hoursLeft, 0).toFixed(1))
    },
    note: 'Estimativa feita pelos navegadores que assistiram; confira o número real no painel da Vercel (Usage).'
  };
}

/**
 * Ordem para tentar as Vercels: a com MAIS cota sobrando primeiro (equilibra o
 * gasto). Esgotadas (>= 98%) só entram no fim, caso todas as outras falhem.
 */
function rankedPool() {
  rollover();
  const quota = quotaBytes();
  return getPool()
    .map((base) => ({ base, used: (state.bases[base] || { bytes: 0 }).bytes }))
    .sort((a, b) => {
      const exhaustedA = a.used >= quota * 0.98;
      const exhaustedB = b.used >= quota * 0.98;
      if (exhaustedA !== exhaustedB) return exhaustedA ? 1 : -1;
      return a.used - b.used || Math.random() - 0.5;
    })
    .map((item) => ({ base: item.base, usedPct: Math.round((item.used / quota) * 1000) / 10, exhausted: item.used >= quota * 0.98 }));
}

load();

module.exports = { getPool, record, calibrate, snapshot, rankedPool, normalizeBase };
