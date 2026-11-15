'use strict';

/**
 * Monitor de carga (só para o administrador: GET /api/admin/load). Responde, na hora, a pergunta
 * "o servidor está aguentando?" com números reais em vez de estimativa:
 *
 *   - quem está online (visitantes vistos no último minuto: cada aba aberta fala com a API a cada ~45 s) e quem está assistindo;
 *   - CPU em % do LIMITE do contêiner (no Render Free o limite é 0,1 CPU; lido do cgroup, sem variável de ambiente),
 *     inclusive a do CinePro (processo filho) e quanto o Render está segurando ("throttle");
 *   - atraso do servidor (event loop): é o primeiro sinal de que a CPU acabou;
 *   - memória do contêiner contra o limite (512 MB), com a parte do CinePro;
 *   - o /api/stream: plays por minuto, tempo (p50/p95), falhas, fila e pedidos juntados pelo streamGuard;
 *   - alertas em português (verde / amarelo / vermelho) e uma projeção de quantos online a CPU aguenta com esse perfil.
 *
 * Tudo fica em memória (histórico de ~30 min, uma amostra a cada 5 s). Custo por requisição: algumas operações em Map.
 * Nada aqui é enviado ao público nem derruba o site: qualquer erro de leitura vira "desconhecido".
 */

const fs = require('fs');
const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');

const SAMPLE_MS = 5000;
const LAG_FLOOR_MS = 20;        // = resolution do monitorEventLoopDelay
const KEEP = 360;                 // 30 min
const ONLINE_MS = 60 * 1000;      // aba aberta fala com a API a cada ~45 s (portão do site)
const ONLINE_WIDE_MS = 5 * 60 * 1000;
const WATCH_MS = 3 * 60 * 60 * 1000;
const MAX_VISITORS = 50000;
const MAX_DURATIONS = 400;
const EXCLUDED = ['/api/health', '/api/admin', '/api/egress', '/api/usage', '/api/visitors', '/api/diag', '/api/debug'];

const num = (v) => { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

function readText(read, file) {
  try { return String(read(file, 'utf8')).trim(); } catch (err) { return ''; }
}

/** Limites do contêiner (cgroup v2, depois v1). Sem cgroup: usa a máquina inteira. */
function readLimits(read = fs.readFileSync, machine = { cpus: os.cpus().length, mem: os.totalmem() }) {
  let cores = null; let cpuSource = '';
  const v2 = readText(read, '/sys/fs/cgroup/cpu.max').split(/\s+/);
  if (v2[0] && v2[0] !== 'max' && num(v2[0]) > 0 && num(v2[1]) > 0) { cores = num(v2[0]) / num(v2[1]); cpuSource = 'cgroup'; }
  if (cores == null) {
    const quota = num(readText(read, '/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
    const period = num(readText(read, '/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
    if (quota > 0 && period > 0) { cores = quota / period; cpuSource = 'cgroup'; }
  }
  if (cores == null) { cores = machine.cpus || 1; cpuSource = 'máquina'; }

  let mem = null; let memSource = '';
  const m2 = readText(read, '/sys/fs/cgroup/memory.max');
  if (m2 && m2 !== 'max' && num(m2) > 0) { mem = num(m2); memSource = 'cgroup'; }
  if (mem == null) {
    const m1 = num(readText(read, '/sys/fs/cgroup/memory/memory.limit_in_bytes'));
    if (m1 > 0 && m1 < 2 ** 50) { mem = m1; memSource = 'cgroup'; }
  }
  if (mem == null) { mem = machine.mem || null; memSource = 'máquina'; }
  return { cores, cpuSource, memBytes: mem, memSource };
}

/** Uso atual do contêiner: memória e "throttle" (tempo que o Render segurou o processo por falta de CPU). */
function readContainer(read = fs.readFileSync) {
  const out = { memBytes: null, throttledUs: null, throttledCount: null };
  out.memBytes = num(readText(read, '/sys/fs/cgroup/memory.current')) ?? num(readText(read, '/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  const stat = readText(read, '/sys/fs/cgroup/cpu.stat') || readText(read, '/sys/fs/cgroup/cpu/cpu.stat');
  if (stat) {
    for (const line of stat.split('\n')) {
      const [k, v] = line.trim().split(/\s+/);
      if (k === 'throttled_usec') out.throttledUs = num(v);
      else if (k === 'throttled_time') out.throttledUs = num(v) == null ? null : num(v) / 1000; // v1: ns
      else if (k === 'nr_throttled') out.throttledCount = num(v);
    }
  }
  return out;
}

/** CPU (segundos) e memória (bytes) de um processo filho, via /proc. Sem /proc ou sem pid: null. */
function readProc(pid, read = fs.readFileSync) {
  if (!pid) return null;
  try {
    const stat = String(read(`/proc/${pid}/stat`, 'utf8'));
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // depois de "pid (comm) "
    const ticks = (num(fields[11]) || 0) + (num(fields[12]) || 0);   // utime + stime
    const status = String(read(`/proc/${pid}/status`, 'utf8'));
    const rss = /VmRSS:\s+(\d+)\s*kB/.exec(status);
    return { cpuSec: ticks / 100, rssBytes: rss ? Number(rss[1]) * 1024 : null };
  } catch (err) {
    return null;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const LEVEL_RANK = { ok: 0, warn: 1, bad: 2 };

/** Regras dos alertas. Pura (testável): recebe o resumo atual e devolve { level, items }. */
function evaluate(cur) {
  const items = [];
  const add = (level, title, detail) => items.push({ level, title, detail });

  if (cur.cpuPct != null) {
    if (cur.cpuPct >= 90) add('bad', `CPU no limite (${Math.round(cur.cpuPct)}%)`, 'O servidor está usando quase toda a CPU que o plano dá. Pedidos novos vão demorar. Se continuar, é hora de subir de plano ou tirar carga do Render.');
    else if (cur.cpuPct >= 70) add('warn', `CPU alta (${Math.round(cur.cpuPct)}%)`, 'Ainda dá conta, mas com pouca folga. Se mais gente entrar, vai apertar.');
  }
  if (cur.throttledPct != null) {
    if (cur.throttledPct >= 50) add('bad', `Render segurando o servidor (${Math.round(cur.throttledPct)}% do tempo)`, 'O plano está limitando a CPU: o servidor para de rodar por falta de CPU. É o sinal mais claro de saturação.');
    else if (cur.throttledPct >= 20) add('warn', `Render começou a segurar o servidor (${Math.round(cur.throttledPct)}%)`, 'A CPU do plano está acabando em alguns momentos.');
  }
  if (cur.lagP99Ms != null) {
    if (cur.lagP99Ms >= 600) add('bad', `Servidor travando (atraso ${Math.round(cur.lagP99Ms)} ms)`, 'O servidor está demorando para atender até pedidos simples. O usuário já percebe lentidão.');
    else if (cur.lagP99Ms >= 200) add('warn', `Servidor com atraso (${Math.round(cur.lagP99Ms)} ms)`, 'Primeiro sinal de que o processador está sobrecarregado.');
  }
  if (cur.memPct != null) {
    if (cur.memPct >= 90) add('bad', `Memória quase cheia (${Math.round(cur.memPct)}%)`, 'Risco de o Render reiniciar o servidor por falta de memória (derruba quem está assistindo a busca/legenda).');
    else if (cur.memPct >= 75) add('warn', `Memória alta (${Math.round(cur.memPct)}%)`, 'Acompanhe: se continuar subindo, pode reiniciar.');
  }
  if (cur.streamP95Ms != null && cur.streamN60 >= 3) {
    if (cur.streamP95Ms >= 15000) add('bad', `Abrir filme está muito lento (p95 ${(cur.streamP95Ms / 1000).toFixed(1)} s)`, 'Quem aperta play espera muito. Normalmente é fonte caindo ou servidor sobrecarregado.');
    else if (cur.streamP95Ms >= 6000) add('warn', `Abrir filme está lento (p95 ${(cur.streamP95Ms / 1000).toFixed(1)} s)`, 'Mais lento que o normal (costuma ser 1 a 3 s).');
  }
  if (cur.streamN60 >= 5 && cur.streamFailPct != null) {
    if (cur.streamFailPct >= 50) add('bad', `Metade dos plays está falhando (${Math.round(cur.streamFailPct)}%)`, 'As fontes de vídeo podem ter caído ou o servidor não está dando conta. Veja o Diagnóstico de um filme.');
    else if (cur.streamFailPct >= 20) add('warn', `Plays falhando (${Math.round(cur.streamFailPct)}%)`, 'Acima do normal no último minuto.');
  }
  if (cur.guard) {
    if (cur.guard.waiting >= 15) add('bad', `Fila de buscas de filme: ${cur.guard.waiting} esperando`, 'Muitas buscas simultâneas e lentas: as fontes estão demorando.');
    else if (cur.guard.waiting >= 1) add('warn', `Fila de buscas de filme: ${cur.guard.waiting} esperando`, 'Mais de 30 buscas ao mesmo tempo: o excedente espera na fila.');
    if (cur.guard.queueTimeoutsLastMin > 0) add('warn', 'Buscas esperaram o máximo na fila', 'Alguém esperou 30 s e foi atendido mesmo assim; o servidor está sobrecarregado.');
  }
  if (cur.breaker && cur.breaker.open) add('warn', 'Vidsrc em disjuntor', `A fonte principal falhou em sequência e foi pulada por um tempo (${cur.breaker.reason || 'motivo desconhecido'}). Os filmes estão saindo por outras fontes.`);

  let level = 'ok';
  for (const it of items) if (LEVEL_RANK[it.level] > LEVEL_RANK[level]) level = it.level;
  items.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  return { level, items };
}

function createLoadMonitor(deps = {}) {
  const now = deps.now || Date.now;
  const read = deps.read || fs.readFileSync;
  const getGuard = deps.getGuard || (() => null);
  const getBreaker = deps.getBreaker || (() => null);
  const getChildPid = deps.getChildPid || (() => null);
  const isBot = deps.isBot || (() => false);
  const visitorOf = deps.visitorOf || ((req) => String(req.ip || (req.socket && req.socket.remoteAddress) || ''));

  const limits = readLimits(read, deps.machine);
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const seen = new Map();   // visitante -> último sinal
  const played = new Map(); // visitante -> último play que deu certo
  let bucket = newBucket();
  const series = [];
  let last = { at: now(), cpuUs: process.cpuUsage(), child: readProc(getChildPid(), read), container: readContainer(read) };
  let guardPrev = { timeouts: 0, at: now() };
  let timer = null;
  let lastLevel = 'ok';
  const startedAt = now();

  function newBucket() { return { total: 0, api: 0, streamOk: 0, streamErr: 0, streamDur: [], err5xx: 0 }; }

  /** Express: conta a requisição quando ela termina. Não mexe na resposta. */
  function middleware(req, res, next) {
    let done = false;
    const t0 = process.hrtime.bigint();
    const finish = () => {
      if (done) return;
      done = true;
      try {
        const path = String(req.path || req.url || '/');
        if (EXCLUDED.some((p) => path === p || path.startsWith(p + '/'))) return;
        const status = res.statusCode || 0;
        bucket.total += 1;
        if (path.startsWith('/api/')) bucket.api += 1;
        if (status >= 500) bucket.err5xx += 1;
        const admin = Boolean(req.headers && req.headers['x-stats-key']);
        if (!admin && !isBot(req.headers && req.headers['user-agent'])) {
          const id = visitorOf(req);
          if (id) {
            const t = now();
            seen.set(id, t);
            if (path === '/api/stream' && status === 200) played.set(id, t);
          }
        }
        if (path === '/api/stream') {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          if (status >= 500) bucket.streamErr += 1; else if (status === 200) bucket.streamOk += 1;
          if (status === 200 || status >= 500) {
            bucket.streamDur.push(ms);
            if (bucket.streamDur.length > MAX_DURATIONS) bucket.streamDur.shift();
          }
        }
      } catch (err) { /* estatística nunca derruba o site */ }
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  }

  function prune(t) {
    for (const [id, at] of seen) if (t - at > ONLINE_WIDE_MS) seen.delete(id);
    for (const [id, at] of played) if (t - at > WATCH_MS) played.delete(id);
    while (seen.size > MAX_VISITORS) seen.delete(seen.keys().next().value);
    while (played.size > MAX_VISITORS) played.delete(played.keys().next().value);
  }

  function counts(t) {
    let online = 0; let wide = 0; let watching = 0;
    for (const [id, at] of seen) {
      const age = t - at;
      if (age <= ONLINE_WIDE_MS) wide += 1;
      if (age <= ONLINE_MS) {
        online += 1;
        const p = played.get(id);
        if (p && t - p <= WATCH_MS) watching += 1;
      }
    }
    return { online, wide, watching };
  }

  function sample() {
    const t = now();
    const wallUs = Math.max(1, (t - last.at) * 1000);
    const cpu = process.cpuUsage();
    let cpuSec = ((cpu.user + cpu.system) - (last.cpuUs.user + last.cpuUs.system)) / 1e6;
    const childNow = readProc(getChildPid(), read);
    let childCpuSec = 0;
    if (childNow && last.child) childCpuSec = Math.max(0, childNow.cpuSec - last.child.cpuSec);
    cpuSec += childCpuSec;
    const cores = cpuSec / (wallUs / 1e6);
    const cpuPct = limits.cores > 0 ? (cores / limits.cores) * 100 : null;

    const container = readContainer(read);
    let throttledPct = null;
    if (container.throttledUs != null && last.container.throttledUs != null) {
      throttledPct = Math.min(100, Math.max(0, ((container.throttledUs - last.container.throttledUs) / wallUs) * 100));
    }
    const mem = process.memoryUsage();
    const memUsed = container.memBytes != null ? container.memBytes : mem.rss + (childNow && childNow.rssBytes ? childNow.rssBytes : 0);
    const memPct = limits.memBytes ? (memUsed / limits.memBytes) * 100 : null;

    // O medidor do Node inclui o próprio intervalo de amostragem (20 ms) no valor: ocioso ele já marca ~20 ms. Descontamos esse piso.
    const lagP99 = histogram.count ? Math.max(0, histogram.percentile(99) / 1e6 - LAG_FLOOR_MS) : 0;
    const lagMax = histogram.count ? Math.max(0, histogram.max / 1e6 - LAG_FLOOR_MS) : 0;
    histogram.reset();

    prune(t);
    const c = counts(t);
    const guard = getGuard();
    const breaker = getBreaker();
    const timeouts = guard ? guard.queueTimeouts || 0 : 0;

    const s = {
      t, cpuPct, cores, throttledPct, lagP99Ms: lagP99, lagMaxMs: lagMax,
      rssMB: mem.rss / 1048576, heapMB: mem.heapUsed / 1048576,
      childRssMB: childNow && childNow.rssBytes ? childNow.rssBytes / 1048576 : null,
      memMB: memUsed / 1048576, memPct,
      online: c.online, online5: c.wide, watching: c.watching,
      rps: bucket.total / (wallUs / 1e6),
      plays: bucket.streamOk, playErrors: bucket.streamErr, err5xx: bucket.err5xx,
      streamDur: bucket.streamDur, guardWaiting: guard ? guard.waiting : 0,
      queueTimeoutsDelta: Math.max(0, timeouts - guardPrev.timeouts)
    };
    series.push(s);
    while (series.length > KEEP) series.shift();
    for (let i = 0; i < series.length - 12; i += 1) if (series[i].streamDur) series[i].streamDur = null; // só os últimos 60 s precisam das durações

    bucket = newBucket();
    last = { at: t, cpuUs: cpu, child: childNow, container };
    guardPrev = { timeouts, at: t };

    const cur = current();
    if (cur.level !== lastLevel) {
      const worse = LEVEL_RANK[cur.level] > LEVEL_RANK[lastLevel];
      lastLevel = cur.level;
      try { console.log(`[carga] ${cur.level === 'ok' ? 'normalizou' : (cur.level === 'warn' ? 'ATENÇÃO' : 'CRÍTICO')}${worse || cur.level === 'ok' ? ': ' : ' (melhorou): '}${cur.alerts.map((a) => a.title).join(' · ') || 'tudo certo'}`); } catch (err) { /* log não é crítico */ }
    }
  }

  const avg = (arr, key) => {
    const v = arr.map((x) => x[key]).filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  /** Resumo atual: médias das últimas amostras (30 s para CPU/atraso/memória, 60 s para o /api/stream). */
  function current() {
    const t = now();
    const recent = series.slice(-6);
    const minute = series.slice(-12);
    const last1 = series[series.length - 1] || null;
    const durs = [];
    let ok = 0; let err = 0;
    for (const s of minute) { ok += s.plays; err += s.playErrors; if (s.streamDur) durs.push(...s.streamDur); }
    durs.sort((a, b) => a - b);
    const guard = getGuard();
    const breaker = getBreaker();
    const cur = {
      at: t,
      cpuPct: avg(recent, 'cpuPct'),
      cores: avg(recent, 'cores'),
      throttledPct: avg(recent, 'throttledPct'),
      lagP99Ms: recent.length ? Math.max(...recent.map((s) => s.lagP99Ms || 0)) : null,
      lagMaxMs: recent.length ? Math.max(...recent.map((s) => s.lagMaxMs || 0)) : null,
      memPct: last1 ? last1.memPct : null,
      memMB: last1 ? last1.memMB : null,
      rssMB: last1 ? last1.rssMB : null,
      childRssMB: last1 ? last1.childRssMB : null,
      online: last1 ? last1.online : 0,
      online5: last1 ? last1.online5 : 0,
      watching: last1 ? last1.watching : 0,
      rps: avg(recent, 'rps'),
      playsPerMin: ok,
      streamN60: ok + err,
      streamP50Ms: percentile(durs, 50),
      streamP95Ms: percentile(durs, 95),
      streamFailPct: ok + err ? (err / (ok + err)) * 100 : null,
      guard: guard ? { ...guard, queueTimeoutsLastMin: minute.reduce((a, s) => a + s.queueTimeoutsDelta, 0) } : null,
      breaker: breaker ? { open: Boolean(breaker.open), reason: breaker.reason || '' } : null
    };
    // Projeção: com o perfil de CPU de agora, quantos online o limite de CPU aguentaria (até 80% do limite).
    cur.projectedMaxOnline = null;
    const per = cur.online >= 8 && cur.cores != null && cur.cores > 0.002 ? cur.cores / cur.online : null;
    if (per && limits.cores > 0) cur.projectedMaxOnline = Math.max(cur.online, Math.round((limits.cores * 0.8) / per));
    const ev = evaluate(cur);
    cur.level = ev.level;
    cur.alerts = ev.items;
    return cur;
  }

  function snapshot({ lite = false } = {}) {
    const cur = current();
    const out = {
      now: now(), startedAt, sampleMs: SAMPLE_MS, limits: { cpuCores: limits.cores, cpuSource: limits.cpuSource, memMB: limits.memBytes ? limits.memBytes / 1048576 : null, memSource: limits.memSource },
      current: cur
    };
    if (!lite) {
      const pick = (key) => series.map((s) => (s[key] == null ? null : Math.round(s[key] * 10) / 10));
      out.series = {
        t: series.map((s) => s.t), cpuPct: pick('cpuPct'), lagP99Ms: pick('lagP99Ms'), memMB: pick('memMB'),
        online: pick('online'), watching: pick('watching'), plays: pick('plays'), rps: pick('rps'), throttledPct: pick('throttledPct')
      };
    }
    return out;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { try { sample(); } catch (err) { /* nunca derruba o site */ } }, SAMPLE_MS);
    if (timer.unref) timer.unref();
  }

  function stop() { if (timer) clearInterval(timer); timer = null; histogram.disable(); }

  return { middleware, snapshot, start, stop, sample, current, limits, _series: series };
}

module.exports = { createLoadMonitor, evaluate, readLimits, readContainer, readProc, percentile };
