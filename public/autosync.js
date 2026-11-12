/*
 * fdsFlix · Sincronia automática da legenda pelo áudio do vídeo.
 *
 * Como funciona (mesma ideia do ffsubsync/alass, só que no navegador e sem baixar nada a mais):
 *   1. o hls.js já baixa os segmentos para tocar; copiamos o áudio (AAC dentro do MPEG-TS) de cada um;
 *   2. medimos, a cada 100 ms, a energia na faixa da voz (250–3500 Hz) => "tem fala aqui?";
 *   3. comparamos com os horários das falas da legenda: o deslocamento em que as falas da legenda mais
 *      caem em cima de áudio com voz é o atraso da legenda (correlação cruzada);
 *   4. só aplicamos se o pico for claramente maior que o ruído (confiança); com 2+ janelas distantes no
 *      filme também detectamos legenda de outro fps (escala) e corrigimos.
 *
 * O núcleo (tsAudio, envelope, createCollector, estimate, fitScale) é puro e roda no Node (test/autosync.test.js).
 * Só `attachHls` usa API de navegador (OfflineAudioContext.decodeAudioData) e nunca mexe na reprodução.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FdsAutoSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BIN = 0.1; // segundos por amostra da envoltória

  /* ------------------------------ MPEG-TS -> AAC (ADTS) ------------------------------ */

  /**
   * Extrai o áudio AAC (ADTS) de um segmento MPEG-TS. Devolve { adts: Uint8Array, pts: segundos } ou null
   * (segmento fMP4, áudio que não é AAC, dados cortados...).
   */
  function tsAudio(input) {
    var d = input instanceof Uint8Array ? input : new Uint8Array(input);
    var start = 0;
    while (start < 188 * 4 && start + 376 < d.length && !(d[start] === 0x47 && d[start + 188] === 0x47)) start += 1;
    if (!(d[start] === 0x47)) return null;

    var pmtPid = -1;
    var audioPid = -1;
    var chunks = [];
    var total = 0;
    var firstPts = null;

    for (var p = start; p + 188 <= d.length; p += 188) {
      if (d[p] !== 0x47) continue;
      var pusi = (d[p + 1] & 0x40) !== 0;
      var pid = ((d[p + 1] & 0x1f) << 8) | d[p + 2];
      var afc = (d[p + 3] >> 4) & 3;
      if (afc === 0 || afc === 2) continue; // sem payload
      var i = p + 4;
      if (afc === 3) i += 1 + d[i];
      if (i >= p + 188) continue;

      if (pid === 0 && pusi && pmtPid < 0) {
        i += 1 + d[i]; // pointer_field
        var patLen = ((d[i + 1] & 0x0f) << 8) | d[i + 2];
        for (var j = i + 8; j + 4 <= i + 3 + patLen - 4 && j + 4 <= p + 188; j += 4) {
          var program = (d[j] << 8) | d[j + 1];
          if (program !== 0) { pmtPid = ((d[j + 2] & 0x1f) << 8) | d[j + 3]; break; }
        }
      } else if (pid === pmtPid && pusi && audioPid < 0) {
        i += 1 + d[i];
        var pmtLen = ((d[i + 1] & 0x0f) << 8) | d[i + 2];
        var infoLen = ((d[i + 10] & 0x0f) << 8) | d[i + 11];
        var k = i + 12 + infoLen;
        var end = Math.min(i + 3 + pmtLen - 4, p + 188);
        while (k + 5 <= end) {
          var type = d[k];
          var epid = ((d[k + 1] & 0x1f) << 8) | d[k + 2];
          var esLen = ((d[k + 3] & 0x0f) << 8) | d[k + 4];
          if (type === 0x0f) { audioPid = epid; break; } // AAC com ADTS
          k += 5 + esLen;
        }
      } else if (pid === audioPid && audioPid >= 0) {
        var from = i;
        if (pusi) {
          if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
            if ((d[i + 7] & 0x80) && firstPts === null) {
              firstPts = ((d[i + 9] & 0x0e) * 536870912) + (d[i + 10] * 4194304) +
                ((d[i + 11] & 0xfe) * 16384) + (d[i + 12] * 128) + (d[i + 13] >> 1);
            }
            from = i + 9 + d[i + 8];
          }
        }
        if (from < p + 188) {
          chunks.push(d.subarray(from, p + 188));
          total += p + 188 - from;
        }
      }
    }
    if (audioPid < 0 || !total) return null;
    var adts = new Uint8Array(total);
    var o = 0;
    for (var c = 0; c < chunks.length; c += 1) { adts.set(chunks[c], o); o += chunks[c].length; }
    return { adts: adts, pts: firstPts === null ? null : firstPts / 90000 };
  }

  /* ------------------------------ PCM -> envoltória da voz ------------------------------ */

  /**
   * Duas medidas de "tem fala aqui?" a cada BIN segundos (a energia crua não serve: filme tem música e ação):
   *   e: energia (log) na faixa da voz, 250–3500 Hz  (depois descontamos o fundo local);
   *   m: modulação silábica = desvio da energia em quadros de 20 ms ao longo de 0,5 s (fala oscila; música/ruído não).
   * @param {Float32Array} pcm mono
   * @returns {{e: Float32Array, m: Float32Array}}
   */
  function envelope(pcm, sampleRate) {
    var dt = 1 / sampleRate;
    var rcHp = 1 / (2 * Math.PI * 250);
    var rcLp = 1 / (2 * Math.PI * 3500);
    var aHp = rcHp / (rcHp + dt);
    var aLp = dt / (rcLp + dt);
    var frame = Math.max(1, Math.round(sampleRate * 0.02));
    var perBin = 5; // 5 quadros de 20 ms = 100 ms
    var frames = Math.floor(pcm.length / frame);
    var ef = new Float32Array(frames);
    var hp = 0, lp = 0, prev = 0, acc = 0, n = 0, f = 0;
    for (var i = 0; i < frames * frame; i += 1) {
      var x = pcm[i];
      hp = aHp * (hp + x - prev);
      prev = x;
      lp += aLp * (hp - lp);
      acc += lp * lp;
      n += 1;
      if (n === frame) { ef[f] = Math.log(acc / n + 1e-10); f += 1; acc = 0; n = 0; }
    }
    var bins = Math.floor(frames / perBin);
    var e = new Float32Array(bins);
    var m = new Float32Array(bins);
    var win = 25;
    for (var b = 0; b < bins; b += 1) {
      var s0 = 0;
      for (var q = 0; q < perBin; q += 1) s0 += ef[b * perBin + q];
      e[b] = s0 / perBin;
      // janela CENTRADA no bin (senão a "fala" aparece ~0,2 s antes do que é)
      var from = Math.max(0, b * perBin + (perBin >> 1) - (win >> 1));
      var to = Math.min(frames, from + win);
      var cnt = to - from;
      if (cnt < 10) { m[b] = b ? m[b - 1] : 0; continue; }
      var mean = 0;
      for (var u = from; u < to; u += 1) mean += ef[u];
      mean /= cnt;
      var v = 0;
      for (var w = from; w < to; w += 1) v += (ef[w] - mean) * (ef[w] - mean);
      m[b] = Math.sqrt(v / cnt);
    }
    return { e: e, m: m };
  }

  /* ------------------------------ acúmulo das envoltórias ------------------------------ */

  var BG_HALF = 40; // ±4 s para descontar o "fundo" (música/ambiente)

  function createCollector() {
    var size = 2048;
    var E = new Float32Array(size);   // energia da voz (log)
    var M = new Float32Array(size);   // modulação silábica
    var R = new Float32Array(size);   // energia relativa ao fundo local
    var cov = new Uint8Array(size);
    var lo = Infinity;
    var hi = -Infinity;
    var covered = 0;

    function grow(n) {
      if (n <= size) return;
      var ns = size;
      while (ns < n) ns *= 2;
      var e2 = new Float32Array(ns); e2.set(E); E = e2;
      var m2 = new Float32Array(ns); m2.set(M); M = m2;
      var r2 = new Float32Array(ns); r2.set(R); R = r2;
      var c2 = new Uint8Array(ns); c2.set(cov); cov = c2;
      size = ns;
    }

    // R[t] = E[t] - mediana de E na vizinhança coberta (±4 s). Só refaz o trecho afetado.
    function refreshRelative(from, to) {
      var a = Math.max(0, from - BG_HALF - 1);
      var b = Math.min(hi, to + BG_HALF + 1);
      var buf = [];
      for (var t = a; t < b; t += 1) {
        if (!cov[t]) continue;
        buf.length = 0;
        var x0 = Math.max(0, t - BG_HALF);
        var x1 = Math.min(hi - 1, t + BG_HALF);
        for (var x = x0; x <= x1; x += 1) if (cov[x]) buf.push(E[x]);
        buf.sort(function (p, q) { return p - q; });
        R[t] = E[t] - buf[buf.length >> 1];
      }
    }

    return {
      /** guarda as medidas que começam em `startSec` (tempo da linha do tempo do vídeo). */
      add: function (startSec, env) {
        var first = Math.round(startSec / BIN);
        var len = env.e.length;
        if (first < 0 || !len) return;
        grow(first + len);
        for (var i = 0; i < len; i += 1) {
          if (!cov[first + i]) covered += 1;
          E[first + i] = env.e[i];
          M[first + i] = env.m[i];
          cov[first + i] = 1;
        }
        lo = Math.min(lo, first);
        hi = Math.max(hi, first + len);
        refreshRelative(first, first + len);
      },
      coveredSeconds: function () { return covered * BIN; },
      range: function () { return lo === Infinity ? null : { from: lo * BIN, to: hi * BIN }; },
      raw: function () { return { R: R, M: M, cov: cov, lo: lo, hi: hi }; }
    };
  }

  /* ------------------------------ correlação cruzada ------------------------------ */

  /**
   * Procura o deslocamento `d` (segundos) tal que as falas da legenda em [s+d, e+d] caiam sobre áudio com voz.
   *
   * @param collector  createCollector() já preenchido
   * @param cues       [{ s, e }] na MESMA linha do tempo do áudio, sem o deslocamento que se quer descobrir
   * @param opts       { maxLag = 120 (s), center = 0 (s, centro da busca), from, to (limita as falas usadas), minSeconds = 30 }
   * @returns { offset, conf, seconds } ou null
   */
  function estimate(collector, cues, opts) {
    opts = opts || {};
    var maxLag = Math.max(2, opts.maxLag || 120);
    var minBins = Math.round((opts.minSeconds || 30) / BIN);
    var r = collector.raw();
    if (r.lo === Infinity) return null;
    var n = r.hi;

    // z-score robusto de cada medida, só sobre o que foi coberto; a "fala" é a soma das duas
    function robust(arr) {
      var v = [];
      for (var i = r.lo; i < r.hi; i += 1) if (r.cov[i]) v.push(arr[i]);
      v.sort(function (a, b) { return a - b; });
      var med = v[v.length >> 1];
      var dev = v.map(function (x) { return Math.abs(x - med); }).sort(function (a, b) { return a - b; });
      return { med: med, mad: 1.4826 * dev[dev.length >> 1] + 1e-6 };
    }
    var covCount = 0;
    for (var ci = r.lo; ci < r.hi; ci += 1) if (r.cov[ci]) covCount += 1;
    if (covCount < minBins) return null;
    var sr = robust(r.R);
    var sm = robust(r.M);
    var clip = function (z) { return Math.max(-3, Math.min(5, z)); };

    var P = new Float64Array(n + 1);
    var C = new Int32Array(n + 1);
    for (var t = 0; t < n; t += 1) {
      var z = 0;
      if (r.cov[t]) z = clip((r.R[t] - sr.med) / sr.mad) + clip((r.M[t] - sm.med) / sm.mad);
      P[t + 1] = P[t] + z;
      C[t + 1] = C[t] + (r.cov[t] ? 1 : 0);
    }

    var list = [];
    for (var c = 0; c < cues.length; c += 1) {
      var cue = cues[c];
      if (!(cue.e > cue.s)) continue;
      if (opts.from !== undefined && cue.e < opts.from) continue;
      if (opts.to !== undefined && cue.s > opts.to) continue;
      list.push([Math.round(cue.s / BIN), Math.max(Math.round(cue.s / BIN) + 1, Math.round(cue.e / BIN))]);
    }
    if (list.length < 8) return null;

    var L = Math.round(maxLag / BIN);
    var C0 = Math.round((opts.center || 0) / BIN);
    var score = new Float64Array(2 * L + 1).fill(NaN);
    var cnts = new Int32Array(2 * L + 1);
    for (var k = -L; k <= L; k += 1) {
      var S = 0;
      var cnt = 0;
      for (var q = 0; q < list.length; q += 1) {
        var a = list[q][0] + C0 + k;
        var b = list[q][1] + C0 + k;
        if (b <= 0 || a >= n) continue;
        if (a < 0) a = 0;
        if (b > n) b = n;
        S += P[b] - P[a];
        cnt += C[b] - C[a];
      }
      cnts[k + L] = cnt;
      if (cnt >= minBins) score[k + L] = S / Math.sqrt(cnt);
    }

    var best = -1;
    var bestV = -Infinity;
    for (var m = 0; m < score.length; m += 1) {
      if (score[m] === score[m] && score[m] > bestV) { bestV = score[m]; best = m; }
    }
    if (best < 0) return null;

    // confiança: quanto o pico se destaca dos demais deslocamentos (fora da vizinhança de ±3 s)
    var sum = 0;
    var sum2 = 0;
    var cntOthers = 0;
    var guard = Math.round(3 / BIN);
    for (var u = 0; u < score.length; u += 1) {
      if (Math.abs(u - best) <= guard || score[u] !== score[u]) continue;
      sum += score[u]; sum2 += score[u] * score[u]; cntOthers += 1;
    }
    if (cntOthers < 20) return null;
    var mean = sum / cntOthers;
    var sd = Math.sqrt(Math.max(1e-9, sum2 / cntOthers - mean * mean));
    var conf = (bestV - mean) / sd;

    // interpolação parabólica: precisão melhor que 1 bin
    var frac = 0;
    if (best > 0 && best < score.length - 1 && score[best - 1] === score[best - 1] && score[best + 1] === score[best + 1]) {
      var y0 = score[best - 1], y1 = score[best], y2 = score[best + 1];
      var den = y0 - 2 * y1 + y2;
      if (den < 0) frac = Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den));
    }
    return {
      offset: (C0 + best - L + frac) * BIN,
      conf: conf,
      seconds: cnts[best] * BIN,
      cues: list.length
    };
  }

  /**
   * Estimativa com prova: além do pico geral, exige que as DUAS metades da cobertura (separadas pela
   * mediana do que já foi ouvido) apontem para o mesmo atraso. Pico espúrio (música, legenda de outro
   * filme) quase nunca se repete nas duas metades; atraso real, sim.
   *
   * @returns { ok, offset, conf, halves, reason }  `ok` só é true quando dá para aplicar.
   */
  function estimateChecked(collector, cues, opts) {
    opts = opts || {};
    var minConf = opts.minConf || 4.5;
    var whole = estimate(collector, cues, opts);
    if (!whole) return { ok: false, reason: 'dados insuficientes' };
    var res = { ok: false, offset: whole.offset, conf: whole.conf, seconds: whole.seconds, reason: '' };
    // atraso grande é raro (e um falso positivo custa caro): exige mais prova
    if (whole.conf < (Math.abs(whole.offset) > 20 ? Math.max(minConf, opts.farConf || 5.5) : minConf)) { res.reason = 'confiança baixa'; return res; }

    var r = collector.raw();
    var idx = [];
    for (var i = r.lo; i < r.hi; i += 1) if (r.cov[i]) idx.push(i);
    var mid = idx[idx.length >> 1] * BIN;
    var lo = r.lo * BIN;
    var hi = r.hi * BIN;
    var halves = [[lo, mid], [mid, hi]].map(function (rg) {
      return estimate(collector, cues, {
        center: whole.offset, maxLag: 10, minSeconds: 20,
        from: rg[0] - whole.offset, to: rg[1] - whole.offset
      });
    });
    res.halves = halves;
    for (var h = 0; h < 2; h += 1) {
      if (!halves[h]) { res.reason = 'metade sem dados'; return res; }
      if (Math.abs(halves[h].offset - whole.offset) > (opts.halfTol || 0.6) || halves[h].conf < (opts.halfConf || 2.5)) {
        res.reason = 'metades discordam';
        return res;
      }
    }
    res.ok = true;
    return res;
  }

  // Trocas de fps que explicam quase toda legenda "que vai escorregando": 25/23,976, 24/25, etc.
  var FPS_RATIOS = [25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25, 24 / 23.976, 23.976 / 24, 30 / 25, 25 / 30, 29.97 / 25, 25 / 29.97];

  /**
   * estimateChecked + hipóteses de escala (fps diferente). Primeiro tenta sem escala; se não fechar e já houver
   * áudio suficiente, testa cada razão de fps conhecida, exigindo mais prova (escala errada custa caro).
   * @returns { ok, offset, ratio, conf, reason }  `ratio` multiplica o horário das falas (1 = sem escala).
   */
  function estimateAuto(collector, cues, opts) {
    opts = opts || {};
    var base = estimateChecked(collector, cues, opts);
    base.ratio = 1;
    if (base.ok) return base;
    if (collector.coveredSeconds() < (opts.scaleMinSeconds || 360)) return base;

    var best = null;
    FPS_RATIOS.forEach(function (ratio) {
      var scaled = cues.map(function (c) { return { s: c.s * ratio, e: c.e * ratio }; });
      var e = estimateChecked(collector, scaled, {
        maxLag: opts.maxLag, minSeconds: opts.minSeconds,
        minConf: opts.scaleConf || 6.0, farConf: opts.scaleConf || 6.0, halfConf: opts.halfConf, halfTol: opts.halfTol
      });
      if (e.ok && (!best || e.conf > best.conf)) { best = e; best.ratio = ratio; }
    });
    if (best && best.conf >= (base.conf || 0) + 1.0) return best;
    return base;
  }

  /**
   * Divide o que já foi ouvido em janelas de ~`winSeconds` de áudio coberto (cada uma dá uma estimativa local).
   * @returns [{ from, to, mid, seconds }]  `mid` = instante mediano do que foi coberto na janela.
   */
  function windows(collector, winSeconds) {
    var r = collector.raw();
    var out = [];
    if (r.lo === Infinity) return out;
    var need = Math.max(1, Math.round(winSeconds / BIN));
    var start = -1;
    var idx = [];
    for (var i = r.lo; i < r.hi; i += 1) {
      if (!r.cov[i]) continue;
      if (start < 0) start = i;
      idx.push(i);
      if (idx.length >= need) {
        out.push({ from: start * BIN, to: (i + 1) * BIN, mid: idx[idx.length >> 1] * BIN, seconds: idx.length * BIN });
        start = -1;
        idx = [];
      }
    }
    return out;
  }

  /**
   * Ajusta uma reta d(t) = a + b*t pelos pontos { t, d } e devolve { offset: a, scale: 1 + b, resid } ou null.
   * Só vale se os pontos cobrem pelo menos `minSpan` segundos do filme.
   */
  function fitScale(points, minSpan) {
    var n = points.length;
    if (n < 3) return null;
    var tMin = Infinity, tMax = -Infinity, st = 0, sd = 0;
    points.forEach(function (p) { tMin = Math.min(tMin, p.t); tMax = Math.max(tMax, p.t); st += p.t; sd += p.d; });
    if (tMax - tMin < (minSpan || 900)) return null;
    var mt = st / n, md = sd / n, num = 0, den = 0;
    points.forEach(function (p) { num += (p.t - mt) * (p.d - md); den += (p.t - mt) * (p.t - mt); });
    if (!den) return null;
    var b = num / den;
    var a = md - b * mt;
    var resid = 0;
    points.forEach(function (p) { resid = Math.max(resid, Math.abs(p.d - (a + b * p.t))); });
    return { offset: a, scale: 1 + b, resid: resid };
  }

  /* ------------------------------ navegador: ligação com o hls.js ------------------------------ */

  /**
   * Escuta os segmentos que o hls.js baixa e alimenta o coletor. Nunca altera a reprodução.
   * @returns { collector, supported, stop() }
   */
  function attachHls(hls, Hls, options) {
    options = options || {};
    var collector = createCollector();
    var Ctx = (typeof window !== 'undefined') && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
    var out = { collector: collector, supported: Boolean(Ctx), stopped: false, failed: 0, ok: 0, stop: function () { out.stopped = true; } };
    if (!Ctx) return out;

    var ctx = null;
    var queue = [];
    var running = false;
    var seen = {};

    function getCtx() {
      if (ctx) return ctx;
      var rates = [22050, 44100];
      for (var i = 0; i < rates.length && !ctx; i += 1) { try { ctx = new Ctx(1, 1, rates[i]); } catch (e) { ctx = null; } }
      return ctx;
    }

    function decode(u8) {
      var c = getCtx();
      if (!c) return Promise.reject(new Error('sem OfflineAudioContext'));
      var copy = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      return new Promise(function (resolve, reject) {
        var p = c.decodeAudioData(copy, resolve, reject);
        if (p && p.then) p.then(resolve, reject);
      });
    }

    function pump() {
      if (running || out.stopped) return;
      var job = queue.shift();
      if (!job) return;
      running = true;
      decode(job.adts).then(function (buf) {
        var len = buf.length;
        var mono = new Float32Array(len);
        var ch = buf.numberOfChannels;
        for (var c = 0; c < ch; c += 1) {
          var data = buf.getChannelData(c);
          for (var i = 0; i < len; i += 1) mono[i] += data[i] / ch;
        }
        collector.add(job.start, envelope(mono, buf.sampleRate));
        out.ok += 1;
        if (options.onData) options.onData(collector);
      }).catch(function () {
        out.failed += 1;
      }).then(function () { running = false; pump(); });
    }

    // Extrai o áudio na hora (síncrono, sem copiar o segmento todo): só o ADTS (~50 KB) fica na fila.
    function enqueue(start, payload) {
      if (out.stopped || !payload || !payload.byteLength) return;
      var key = Math.round(start * 10);
      if (seen[key]) return;      // já medido (seek para trás): não repete
      seen[key] = 1;
      var audio = null;
      try { audio = tsAudio(payload); } catch (e) { audio = null; }
      if (!audio) { out.failed += 1; return; }
      queue.push({ start: start, adts: audio.adts });
      if (queue.length > 80) queue.shift();
      pump();
    }

    // O hls.js (com worker) entrega o buffer ao demuxer ANTES de emitir FRAG_LOADED, deixando-o vazio ali.
    // Então copiamos no loader de fragmentos (que é quem recebe os bytes da rede), sem alterar nada do fluxo.
    // O loader é criado a cada fragmento lendo `config.fLoader`, por isso dá para trocar depois do `new Hls`.
    var Base = hls.config && (hls.config.fLoader || hls.config.loader || (Hls.DefaultConfig && Hls.DefaultConfig.loader));
    if (Base) {
      try {
        var Wrapped = class extends Base {
          load(context, config, callbacks) {
            var frag = context && context.frag;
            if (!frag || (frag.type && frag.type !== 'main' && frag.type !== 'audio')) return super.load(context, config, callbacks);
            var onSuccess = callbacks.onSuccess;
            var wrapped = Object.assign({}, callbacks, {
              onSuccess: function (response, stats, ctx, details) {
                try {
                  var data = response && response.data;
                  if (data && data.byteLength && !out.stopped) enqueue(frag.start, data);
                } catch (e) { /* medir é opcional: nunca atrapalha o vídeo */ }
                return onSuccess(response, stats, ctx, details);
              }
            });
            return super.load(context, config, wrapped);
          }
        };
        hls.config.fLoader = Wrapped;
        out.viaLoader = true;
      } catch (e) { out.viaLoader = false; }
    }

    // Plano B (outras versões do hls.js que ainda entregam o payload no evento).
    hls.on(Hls.Events.FRAG_LOADED, function (ev, data) {
      if (out.stopped || !data || !data.frag || !data.payload || !data.payload.byteLength) return;
      if (data.frag.type && data.frag.type !== 'main' && data.frag.type !== 'audio') return;
      enqueue(data.frag.start, data.payload);
    });
    return out;
  }

  return {
    BIN: BIN,
    tsAudio: tsAudio,
    envelope: envelope,
    createCollector: createCollector,
    estimate: estimate,
    estimateChecked: estimateChecked,
    estimateAuto: estimateAuto,
    FPS_RATIOS: FPS_RATIOS,
    fitScale: fitScale,
    windows: windows,
    attachHls: attachHls
  };
});
