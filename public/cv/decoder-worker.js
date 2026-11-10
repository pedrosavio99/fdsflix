/**
 * Worker de decodificação HEVC (módulo). Protocolo:
 *   main → worker: init{wasmUrl,wasmBinaryUrl,paramSets,lengthSize,timescale}
 *                  reset{gen,target}   recomeça num keyframe; quadros antes de `target` são descartados
 *                  samples{gen,list}   amostras (d: Uint8Array transferido, cts, dur) em ordem de decodificação
 *                  eos{gen}            acabaram as amostras
 *                  ack{n}              n quadros saíram da fila da tela (libera o Worker para decodificar mais)
 *                  destroy
 *   worker → main: ready | frame{gen,pts,w,h,cw,ch,y,u,v} | done{gen} | stat{frames,busyMs} | error{message}
 *
 * O Worker só decodifica enquanto houver "espaço" na tela (quadros enviados e ainda não consumidos):
 * é isso que mantém a memória e a CPU baixas e deixa a decodificação acompanhar o relógio do áudio.
 */

import { DecodeCore } from './decode-core.js';

let core = null;
let gen = 0;
let inflight = 0;
let maxInflight = 40;
let running = false;
let doneSent = -1;
let statFrames = 0;
let statBusy = 0;
let lastStat = 0;
let sizedOnce = false;

const chan = new MessageChannel();
let yieldResolve = null;
chan.port1.onmessage = () => { const r = yieldResolve; yieldResolve = null; if (r) r(); };
const yieldNow = () => new Promise((resolve) => { yieldResolve = resolve; chan.port2.postMessage(0); });

let ready = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.t === 'init') {
    ready = (async () => {
      try {
        core = await DecodeCore.create({ wasmUrl: msg.wasmUrl, wasmBinaryUrl: msg.wasmBinaryUrl });
        core.configure({ paramSets: msg.paramSets, lengthSize: msg.lengthSize, timescale: msg.timescale });
        self.postMessage({ t: 'ready' });
      } catch (err) {
        self.postMessage({ t: 'error', message: 'decodificador: ' + ((err && err.message) || err) });
      }
    })();
    return;
  }
  if (!ready) return;
  ready.then(() => handle(msg));
};

function handle(msg) {
  if (!core) return;
  try {
    switch (msg.t) {
      case 'reset':
        gen = msg.gen;
        inflight = 0;
        doneSent = -1;
        core.reset(msg.target);
        break;
      case 'samples':
        if (msg.gen !== gen) return;
        core.push(msg.list);
        schedule();
        break;
      case 'eos':
        if (msg.gen !== gen) return;
        core.eos();
        schedule();
        break;
      case 'ack':
        inflight = Math.max(0, inflight - msg.n);
        schedule();
        break;
      case 'destroy':
        core.destroy();
        core = null;
        self.close();
        break;
      default:
    }
  } catch (err) {
    self.postMessage({ t: 'error', message: 'decodificador: ' + ((err && err.message) || err) });
  }
}

function schedule() {
  if (!running) loop();
}

async function loop() {
  running = true;
  try {
    while (core) {
      const waiting = core.pendingSamples > 0 || (core.eosFlag && !core.flushed);
      if (!waiting) break;
      const room = maxInflight - inflight;
      if (room <= 0) break;
      const myGen = gen;
      const { frames, busyMs, fed } = core.step(Math.min(room, 6), 10);
      if (frames.length) {
        if (!sizedOnce) {
          // ~64 MB de quadros no máximo (480p ≈ 2,4 s; 360p ≈ 6 s; 720p ≈ 1 s).
          const first = frames[0];
          const per = first.y.length + first.u.length + first.v.length;
          maxInflight = Math.max(14, Math.min(150, Math.floor(64e6 / per)));
          sizedOnce = true;
        }
        for (const f of frames) {
          self.postMessage({ t: 'frame', gen: myGen, pts: f.pts, w: f.w, h: f.h, cw: f.cw, ch: f.ch, y: f.y, u: f.u, v: f.v }, [f.y.buffer, f.u.buffer, f.v.buffer]);
        }
        inflight += frames.length;
      }
      statFrames += fed;      // amostras decodificadas (num seek, boa parte do trabalho é de quadros que nem chegam à tela)
      statBusy += busyMs;
      const now = performance.now();
      if (now - lastStat > 1000 && statFrames > 0) {
        self.postMessage({ t: 'stat', frames: statFrames, busyMs: statBusy });
        statFrames = 0; statBusy = 0; lastStat = now;
      }
      if (core && core.finished && doneSent !== myGen) {
        doneSent = myGen;
        self.postMessage({ t: 'done', gen: myGen });
      }
      await yieldNow();
    }
  } catch (err) {
    self.postMessage({ t: 'error', message: 'decodificador: ' + ((err && err.message) || err) });
  }
  running = false;
  // Pode ter chegado trabalho enquanto cedíamos a vez.
  if (core && inflight < maxInflight && (core.pendingSamples > 0 || (core.eosFlag && !core.flushed))) schedule();
}
