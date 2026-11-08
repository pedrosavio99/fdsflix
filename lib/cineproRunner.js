'use strict';

/**
 * Sobe o CinePro Core (https://github.com/cinepro-org/core) como processo filho,
 * dentro do mesmo contêiner do fdsFlix, escutando só em 127.0.0.1.
 *
 * - O código do CinePro NÃO fica neste repositório: o Dockerfile baixa um commit
 *   fixo e compila em /opt/cinepro (licença PolyForm Noncommercial; veja THIRD_PARTY.md).
 * - Sem /opt/cinepro/dist/server.js (rodando fora do Docker) este módulo não faz nada
 *   e o fdsFlix continua exatamente como antes.
 * - Desligue com CINEPRO_EMBEDDED=0 (ou aponte CINEPRO_API_BASE para um CinePro externo).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_QUICK_FAILURES = 5;
const QUICK_FAILURE_MS = 15000;

const state = {
  enabled: false,
  running: false,
  restarts: 0,
  giveUp: false,
  port: null,
  child: null,
  stopping: false
};

function getStatus() {
  return {
    enabled: state.enabled,
    running: state.running,
    restarts: state.restarts,
    giveUp: state.giveUp,
    port: state.port
  };
}

function resolveEntry(options = {}) {
  const dir = options.dir || process.env.CINEPRO_DIR || '/opt/cinepro';
  const entry = path.join(dir, 'dist', 'server.js');
  return { dir, entry, exists: fs.existsSync(entry) };
}

/**
 * @param {{dir?: string, port?: number, tmdbKey?: string, spawnFn?: Function, log?: Function}} [options]
 * @returns {{started: boolean, reason?: string, base?: string, stop: () => void}}
 */
function maybeStart(options = {}) {
  const log = options.log || ((...args) => console.log('[cinepro]', ...args));
  const noop = { started: false, stop() {} };

  if (process.env.CINEPRO_EMBEDDED === '0') return { ...noop, reason: 'desligado (CINEPRO_EMBEDDED=0)' };
  // Se o usuário apontou para um CinePro externo, não sobe um local.
  if (process.env.CINEPRO_API_BASE && !options.force) return { ...noop, reason: 'usando CINEPRO_API_BASE externo' };

  const { dir, entry, exists } = resolveEntry(options);
  if (!exists) return { ...noop, reason: `não instalado (${entry})` };

  const tmdbKey = options.tmdbKey || process.env.TMDB_API_KEY;
  if (!tmdbKey) return { ...noop, reason: 'TMDB_API_KEY ausente' };

  const port = Number(options.port || process.env.CINEPRO_PORT) || 3001;
  const spawnFn = options.spawnFn || spawn;
  const base = `http://127.0.0.1:${port}`;

  state.enabled = true;
  state.port = port;
  state.giveUp = false;
  state.stopping = false;

  // O fdsFlix passa a falar com a instância local.
  process.env.CINEPRO_API_BASE = base;

  let quickFailures = 0;
  const backoffBase = Number(options.backoffBaseMs) || 1000;

  function launch() {
    if (state.stopping) return;
    const startedAt = Date.now();

    const child = spawnFn(process.execPath, [entry], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(port),
        TMDB_API_KEY: tmdbKey,
        CACHE_TYPE: 'memory',
        CORS_ORIGIN: 'http://127.0.0.1',
        STREMIO_ADDON: 'false',
        MCP_ENABLED: 'false',
        INTERNAL_DEBUG: 'false',
        // Hosts pequenos (Render Free = 512 MB): limita o heap do CinePro.
        NODE_OPTIONS: process.env.CINEPRO_NODE_OPTIONS || '--max-old-space-size=192'
      }
    });

    state.child = child;
    state.running = true;
    log(`iniciado (pid ${child.pid}) em ${base}`);

    const forward = (chunk) => {
      const text = String(chunk).trim();
      if (text) log(text.split('\n').slice(-1)[0].slice(0, 200));
    };
    if (child.stdout) child.stdout.on('data', forward);
    if (child.stderr) child.stderr.on('data', forward);

    child.on('error', (err) => {
      state.running = false;
      log('falha ao iniciar:', err.message);
    });

    child.on('exit', (code, signal) => {
      state.running = false;
      state.child = null;
      if (state.stopping) return;

      if (Date.now() - startedAt < QUICK_FAILURE_MS) quickFailures += 1;
      else quickFailures = 0;

      if (quickFailures >= MAX_QUICK_FAILURES) {
        state.giveUp = true;
        log(`caiu ${quickFailures}x seguidas logo ao iniciar; desisti (o resto do fdsFlix segue normal).`);
        return;
      }

      state.restarts += 1;
      const delay = Math.min(30000, backoffBase * 2 ** Math.min(quickFailures, 5));
      log(`saiu (code=${code} signal=${signal}); reiniciando em ${Math.round(delay / 100) / 10}s`);
      setTimeout(launch, delay).unref();
    });
  }

  launch();

  return {
    started: true,
    base,
    stop() {
      state.stopping = true;
      if (state.child) {
        try { state.child.kill('SIGTERM'); } catch (err) { /* ignore */ }
      }
    }
  };
}

module.exports = { maybeStart, getStatus, resolveEntry };
