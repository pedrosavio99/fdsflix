'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const AS = require('../public/autosync.js');

/* ---------- gerador de sinal sintético: "fala" (ruído modulado a ~4 Hz) sobre fundo de "música" ---------- */

const SR = 22050;
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Falas em [start, end] (s) com intervalos aleatórios; devolve as falas e o áudio já atrasado em `delay`.
function makeSpeech(seconds, seed) {
  const r = rng(seed);
  const speech = [];
  let t = 3 + r() * 3;
  while (t < seconds - 8) {
    const dur = 1.5 + r() * 4;
    speech.push({ s: t, e: t + dur });
    t += dur + 1 + r() * 4;
  }
  return speech;
}

function makeScene(seconds, delay, seed, withMusic = true) {
  const speech = makeSpeech(seconds, seed);
  const n = Math.round(seconds * SR);
  const pcm = new Float32Array(n);
  const rr = rng(seed + 99);
  for (let i = 0; i < n; i += 1) {
    const tt = i / SR;
    let v = (rr() - 0.5) * 0.02;                                        // ruído de fundo
    if (withMusic) v += 0.15 * Math.sin(2 * Math.PI * 440 * tt) * (0.8 + 0.2 * Math.sin(2 * Math.PI * 0.3 * tt)); // "música" contínua
    pcm[i] = v;
  }
  for (const sp of speech) {
    const a = Math.round((sp.s + delay) * SR);
    const b = Math.round((sp.e + delay) * SR);
    for (let i = Math.max(0, a); i < Math.min(n, b); i += 1) {
      const tt = i / SR;
      const syl = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 4 * (tt - sp.s))), 0.7); // sílabas ~4 Hz
      pcm[i] += (rr() - 0.5) * 0.9 * syl;
    }
  }
  return { speech, pcm };
}

// Alimenta o coletor como o hls.js: segmentos de ~5 s.
function feed(collector, pcm, fromSec, toSec, segSec = 5.005) {
  for (let t = fromSec; t < toSec; t += segSec) {
    const a = Math.round(t * SR);
    const b = Math.min(pcm.length, Math.round((t + segSec) * SR));
    if (b - a < SR) break;
    collector.add(t, AS.envelope(pcm.subarray(a, b), SR));
  }
}

/* ---------- estimate ---------- */

test('estimate: acha atrasos pequenos, médios e grandes (positivos e negativos)', () => {
  for (const delay of [0, 1.3, -2.7, 8.4, -25, 47.9]) {
    const { speech, pcm } = makeScene(360, delay, 11);
    const col = AS.createCollector();
    feed(col, pcm, 0, 360);
    const est = AS.estimate(col, speech, { maxLag: 120 });
    assert.ok(est, `sem resultado para ${delay}`);
    assert.ok(Math.abs(est.offset - delay) <= 0.25, `esperava ~${delay}, veio ${est.offset.toFixed(2)}`);
    assert.ok(est.conf > 4.5, `confiança baixa (${est.conf.toFixed(1)}) para ${delay}`);
  }
});

test('estimate: janela solta no meio do filme (só 5 min ouvidos, a partir de 10 min)', () => {
  const { speech, pcm } = makeScene(1000, 3.1, 5);
  const col = AS.createCollector();
  feed(col, pcm, 600, 900);
  const est = AS.estimate(col, speech, { maxLag: 60 });
  assert.ok(est && Math.abs(est.offset - 3.1) <= 0.25, JSON.stringify(est));
});

test('estimate: o parâmetro center desloca o centro da busca', () => {
  const { speech, pcm } = makeScene(300, 40, 21);
  const col = AS.createCollector();
  feed(col, pcm, 0, 300);
  const near = AS.estimate(col, speech, { maxLag: 10, center: 40 });
  assert.ok(near && Math.abs(near.offset - 40) <= 0.25, JSON.stringify(near));
});

test('estimate: sem áudio suficiente ou com poucas falas devolve null', () => {
  const col = AS.createCollector();
  assert.equal(AS.estimate(col, [{ s: 1, e: 2 }]), null);
  const { speech, pcm } = makeScene(300, 0, 3);
  feed(col, pcm, 0, 10); // 10 s: menos que o mínimo
  assert.equal(AS.estimate(col, speech), null);
  const col2 = AS.createCollector();
  feed(col2, pcm, 0, 300);
  assert.equal(AS.estimate(col2, speech.slice(0, 3)), null);
});

/* ---------- estimateChecked (prova pelas metades) ---------- */

test('estimateChecked: aceita o atraso real', () => {
  const { speech, pcm } = makeScene(420, -4.4, 31);
  const col = AS.createCollector();
  feed(col, pcm, 0, 420);
  const res = AS.estimateChecked(col, speech);
  assert.equal(res.ok, true, res.reason);
  assert.ok(Math.abs(res.offset + 4.4) <= 0.25);
});

test('estimateChecked: legenda de OUTRO filme (falas sem relação com o áudio) não é aplicada', () => {
  // Várias combinações independentes: o sistema quase nunca pode aceitar (limite: 1 em 24).
  let accepted = 0;
  let tries = 0;
  for (let k = 0; k < 4; k += 1) {
    const audio = makeScene(300, 0, 100 + k);
    const col = AS.createCollector();
    feed(col, audio.pcm, 0, 300);
    for (let j = 0; j < 6; j += 1) {
      tries += 1;
      if (AS.estimateChecked(col, makeSpeech(300, 5000 + k * 10 + j)).ok) accepted += 1; // falas sorteadas à parte
    }
  }
  assert.ok(accepted <= 1, `${accepted}/${tries} falsos positivos`);
});

test('estimateChecked: só música/ruído (sem fala) não produz ajuste', () => {
  const { speech } = makeScene(420, 0, 77);
  const n = 420 * SR;
  const pcm = new Float32Array(n);
  const r = rng(4);
  for (let i = 0; i < n; i += 1) pcm[i] = (r() - 0.5) * 0.02 + 0.2 * Math.sin(2 * Math.PI * 330 * i / SR);
  const col = AS.createCollector();
  feed(col, pcm, 0, 420);
  assert.equal(AS.estimateChecked(col, speech).ok, false);
});

test('estimateChecked: atraso grande exige mais confiança que o pequeno', () => {
  const { speech, pcm } = makeScene(420, 60, 41);
  const col = AS.createCollector();
  feed(col, pcm, 0, 420);
  const loose = AS.estimateChecked(col, speech, { farConf: 4.5 });
  assert.equal(loose.ok, true, loose.reason);
  const strict = AS.estimateChecked(col, speech, { farConf: 1e9 });
  assert.equal(strict.ok, false);
  assert.equal(strict.reason, 'confiança baixa');
});

/* ---------- fitScale ---------- */

test('fitScale: recupera atraso + escala (legenda de outro fps)', () => {
  // legenda 23.976 -> vídeo 25 fps: d(t) = a + b*t
  const a = 2, b = 0.0427;
  const points = [600, 2400, 4200, 6000].map((t) => ({ t, d: a + b * t }));
  const fit = AS.fitScale(points, 900);
  assert.ok(Math.abs(fit.offset - a) < 1e-9);
  assert.ok(Math.abs(fit.scale - (1 + b)) < 1e-9);
  assert.ok(fit.resid < 1e-9);
});

test('fitScale: sem pontos suficientes ou muito próximos não ajusta', () => {
  assert.equal(AS.fitScale([{ t: 10, d: 1 }, { t: 20, d: 1 }], 900), null);
  assert.equal(AS.fitScale([{ t: 10, d: 1 }, { t: 20, d: 1 }, { t: 30, d: 1 }], 900), null);
});

/* ---------- tsAudio ---------- */

function tsPacket(pid, payload, pusi) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47;
  p[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  p[3] = 0x10; // só payload
  payload.copy(p, 4);
  return p;
}

function buildTs(adts, ptsSeconds) {
  const pat = Buffer.from([0, 0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe1, 0x00, 0, 0, 0, 0]);
  const pmt = Buffer.from([
    0, 0x02, 0xb0, 0x17, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00,
    0x1b, 0xe1, 0x02, 0xf0, 0x00,            // vídeo H.264 (pid 0x102)
    0x0f, 0xe1, 0x01, 0xf0, 0x00,            // áudio AAC ADTS (pid 0x101)
    0, 0, 0, 0
  ]);
  const pts = Math.round(ptsSeconds * 90000);
  const hdr = Buffer.alloc(14);
  hdr.set([0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 5]);
  hdr[9] = 0x21 | (Math.floor(pts / 2 ** 30) & 7) << 1;
  hdr[10] = Math.floor(pts / 2 ** 22) & 0xff;
  hdr[11] = ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1;
  hdr[12] = Math.floor(pts / 2 ** 7) & 0xff;
  hdr[13] = ((pts & 0x7f) << 1) | 1;
  const pes = Buffer.concat([hdr, Buffer.from(adts)]);
  assert.equal(pes.length % 184, 0);
  const pkts = [tsPacket(0, pat, true), tsPacket(0x100, pmt, true)];
  // pacote de vídeo no meio (precisa ser ignorado)
  pkts.push(tsPacket(0x102, Buffer.from([0, 0, 1, 0xe0, 1, 2, 3, 4]), true));
  for (let o = 0; o < pes.length; o += 184) pkts.push(tsPacket(0x101, pes.subarray(o, o + 184), o === 0));
  return Buffer.concat(pkts);
}

test('tsAudio: extrai o ADTS e o PTS de um segmento MPEG-TS (ignorando o vídeo)', () => {
  const adts = Buffer.alloc(184 * 3 - 14);
  for (let i = 0; i < adts.length; i += 1) adts[i] = (i * 7 + 3) & 0xff;
  adts[0] = 0xff; adts[1] = 0xf1;
  const ts = buildTs(adts, 300.3);
  const out = AS.tsAudio(ts);
  assert.ok(out);
  assert.ok(Math.abs(out.pts - 300.3) < 1e-4);
  assert.deepEqual(Buffer.from(out.adts), adts);
});

test('tsAudio: aceita ArrayBuffer e lixo antes do primeiro sincronismo; devolve null para dados que não são TS', () => {
  const adts = Buffer.alloc(184 * 2 - 14, 0x11);
  const ts = buildTs(adts, 12);
  const withJunk = Buffer.concat([Buffer.from([1, 2, 3, 4, 5]), ts]);
  const ab = withJunk.buffer.slice(withJunk.byteOffset, withJunk.byteOffset + withJunk.length);
  const out = AS.tsAudio(ab);
  assert.ok(out && Math.abs(out.pts - 12) < 1e-4);
  assert.equal(AS.tsAudio(Buffer.alloc(2000, 1)), null);
  assert.equal(AS.tsAudio(Buffer.alloc(10)), null);
  assert.equal(AS.tsAudio(new Uint8Array(0)), null);
});

test('tsAudio: segmento sem faixa AAC (só vídeo) devolve null', () => {
  const pat = Buffer.from([0, 0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe1, 0x00, 0, 0, 0, 0]);
  const pmt = Buffer.from([0, 0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00, 0x1b, 0xe1, 0x02, 0xf0, 0x00, 0, 0, 0, 0]);
  const ts = Buffer.concat([tsPacket(0, pat, true), tsPacket(0x100, pmt, true), tsPacket(0x102, Buffer.alloc(184, 1), true), tsPacket(0x102, Buffer.alloc(184, 2), false)]);
  assert.equal(AS.tsAudio(ts), null);
});

/* ---------- envelope / coletor ---------- */

test('envelope: devolve duas medidas por 100 ms e fala tem mais modulação que música', () => {
  const r = rng(8);
  const n = 5 * SR;
  const music = new Float32Array(n);
  const speech = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    music[i] = 0.2 * Math.sin(2 * Math.PI * 440 * i / SR);
    speech[i] = (r() - 0.5) * 0.8 * Math.max(0, Math.sin(2 * Math.PI * 4 * i / SR));
  }
  const em = AS.envelope(music, SR);
  const es = AS.envelope(speech, SR);
  assert.equal(em.e.length, 50);
  assert.equal(em.m.length, 50);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(mean(es.m) > mean(em.m) * 3, `modulação fala ${mean(es.m).toFixed(2)} vs música ${mean(em.m).toFixed(2)}`);
});

test('coletor: cresce sozinho, conta cobertura e ignora segmento com início negativo', () => {
  const col = AS.createCollector();
  const env = AS.envelope(new Float32Array(5 * SR), SR);
  col.add(10000, env); // longe: força crescimento do buffer
  col.add(-5, env);    // inválido
  col.add(0, env);
  assert.ok(Math.abs(col.coveredSeconds() - 10) < 0.2);
  const rg = col.range();
  assert.ok(rg.from === 0 && rg.to >= 10005 - 0.2);
});

test('windows: divide a cobertura em janelas e informa o instante mediano de cada uma', () => {
  const { pcm } = makeScene(700, 0, 9);
  const col = AS.createCollector();
  feed(col, pcm, 0, 300);
  feed(col, pcm, 400, 700);
  const w = AS.windows(col, 190);
  assert.equal(w.length, 3);
  assert.ok(w[0].from < 1 && w[0].seconds >= 189);
  w.forEach((x) => assert.ok(x.mid >= x.from && x.mid <= x.to));
  assert.deepEqual(AS.windows(AS.createCollector(), 100), []);
});

/* ---------- estimateAuto (hipóteses de fps) ---------- */

// Áudio com falas em s*escala + atraso; as falas da "legenda" ficam nos horários originais s.
function makeScaledScene(seconds, scale, delay, seed) {
  const speech = makeSpeech(seconds / scale, seed);
  const n = Math.round(seconds * SR);
  const pcm = new Float32Array(n);
  const rr = rng(seed + 7);
  for (let i = 0; i < n; i += 1) pcm[i] = (rr() - 0.5) * 0.02 + 0.15 * Math.sin(2 * Math.PI * 440 * i / SR);
  for (const sp of speech) {
    const a = Math.round((sp.s * scale + delay) * SR);
    const b = Math.round((sp.e * scale + delay) * SR);
    for (let i = Math.max(0, a); i < Math.min(n, b); i += 1) {
      const syl = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 4 * (i / SR - (sp.s * scale + delay)))), 0.7);
      pcm[i] += (rr() - 0.5) * 0.9 * syl;
    }
  }
  return { speech, pcm };
}

test('estimateAuto: legenda de outro fps (25/23,976) é detectada: razão e atraso', () => {
  const ratio = 25 / 23.976;
  const { speech, pcm } = makeScaledScene(900, ratio, 2, 51);
  const col = AS.createCollector();
  feed(col, pcm, 0, 900);
  const res = AS.estimateAuto(col, speech);
  assert.equal(res.ok, true, res.reason);
  assert.ok(Math.abs(res.ratio - ratio) < 1e-9, `razão ${res.ratio}`);
  assert.ok(Math.abs(res.offset - 2) <= 0.3, `atraso ${res.offset}`);
});

test('estimateAuto: sem escala devolve razão 1; escala só é testada com áudio suficiente', () => {
  const { speech, pcm } = makeScene(420, 5, 71);
  const col = AS.createCollector();
  feed(col, pcm, 0, 420);
  const res = AS.estimateAuto(col, speech);
  assert.equal(res.ok, true);
  assert.equal(res.ratio, 1);

  const ratio = 25 / 24;
  const scaled = makeScaledScene(900, ratio, 0, 52);
  const short = AS.createCollector();
  feed(short, scaled.pcm, 0, 200);   // pouco áudio: não arrisca hipótese de escala
  assert.equal(AS.estimateAuto(short, scaled.speech).ok, false);
});

test('estimateAuto: legenda sem relação com o áudio não vira escala nem atraso', () => {
  let accepted = 0;
  let tries = 0;
  for (let k = 0; k < 3; k += 1) {
    const audio = makeScene(420, 0, 300 + k);
    const col = AS.createCollector();
    feed(col, audio.pcm, 0, 420);
    for (let j = 0; j < 6; j += 1) {
      tries += 1;
      if (AS.estimateAuto(col, makeSpeech(420, 8000 + k * 10 + j)).ok) accepted += 1;
    }
  }
  assert.ok(accepted <= 1, `${accepted}/${tries} falsos positivos`);
});
