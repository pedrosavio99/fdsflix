'use strict';

/**
 * Transcrição H.264 em HLS usando ffmpeg.
 *
 * O provedor só entrega HEVC (codecName: "hevc"). Chrome no Linux, Firefox e
 * a maioria dos Chromium não decodificam HEVC, então o vídeo precisar ser
 * convertido para H.264. O ffmpeg gera uma playlist HLS do tipo EVENT que
 * cresce enquanto o filme é convertido; o hls.js toca a partir do começo.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '.tmp-hls');
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS) || 2);
const IDLE_KILL_MS = 5 * 60 * 1000; // sem requisições por 5 min => mata
const DONE_KEEP_MS = 5 * 60 * 1000; // terminou => mantém 5 min para o player
const ERROR_KEEP_MS = 2 * 60 * 1000;
const START_TIMEOUT_MS = 60000;
const HLS_TIME = 4;

const sessions = new Map();

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
}

function hasFfmpeg() {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

function killProc(session) {
  if (!session.proc) return;
  session.stopping = true;
  try {
    if (!session.proc.killed) session.proc.kill('SIGKILL');
  } catch (err) {
    /* ignore */
  }
  session.proc = null;
}

function deleteDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    /* ignore */
  }
}

async function removeSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  killProc(session);
  deleteDir(session.dir);
}

function stopSession(id) {
  return removeSession(String(id || ''));
}

function getSession(id) {
  return sessions.get(String(id || '')) || null;
}

function touchSession(id) {
  const session = sessions.get(String(id || ''));
  if (session) session.lastAccess = Date.now();
}

function activeSessions() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    height: s.height,
    startAt: s.startAt,
    done: s.done,
    error: s.error,
    startedAt: s.startedAt,
    lastAccess: s.lastAccess
  }));
}

function buildArgs({ dir, source, height, startAt }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];

  if (startAt > 0) args.push('-ss', String(startAt));
  // Lê a entrada em tempo real: evita converter o filme inteiro de uma vez e
  // manter a CPU ocupada muito depois de o player ter sido fechado.
  args.push('-re', '-i', source);

  args.push(
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', `scale=-2:${height}`,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '26',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main',
    // força keyframe a cada HLS_TIME para o primeiro segmento ficar pronto rápido
    '-force_key_frames', `expr:gte(t,n_forced*${HLS_TIME})`,
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-f', 'hls',
    '-hls_time', String(HLS_TIME),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
    path.join(dir, 'index.m3u8')
  );

  return args;
}

function waitForPlaylist(session) {
  const playlist = path.join(session.dir, 'index.m3u8');
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (session.error) {
        return reject(new Error(session.error));
      }

      try {
        if (fs.existsSync(playlist)) {
          const content = fs.readFileSync(playlist, 'utf8');
          if (content.includes('#EXTINF')) return resolve();
        }
      } catch (err) {
        /* arquivo sendo reescrito, tenta de novo */
      }

      if (session.done) {
        return reject(new Error(session.error || 'O ffmpeg terminou antes de gerar a playlist'));
      }
      if (Date.now() - startedAt > START_TIMEOUT_MS) {
        return reject(new Error('Tempo esgotado aguardando o ffmpeg iniciar a conversão'));
      }

      setTimeout(tick, 250);
    };

    tick();
  });
}

/**
 * @param {{source: string, height?: number, startAt?: number}} options
 * @returns {Promise<{id: string, dir: string, height: number}>}
 */
async function startHlsSession({ source, height = 480, startAt = 0 }) {
  ensureRoot();

  // Limita quantas conversões rodam ao mesmo tempo (cada uma consome CPU).
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = Array.from(sessions.values()).sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!oldest) break;
    console.log(`[hls] limite de sessões atingido, encerrando ${oldest.id}`);
    await removeSession(oldest.id);
  }

  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });

  const args = buildArgs({ dir, source, height, startAt });
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  const session = {
    id,
    dir,
    height,
    startAt,
    source,
    proc,
    stderr: '',
    error: null,
    done: false,
    startedAt: Date.now(),
    finishedAt: 0,
    lastAccess: Date.now()
  };
  sessions.set(id, session);

  const collect = (chunk) => {
    session.stderr = (session.stderr + chunk.toString()).slice(-4000);
  };
  proc.stderr.on('data', collect);
  proc.stdout && proc.stdout.resume();

  proc.on('error', (err) => {
    session.error = `Não foi possível executar o ffmpeg: ${err.message}`;
    session.done = true;
    session.finishedAt = Date.now();
  });

  proc.on('close', (code) => {
    session.proc = null;
    session.done = true;
    session.finishedAt = Date.now();
    if (session.stopping) return; // encerrado por nós, não é falha
    if (code !== 0 && !session.error) {
      const tail = session.stderr.trim().split('\n').slice(-4).join(' | ');
      session.error = `ffmpeg terminou com código ${code}${tail ? ': ' + tail : ''}`;
      console.error(`[hls] ${id} falhou: ${session.error}`);
    } else {
      console.log(`[hls] ${id} concluído (${height}p)`);
    }
  });

  try {
    await waitForPlaylist(session);
  } catch (err) {
    await removeSession(id);
    throw err;
  }

  console.log(`[hls] ${id} pronto (${height}p, início ${startAt}s, altura original preservada)`);
  return { id, dir, height };
}

function cleanupTick() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    const idleSince = now - session.lastAccess;

    if (!session.done && idleSince > IDLE_KILL_MS) {
      console.log(`[hls] ${id} ocioso, encerrando`);
      removeSession(id);
      continue;
    }

    if (session.done) {
      const keep = session.error ? ERROR_KEEP_MS : DONE_KEEP_MS;
      if (now - Math.max(session.finishedAt, session.lastAccess) > keep) {
        removeSession(id);
      }
    }
  }
}

const cleanupTimer = setInterval(cleanupTick, 20000);
cleanupTimer.unref();

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const id of Array.from(sessions.keys())) {
    killProc(sessions.get(id));
  }
  sessions.clear();
  deleteDir(ROOT);
}

// Remove restos de execuções anteriores.
try {
  if (fs.existsSync(ROOT)) {
    for (const name of fs.readdirSync(ROOT)) {
      if (/^[a-f0-9]{16}$/.test(name)) deleteDir(path.join(ROOT, name));
    }
  }
} catch (err) {
  /* ignore */
}

module.exports = {
  startHlsSession,
  stopSession,
  getSession,
  touchSession,
  activeSessions,
  hasFfmpeg,
  shutdown,
  ROOT
};
