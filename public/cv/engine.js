/**
 * Motor do player "canvas": toca HEVC em QUALQUER navegador moderno, decodificando no aparelho de quem assiste.
 *
 *   Worker/CDN ──Range──▶ mp4box.js ─┬─ áudio (AAC) ──▶ MediaSource ──▶ <video> escondido  = RELÓGIO e som
 *                                    └─ vídeo (HEVC) ─▶ Worker (WebAssembly) ─▶ quadros YUV ─▶ <canvas> (WebGL)
 *
 * O áudio manda no tempo: o canvas mostra o quadro cujo instante é o `currentTime` do <video>. Se a
 * decodificação atrasa, o áudio é pausado ("buffering") e volta quando há imagem à frente — nunca
 * fica som sem imagem. Só o arquivo original (HEVC pequeno) trafega, e só o que foi assistido + ~40 s.
 *
 * Nada aqui depende do codificador H.264 do navegador (WebCodecs): só WebAssembly, Worker, MediaSource e canvas.
 */

import { createFile } from 'mp4box';
import { YuvRenderer } from './render.js';

const PROBE_SIZES = [2 * 1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024];
const CHUNK = 1024 * 1024;         // ~28 s de vídeo em 480p; poucas requisições ao Worker
const AHEAD_TARGET_S = 40;         // quanto baixar à frente (limita a banda)
const BACK_KEEP_S = 20;
const SEG_SECONDS = 4;
const RESUME_AHEAD_S = 0.7;        // quanto de imagem decodificada exigir para voltar de uma pausa
const MAX_QUEUE_SEGS = 6;

const nativePlay = HTMLMediaElement.prototype.play;
const nativePause = HTMLMediaElement.prototype.pause;

const log = (...a) => { if (window.__FDSFLIX_DEBUG__) console.log('[cv]', ...a); };
const once = (target, type) => new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));

/** Este navegador consegue rodar o motor? (não testa HEVC: o motor não usa o decodificador nativo) */
export function canvasPlayerSupported() {
  try {
    if (typeof WebAssembly !== 'object' || typeof Worker !== 'function') return false;
    if (!window.MediaSource || !MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')) return false;
    const c = document.createElement('canvas');
    return Boolean(c.getContext('2d'));
  } catch (e) {
    return false;
  }
}

/**
 * @param {HTMLVideoElement} video  elemento que fará o áudio e o relógio (fica escondido)
 * @param {HTMLCanvasElement} canvas
 * @param {string} url  MP4 HEVC progressivo (Worker /m/<token> ou /api/proxy); precisa aceitar Range
 * @param {{
 *   startAt?: number, matrix?: '709'|'601',
 *   onFatal?: (reason: string) => void,
 *   onSlow?: (xrt: number) => void,
 *   onStat?: (s: {xrt: number, fps: number}) => void,
 *   onChange?: () => void,
 *   onAutoplayBlocked?: () => void,
 *   onFrame?: (f: {w: number, h: number}) => void
 * }} opts
 */
export async function createEngine(video, canvas, url, opts = {}) {
  const ref = { destroy: null };
  try {
    return await build(video, canvas, url, opts, ref);
  } catch (err) {
    if (ref.destroy) ref.destroy();      // não deixa Worker, MediaSource nem listeners para trás
    throw err;
  }
}

async function build(video, canvas, url, opts, ref) {
  ref.destroy = () => destroy();
  let noFrameTimer = null;
  let started = false;         // só baixa/anexa dados depois de o mp4box estar posicionado (start+seek)
  let destroyed = false;
  let gen = 0;
  let ctrl = new AbortController();
  let loading = false;
  let finished = false;
  let size = 0;
  let nextOffset = 0;
  let objectUrl = null;
  let tick = null;
  let raf = 0;
  let fatalSent = false;
  let intent = false;          // o usuário (ou o app) quer que esteja tocando
  let stalled = true;          // pausado por falta de imagem/áudio (começa assim: pré-carga)
  let decodeDone = false;
  let lastRepositionAt = 0;
  let ignoreSeekT = null;
  let audioSkipUntil = 0;
  let produced = 0;
  let stalledBytes = 0;
  let lastProduced = 0;
  let firstFrameAt = 0;
  let starveCount = 0;
  let starveTimes = [];
  let slowSent = false;
  let xrtEma = 0;
  let busyTotal = 0;
  let framesTotal = 0;
  const frames = [];           // quadros decodificados, por pts crescente; frames[0] é o que está na tela
  let shown = null;
  let pendingAck = 0;
  const queueA = [];
  let sbA = null;

  const emit = () => { if (opts.onChange) { try { opts.onChange(); } catch (e) { /* ignore */ } } };
  const fatal = (reason) => {
    if (destroyed || fatalSent) return;
    fatalSent = true;
    log('fatal:', reason);
    if (opts.onFatal) { try { opts.onFatal(String(reason)); } catch (e) { /* ignore */ } }
  };

  /* ---------------- rede ---------------- */
  async function fetchRange(start, end, signal) {
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      if (signal.aborted) throw new DOMException('abort', 'AbortError');
      try {
        const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
        if (res.status === 200) throw Object.assign(new Error('o servidor de vídeo não aceita Range'), { permanent: true });
        if (res.status === 416) throw Object.assign(new Error('fim do arquivo'), { permanent: true });
        if (res.status !== 206) throw new Error(`o servidor de vídeo respondeu HTTP ${res.status}`);
        const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
        if (m) size = Number(m[1]);
        const buf = await res.arrayBuffer();
        buf.fileStart = start;
        return buf;
      } catch (err) {
        if (err && (err.name === 'AbortError' || err.permanent)) throw err;
        lastErr = err;
      }
    }
    throw lastErr || new Error('falha de rede');
  }

  /* ---------------- índice do MP4 ---------------- */
  const mp4 = createFile();
  let info = null;
  mp4.onError = (e) => fatal('mp4box: ' + e);
  mp4.onReady = (i) => { info = i; };

  {
    // Procura o 'moov' pelos cabeçalhos das caixas e baixa o índice INTEIRO numa requisição só
    // (menos requisições ao Worker e nada de megabytes jogados fora).
    const head = await fetchRange(0, 4095, ctrl.signal);
    if (destroyed) return stub();
    const u8 = new Uint8Array(head);
    const dv = new DataView(head);
    let moovStart = -1;
    let moovSize = 0;
    for (let o = 0; o + 8 <= u8.length;) {
      let sz = dv.getUint32(o);
      const type = String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]);
      if (sz === 1 && o + 16 <= u8.length) sz = dv.getUint32(o + 8) * 4294967296 + dv.getUint32(o + 12);
      if (type === 'moov') { moovStart = o; moovSize = sz; break; }
      if (sz < 8) break;
      o += sz;
    }
    mp4.appendBuffer(head);
    if (moovStart >= 0 && moovSize > 0 && moovStart + moovSize <= 48 * 1024 * 1024) {
      const end = moovStart + moovSize;
      if (end > head.byteLength) mp4.appendBuffer(await fetchRange(head.byteLength, end - 1, ctrl.signal));
    } else {
      // moov fora do começo (arquivo não "faststart"): procura aos poucos.
      let off = head.byteLength;
      let n = 0;
      while (!info) {
        const len = PROBE_SIZES[Math.min(n++, PROBE_SIZES.length - 1)];
        const next = mp4.appendBuffer(await fetchRange(off, off + len - 1, ctrl.signal));
        if (info) break;
        if (!(next > off) || (size && next >= size)) throw new Error('índice do MP4 (moov) não encontrado');
        off = next;
      }
    }
    if (!info) throw new Error('índice do MP4 inválido');
  }

  const vtrack = info.videoTracks[0];
  const atrack = info.audioTracks[0] || null;
  if (!vtrack) throw new Error('arquivo sem vídeo');
  if (!atrack) throw new Error('arquivo sem áudio (o áudio é o relógio do player)');
  const duration = info.duration / info.timescale;
  const fps = vtrack.nb_samples / (vtrack.duration / vtrack.timescale) || 25;
  const vtrak = mp4.getTrackById(vtrack.id);
  const hvcC = vtrak.mdia.minf.stbl.stsd.entries[0].hvcC;
  if (!hvcC) throw new Error('faixa de vídeo sem hvcC (não é HEVC)');
  // A lista de edição desloca o vídeo (ex.: 80 ms por causa dos quadros B): o instante de exibição é cts - media_time.
  const elst = vtrak.edts && vtrak.edts.elst && vtrak.edts.elst.entries && vtrak.edts.elst.entries[0];
  const mediaTime = elst && elst.media_time > 0 ? elst.media_time : 0;

  /* ---------------- decodificador (Worker) ---------------- */
  const worker = new Worker(new URL('./decoder-worker.js', import.meta.url), { type: 'module' });
  const workerReady = new Promise((resolve, reject) => {
    worker.addEventListener('message', function first(e) {
      if (e.data.t === 'ready') { worker.removeEventListener('message', first); resolve(); }
      else if (e.data.t === 'error') { worker.removeEventListener('message', first); reject(new Error(e.data.message)); }
    });
    worker.addEventListener('error', (e) => reject(new Error('Worker: ' + (e.message || 'falhou ao carregar'))));
  });
  worker.addEventListener('error', (e) => fatal('Worker: ' + (e.message || 'erro')));
  worker.addEventListener('message', onWorkerMessage);

  const paramParts = [];
  let paramTotal = 0;
  for (const arr of hvcC.nalu_arrays || []) for (const nal of arr) { paramParts.push(nal.data); paramTotal += nal.data.length + 4; }
  const paramSets = new Uint8Array(paramTotal);
  { let w = 0; for (const p of paramParts) { paramSets[w + 3] = 1; paramSets.set(p, w + 4); w += 4 + p.length; } }
  worker.postMessage({
    t: 'init',
    wasmUrl: new URL('../vendor/hevc/wasm/hevc-decode.js', import.meta.url).href,
    wasmBinaryUrl: new URL('../vendor/hevc/wasm/hevc-decode.wasm', import.meta.url).href,
    paramSets,
    lengthSize: (hvcC.lengthSizeMinusOne & 3) + 1,
    timescale: vtrack.timescale
  });

  function onWorkerMessage(e) {
    const m = e.data;
    if (destroyed) return;
    switch (m.t) {
      case 'frame':
        if (m.gen !== gen) return;
        if (!firstFrameAt) { firstFrameAt = performance.now(); if (opts.onFrame) opts.onFrame({ w: m.w, h: m.h }); }
        if (!frames.length) log('1º quadro após o seek/início: pts', m.pts.toFixed(2), 'em', Math.round(performance.now() - lastRepositionAt), 'ms');
        frames.push({ pts: m.pts, w: m.w, h: m.h, cw: m.cw, ch: m.ch, y: m.y, u: m.u, v: m.v });
        break;
      case 'done':
        if (m.gen === gen) { decodeDone = true; }
        break;
      case 'stat': {
        busyTotal += m.busyMs;
        framesTotal += m.frames;
        const xrt = (m.frames / fps) / (m.busyMs / 1000);
        xrtEma = xrtEma ? xrtEma * 0.6 + xrt * 0.4 : xrt;
        if (opts.onStat) { try { opts.onStat({ xrt: xrtEma, fps }); } catch (err) { /* ignore */ } }
        // Decodificar mais devagar que o tempo real é inviável: avisa o app (que baixa a resolução).
        if (!slowSent && busyTotal > 6000 && xrtEma < 1.1) {
          slowSent = true;
          if (opts.onSlow) { try { opts.onSlow(xrtEma); } catch (err) { /* ignore */ } }
        }
        break;
      }
      case 'error':
        fatal(m.message);
        break;
      default:
    }
  }

  function flushAck() {
    if (pendingAck > 0) { worker.postMessage({ t: 'ack', n: pendingAck }); pendingAck = 0; }
  }

  /* ---------------- áudio por MediaSource ---------------- */
  const ms = new MediaSource();
  objectUrl = URL.createObjectURL(ms);
  video.src = objectUrl;
  await once(ms, 'sourceopen');
  if (destroyed) return stub();
  ms.duration = duration;
  if (atrack) {
    sbA = ms.addSourceBuffer(`audio/mp4; codecs="${atrack.codec}"`);
    const perSeg = Math.max(1, Math.round((atrack.nb_samples / (atrack.duration / atrack.timescale)) * SEG_SECONDS));
    mp4.setSegmentOptions(atrack.id, 'a', { nbSamples: perSeg, rapAlignement: false });
  }
  mp4.setExtractionOptions(vtrack.id, 'v', { nbSamples: 30 });

  mp4.onSegment = (id, user, buffer, sampleNum) => {
    if (destroyed || user !== 'a') return;
    try {
      const trak = mp4.getTrackById(id);
      const s = trak.samples[Math.max(0, sampleNum - 1)];
      const end = s ? (s.cts + s.duration) / s.timescale : 0;
      if (end > produced) produced = end;
      log('segmento de áudio', buffer.byteLength + 'B', 'até', end.toFixed(1) + 's', 'fila', queueA.length);
      mp4.releaseUsedSamples(id, sampleNum);
      if (audioSkipUntil > 0 && end <= audioSkipUntil + 0.01) return;      // já temos esse trecho (seek curto: não regravar o áudio que toca)
    } catch (e) { /* ignore */ }
    queueA.push(buffer);
    pump();
  };

  mp4.onSamples = (id, user, list) => {
    if (destroyed || user !== 'v' || !list.length) return;
    const out = new Array(list.length);
    const transfer = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const d = new Uint8Array(s.data);          // cópia: o buffer do mp4box continua dele
      out[i] = { d, cts: s.cts - mediaTime, dur: s.duration };
      transfer[i] = d.buffer;
    }
    worker.postMessage({ t: 'samples', gen, list: out }, transfer);
    mp4.releaseUsedSamples(id, list[list.length - 1].number + 1);
  };

  if (atrack) {
    const inits = mp4.initializeSegmentation('per-track');
    for (const init of inits) if (init.user === 'a') queueA.push(init.buffer);
  } else {
    mp4.initializeSegmentation('per-track');
  }

  /* ---------------- buffer de áudio ---------------- */
  function bufferedRange(t) {
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.25 && t <= b.end(i) + 0.05) return [b.start(i), b.end(i)];
    return null;
  }

  function aheadSeconds() { return produced - video.currentTime; }

  let pumping = false;
  function pump() {
    if (pumping || destroyed || !sbA || ms.readyState === 'closed') return;
    if (sbA.updating || !queueA.length) return;
    pumping = true;
    try {
      const b = queueA.shift();
      try {
        sbA.appendBuffer(b);
      } catch (err) {
        queueA.unshift(b);
        if (err && err.name === 'QuotaExceededError') trim(true); else fatal('áudio (appendBuffer): ' + (err && err.message));
      }
    } finally {
      pumping = false;
    }
  }

  function trim(force) {
    if (destroyed || !sbA || sbA.updating || ms.readyState === 'closed' || !sbA.buffered.length) return;
    const start = sbA.buffered.start(0);
    const cut = video.currentTime - (force ? 6 : BACK_KEEP_S);
    if (cut - start > (force ? 1 : 10)) { try { sbA.remove(start, cut); } catch (e) { /* ignore */ } }
  }

  function checkEnd() {
    if (!finished || destroyed || ms.readyState !== 'open') return;
    if (queueA.length || (sbA && sbA.updating)) return;
    try { ms.endOfStream(); } catch (e) { /* ignore */ }
  }

  function needMore() {
    return aheadSeconds() < AHEAD_TARGET_S && queueA.length < MAX_QUEUE_SEGS;
  }

  async function feed() {
    if (!started || loading || destroyed) return;
    loading = true;
    const myGen = gen;
    try {
      while (!destroyed && myGen === gen) {
        if (size && nextOffset >= size) {
          if (!finished) {
            finished = true;
            mp4.flush();
            worker.postMessage({ t: 'eos', gen });
            pump();
          }
          checkEnd();
          break;
        }
        if (!needMore()) break;
        const end = Math.min(size ? size - 1 : nextOffset + CHUNK - 1, nextOffset + CHUNK - 1);
        const buf = await fetchRange(nextOffset, end, ctrl.signal);
        if (destroyed || myGen !== gen) break;
        const next = mp4.appendBuffer(buf);
        log('fetch', nextOffset, '-', end, '→ próximo', next, 'áudio até', produced.toFixed(1), 'ahead', aheadSeconds().toFixed(1));
        nextOffset = typeof next === 'number' && next > nextOffset ? next : end + 1;
        const now = produced + framesTotal;
        if (now > lastProduced) { lastProduced = now; stalledBytes = 0; } else { stalledBytes += buf.byteLength; }
        if (stalledBytes > 32 * 1024 * 1024) { fatal('nenhum trecho gerado após 32 MB'); break; }
      }
    } catch (err) {
      if (!(err && err.name === 'AbortError') && !destroyed && myGen === gen) fatal(err && err.message ? err.message : err);
    } finally {
      loading = false;
    }
    if (!destroyed && myGen === gen && needMore() && !(size && nextOffset >= size)) feed();
  }

  async function waitIdle(sb) {
    while (sb.updating && !destroyed) await once(sb, 'updateend');
  }

  /* ---------------- seek ---------------- */
  async function reposition(t) {
    gen += 1;
    const myGen = gen;
    lastRepositionAt = performance.now();
    ctrl.abort();
    ctrl = new AbortController();
    mp4.stop();
    frames.length = 0;
    pendingAck = 0;
    decodeDone = false;
    finished = false;
    const target = Math.max(0, Math.min(duration - 0.05, t));
    worker.postMessage({ t: 'reset', gen, target });
    queueA.length = 0;

    const r = bufferedRange(t);
    const keepAudio = Boolean(r && r[1] - t > 6);
    audioSkipUntil = keepAudio ? r[1] : 0;
    if (!keepAudio && sbA) {
      try { if (sbA.updating) sbA.abort(); } catch (e) { /* ignore */ }
      await waitIdle(sbA);
      try { if (sbA.buffered.length) { sbA.remove(0, Infinity); await waitIdle(sbA); } } catch (e) { /* ignore */ }
    }
    if (destroyed || myGen !== gen) return;
    const pos = mp4.seek(target, true);
    nextOffset = pos.offset;
    produced = keepAudio ? Math.max(produced, r[1]) : pos.time;
    lastProduced = produced + framesTotal;
    stalledBytes = 0;
    log('seek', target.toFixed(1), '→ byte', pos.offset, '(keyframe em', pos.time.toFixed(2) + ')', keepAudio ? 'áudio mantido' : 'áudio refeito');
    mp4.start();
    feed();
    emit();
  }

  function onSeeking() {
    if (destroyed) return;
    const t = video.currentTime;
    if (ignoreSeekT !== null && Math.abs(t - ignoreSeekT) < 0.05) { ignoreSeekT = null; return; }
    ignoreSeekT = null;
    const last = frames.length ? frames[frames.length - 1].pts : -1;
    const covered = frames.length > 0 && frames[0].pts <= t + 0.05 && t <= last + 0.02;
    if (covered) { feed(); return; }
    // Vai esperar a decodificação a partir do keyframe: para o áudio e mostra o "carregando" já.
    if (intent) enterStall(); else if (!stalled) { stalled = true; emit(); }
    reposition(t);
  }

  /* ---------------- relógio, imagem e buffering ---------------- */
  const renderer = new YuvRenderer(canvas, { matrix: opts.matrix || '709' });

  function ack(n) {
    if (n > 0) { pendingAck += n; if (pendingAck >= 4) flushAck(); }
  }

  /** Descarta quadros mais antigos que o instante atual (mantém o que está na tela) e devolve o índice do quadro devido. */
  function prune(t) {
    let idx = -1;
    // Tocando: pequena antecipação (o vídeo adiantado incomoda menos que o atrasado). Parado: o quadro exato.
    const eps = intent && !stalled ? 0.012 : 0.001;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].pts <= t + eps) idx = i; else break;
    }
    if (idx > 0) { frames.splice(0, idx); ack(idx); idx = 0; }
    return idx;
  }

  function internalPlay() {
    const p = nativePlay.call(video);
    if (p && p.catch) {
      p.catch((err) => {
        if (destroyed) return;
        if (err && err.name === 'NotAllowedError') {
          intent = false;
          stalled = false;
          if (opts.onAutoplayBlocked) opts.onAutoplayBlocked();
          emit();
        }
      });
    }
  }

  function enterStall() {
    if (stalled) return;
    stalled = true;
    log('PARA (falta imagem) t=', video.currentTime.toFixed(2), 'quadros', frames.length, frames.length ? frames[0].pts.toFixed(2) + '..' + frames[frames.length - 1].pts.toFixed(2) : '', 'decodeDone', decodeDone);
    nativePause.call(video);
    video.dispatchEvent(new Event('waiting'));
    emit();
  }

  function exitStall() {
    if (!stalled) return;
    stalled = false;
    log('SEGUE t=', video.currentTime.toFixed(2), 'quadros', frames.length, 'readyState', video.readyState);
    if (intent) internalPlay();
    emit();
  }

  function readiness(t) {
    const last = frames.length ? frames[frames.length - 1].pts : -1;
    const atEnd = t >= duration - 0.2;
    const haveCurrent = frames.length > 0 && frames[0].pts <= t + 0.2;
    const haveAhead = last >= t + RESUME_AHEAD_S || (decodeDone && last >= t - 0.1) || atEnd;
    return { last, atEnd, haveCurrent, haveAhead };
  }

  /** Decide, a cada ciclo, se pode tocar ou se precisa esperar a decodificação. */
  function evaluate(t) {
    if (destroyed) return;
    const hidden = document.hidden;
    const { last, atEnd, haveCurrent, haveAhead } = readiness(t);

    if (!intent) {
      // Pausado pelo usuário: só mostra se há imagem para o ponto atual (seek de pausado).
      if (stalled !== !haveCurrent) { stalled = !haveCurrent; emit(); }
      return;
    }
    if (hidden) { if (stalled) exitStall(); return; }   // aba em segundo plano: o som segue, sem travar
    if (!stalled) {
      // Tocando: faltou imagem? (nenhum quadro a partir de agora, e o decodificador ainda tem trabalho)
      const starved = !atEnd && !decodeDone && (frames.length === 0 || !haveCurrent || t - last > 0.25);
      if (starved) {
        const sinceSeek = performance.now() - lastRepositionAt;
        if (sinceSeek > 5000) {
          starveTimes.push(performance.now());
          starveTimes = starveTimes.filter((x) => performance.now() - x < 45000);
          starveCount++;
          if (starveTimes.length >= 3 && !slowSent) {
            slowSent = true;
            if (opts.onSlow) { try { opts.onSlow(xrtEma || 0); } catch (e) { /* ignore */ } }
          }
        }
        enterStall();
      }
    } else if (haveCurrent && haveAhead && video.readyState >= 3) {
      exitStall();
    }
  }

  function renderLoop() {
    if (destroyed) return;
    raf = requestAnimationFrame(renderLoop);
    const t = video.currentTime;
    const idx = prune(t);
    if (idx >= 0) {
      const f = frames[0];
      if (f !== shown) { shown = f; renderer.draw(f); }
    }
    evaluate(t);
  }

  function slowTick() {
    if (destroyed) return;
    if (document.hidden) { prune(video.currentTime); evaluate(video.currentTime); }
    pump();
    trim(false);
    flushAck();
    feed();
    checkEnd();
  }

  function onTimeUpdate() { trim(false); feed(); }
  function onEnded() { intent = false; stalled = false; emit(); }
  function onVideoError() {
    const e = video.error;
    if (e && !destroyed) fatal(`erro de mídia ${e.code}${e.message ? ': ' + e.message : ''}`);
  }
  function onUpdateEnd() { pump(); checkEnd(); feed(); }
  const onPlay = () => emit();
  const onPause = () => emit();

  video.addEventListener('seeking', onSeeking);
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('ended', onEnded);
  video.addEventListener('error', onVideoError);
  video.addEventListener('play', onPlay);
  video.addEventListener('pause', onPause);
  if (sbA) sbA.addEventListener('updateend', onUpdateEnd);
  tick = setInterval(slowTick, 250);
  raf = requestAnimationFrame(renderLoop);

  /* O app (e o resto da página) continua chamando video.play()/pause(): viram pedidos de intenção. */
  const hadOwnPlay = Object.prototype.hasOwnProperty.call(video, 'play');
  video.play = () => {
    if (destroyed) return nativePlay.call(video);
    if (video.ended) { try { video.currentTime = 0; } catch (e) { /* ignore */ } }
    intent = true;
    const r = readiness(video.currentTime);
    if (r.haveCurrent && r.haveAhead && !video.seeking) {
      if (stalled) { stalled = false; }
      internalPlay();
    } else {
      stalled = true;           // pré-carga: o evaluate() solta o áudio quando houver imagem à frente
    }
    emit();
    return Promise.resolve();
  };
  video.pause = () => {
    if (destroyed) { nativePause.call(video); return; }
    intent = false;
    nativePause.call(video);
    emit();
  };

  /* ---------------- partida ---------------- */
  try { await workerReady; } catch (err) { destroy(); throw err; }
  if (destroyed) return stub();

  const startAt = Math.max(0, Math.min(duration - 1, Number(opts.startAt) || 0));
  worker.postMessage({ t: 'reset', gen, target: startAt });
  mp4.start();
  const pos0 = mp4.seek(startAt, true);
  nextOffset = pos0.offset;
  produced = pos0.time;
  lastProduced = produced;
  lastRepositionAt = performance.now();
  if (startAt > 0) { ignoreSeekT = startAt; try { video.currentTime = startAt; } catch (e) { ignoreSeekT = null; } }
  started = true;
  pump();
  feed();

  // Sem imagem por muito tempo desde que o usuário quis tocar: o decodificador não está funcionando.
  noFrameTimer = setInterval(() => {
    if (destroyed || firstFrameAt || !intent) return;
    if (performance.now() - lastRepositionAt > 30000) { clearInterval(noFrameTimer); fatal('o decodificador não produziu imagem'); }
  }, 2000);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    gen += 1;
    ctrl.abort();
    clearInterval(tick);
    clearInterval(noFrameTimer);
    cancelAnimationFrame(raf);
    video.removeEventListener('seeking', onSeeking);
    video.removeEventListener('timeupdate', onTimeUpdate);
    video.removeEventListener('ended', onEnded);
    video.removeEventListener('error', onVideoError);
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    if (sbA) sbA.removeEventListener('updateend', onUpdateEnd);
    if (!hadOwnPlay) { delete video.play; delete video.pause; }
    try { mp4.stop(); } catch (e) { /* ignore */ }
    try { worker.postMessage({ t: 'destroy' }); } catch (e) { /* ignore */ }
    setTimeout(() => { try { worker.terminate(); } catch (e) { /* ignore */ } }, 200);
    try { nativePause.call(video); video.removeAttribute('src'); video.load(); } catch (e) { /* ignore */ }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    try { renderer.dispose(); } catch (e) { /* ignore */ }
    frames.length = 0;
    shown = null;
  }

  function stub() { return { destroy() {}, get duration() { return duration; } }; }

  return {
    destroy,
    duration,
    fps,
    video: vtrack,
    audio: atrack,
    get intent() { return intent; },
    get buffering() { return intent ? stalled : (stalled && !destroyed); },
    get decodeSpeed() { return xrtEma; },
    get rendererMode() { return renderer.mode; },
    get starveCount() { return starveCount; },
    get frameCount() { return frames.length; },
    setMatrix: (name) => renderer.setMatrix(name),
    redraw() { if (shown) renderer.draw(shown); }
  };
}
