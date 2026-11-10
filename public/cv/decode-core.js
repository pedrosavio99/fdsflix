/**
 * Núcleo de decodificação HEVC (sem dependência de Worker/DOM: roda no Worker e no Node, para testes).
 *
 * Recebe amostras do MP4 (formato "length-prefixed", na ordem de decodificação), entrega quadros
 * I420 de 8 bits na ordem de exibição, cada um com o seu instante (pts, em segundos).
 *
 * O decodificador (WebAssembly, empacotado pelo @hevcjs/core, MIT) devolve
 * os quadros em ordem de EXIBIÇÃO, mas sem o instante. O instante de cada quadro é o da
 * "vaga" correspondente na lista ordenada de cts das amostras já alimentadas; as imagens que o
 * decodificador descarta sem exibir (RASL após um seek em CRA, por exemplo) consomem a vaga delas
 * — mesma técnica do próprio @hevcjs/core.
 */

import { HEVCDecoder } from '../vendor/hevc/decoder.js';

/** Igual ao HEVCDecoder, mas entrega planos de 8 bits (o original sempre copia em 16 bits: 2× memória). */
class Decoder8 extends HEVCDecoder {
  _readFrameFromPtr(framePtr) {
    const m = this._m;
    const at = this._layout.offset;
    const yPtr = m.getValue(framePtr + at.y, '*');
    const cbPtr = m.getValue(framePtr + at.cb, '*');
    const crPtr = m.getValue(framePtr + at.cr, '*');
    const width = m.getValue(framePtr + at.width, 'i32');
    const height = m.getValue(framePtr + at.height, 'i32');
    const strideY = m.getValue(framePtr + at.stride_y, 'i32');
    const strideC = m.getValue(framePtr + at.stride_c, 'i32');
    const cw = m.getValue(framePtr + at.chroma_width, 'i32');
    const ch = m.getValue(framePtr + at.chroma_height, 'i32');
    const bitDepth = m.getValue(framePtr + at.bit_depth, 'i32');
    const poc = m.getValue(framePtr + at.poc, 'i32');
    const cvsId = m.getValue(framePtr + at.cvs_id, 'i32');
    const bps = m.getValue(framePtr + at.bytes_per_sample, 'i32');
    return {
      y: plane(m, yPtr, width, height, strideY, bps, bitDepth),
      cb: plane(m, cbPtr, cw, ch, strideC, bps, bitDepth),
      cr: plane(m, crPtr, cw, ch, strideC, bps, bitDepth),
      width, height, chromaWidth: cw, chromaHeight: ch, bitDepth, poc, cvsId
    };
  }
}

function plane(m, ptr, w, h, stride, bps, bitDepth) {
  if (bps === 1) {
    const heap = m.HEAPU8;
    if (stride === w) return heap.slice(ptr, ptr + w * h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) out.set(heap.subarray(ptr + y * stride, ptr + y * stride + w), y * w);
    return out;
  }
  // 10/12 bits: reduz para 8 (a tela é 8 bits de qualquer jeito).
  const heap = m.HEAPU16;
  const base = ptr >> 1;
  const shift = Math.max(0, bitDepth - 8);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = base + y * stride;
    const o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = heap[row + x] >> shift;
  }
  return out;
}

function displaysBefore(a, b) {
  return a.cvsId !== b.cvsId ? a.cvsId < b.cvsId : a.poc < b.poc;
}

export class DecodeCore {
  static async create(opts) {
    const factory = {};
    if (opts && opts.wasmBinaryUrl) factory.locateFile = () => opts.wasmBinaryUrl;
    let make = null;
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      // Node (testes): o glue vira módulo CommonJS.
      const mod = await import(/* @vite-ignore */ opts.wasmUrl);
      make = mod.default ?? mod;
    } else {
      // Navegador: o glue é um script UMD ("var HEVCDecoderModule = ...") sem export ES.
      // Um Worker de módulo não tem importScripts, então avaliamos o texto dele aqui.
      const src = await (await fetch(opts.wasmUrl)).text();
      make = new Function(src + '\n;return HEVCDecoderModule;')();
    }
    const module = await make(factory);
    return new DecodeCore(new Decoder8(module));
  }

  constructor(decoder) {
    this.dec = decoder;
    this.paramSets = null;       // Annex B
    this.lengthSize = 4;
    this.timescale = 1000;
    this.queue = [];             // amostras ainda não decodificadas
    this.qHead = 0;
    this.slots = [];             // cts (s) das amostras alimentadas, ordenados; [head..] ainda sem quadro
    this.head = 0;
    this.suppressed = [];
    this.target = 0;             // não entregar quadros antes disso (exceto o último antes dele)
    this.held = null;
    this.eosFlag = false;
    this.flushed = false;
    this.lastPts = 0;
    this.lastDur = 0.04;
    this.stats = { frames: 0, busyMs: 0 };
  }

  configure({ paramSets, lengthSize, timescale }) {
    this.paramSets = paramSets;
    this.lengthSize = lengthSize || 4;
    this.timescale = timescale || 1000;
    if (paramSets && paramSets.length) this.dec.feed(paramSets);
  }

  /** Recomeça a partir de uma amostra de sincronia (keyframe). Descarta tudo o que estava em andamento. */
  reset(target) {
    try { this.dec.flush(); } catch (e) { /* ignore */ }
    try { this.dec.takeSuppressedPictures(); } catch (e) { /* ignore */ }
    this.queue = [];
    this.qHead = 0;
    this.slots = [];
    this.head = 0;
    this.suppressed = [];
    this.held = null;
    this.eosFlag = false;
    this.flushed = false;
    this.target = Math.max(0, target || 0);
    if (this.paramSets && this.paramSets.length) this.dec.feed(this.paramSets);
  }

  /** @param {{d: Uint8Array, cts: number, dur: number}[]} samples cts/dur em unidades do timescale */
  push(samples) {
    for (const s of samples) this.queue.push(s);
  }

  eos() { this.eosFlag = true; }

  get pendingSamples() { return this.queue.length - this.qHead; }
  get finished() { return this.eosFlag && this.flushed && this.pendingSamples === 0; }

  _insertSlot(pts) {
    const a = this.slots;
    let lo = this.head;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= pts) lo = mid + 1; else hi = mid;
    }
    a.splice(lo, 0, pts);
  }

  _takePts(frame) {
    for (let i = this.suppressed.length - 1; i >= 0; i--) {
      if (displaysBefore(this.suppressed[i], frame)) {
        this.suppressed.splice(i, 1);
        this.head++;
      }
    }
    const slot = this.head++;
    if (slot < this.slots.length) {
      const pts = this.slots[slot];
      this.lastPts = pts;
      return pts;
    }
    this.lastPts += this.lastDur;   // sem vaga: extrapola
    return this.lastPts;
  }

  _compact() {
    if (this.head > 4096) { this.slots.splice(0, this.head); this.head = 0; }
    if (this.qHead > 512) { this.queue.splice(0, this.qHead); this.qHead = 0; }
  }

  _toAnnexB(d) {
    const ls = this.lengthSize;
    if (ls === 4) {
      let o = 0;
      while (o + 4 <= d.length) {
        const n = ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
        d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 1;
        o += 4 + n;
      }
      return d;
    }
    const parts = [];
    let total = 0;
    let o = 0;
    while (o + ls <= d.length) {
      let n = 0;
      for (let i = 0; i < ls; i++) n = (n * 256) + d[o + i];
      o += ls;
      parts.push(d.subarray(o, o + n));
      total += n + 4;
      o += n;
    }
    const out = new Uint8Array(total);
    let w = 0;
    for (const p of parts) { out[w + 3] = 1; out.set(p, w + 4); w += 4 + p.length; }
    return out;
  }

  _emit(frame, out) {
    const pts = this._takePts(frame);
    const f = { pts, w: frame.width, h: frame.height, cw: frame.chromaWidth, ch: frame.chromaHeight, y: frame.y, u: frame.cb, v: frame.cr };
    if (this.target > 0 && pts < this.target - 1e-4) { this.held = f; return; }
    if (this.held) { out.push(this.held); this.held = null; }
    this.target = 0;
    out.push(f);
  }

  /**
   * Decodifica amostras da fila até produzir `maxFrames` quadros, ou acabar o `maxMs`.
   * @returns {{frames: object[], busyMs: number, fed: number}}  fed = amostras decodificadas (inclui as descartadas antes do alvo do seek)
   */
  step(maxFrames, maxMs) {
    const out = [];
    let fed = 0;
    const t0 = performance.now();
    while (out.length < maxFrames && this.qHead < this.queue.length && performance.now() - t0 < maxMs) {
      const s = this.queue[this.qHead];
      this.queue[this.qHead++] = null;
      this.lastDur = s.dur > 0 ? s.dur / this.timescale : this.lastDur;
      this._insertSlot(s.cts / this.timescale);
      this.dec.feed(this._toAnnexB(s.d));
      fed++;
      for (const p of this.dec.takeSuppressedPictures()) this.suppressed.push(p);
      for (const fr of this.dec.drain()) this._emit(fr, out);
    }
    if (this.eosFlag && this.qHead >= this.queue.length && !this.flushed) {
      for (const fr of this.dec.flush()) this._emit(fr, out);
      if (this.held) { out.push(this.held); this.held = null; }
      this.flushed = true;
    }
    this._compact();
    const busyMs = performance.now() - t0;
    this.stats.frames += out.length;
    this.stats.busyMs += busyMs;
    return { frames: out, busyMs, fed };
  }

  destroy() {
    try { this.dec.destroy(); } catch (e) { /* ignore */ }
  }
}

/** hvcC (do mp4box) -> NAL de parâmetros em Annex B. */
export function paramSetsFromHvcC(hvcC) {
  const parts = [];
  let total = 0;
  for (const arr of hvcC.nalu_arrays || []) {
    for (const n of arr) { parts.push(n.data); total += n.data.length + 4; }
  }
  const out = new Uint8Array(total);
  let w = 0;
  for (const p of parts) { out[w + 3] = 1; out.set(p, w + 4); w += 4 + p.length; }
  return out;
}
