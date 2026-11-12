'use strict';

/**
 * Player de TV ao vivo que roda DENTRO da Vercel (via AdShield), para fontes HTTP/sem CORS.
 *
 * Por que existe: as Vercels já publicadas não têm as rotas /live/*, e a rota genérica do AdShield (/_adshield/r/<token>)
 * entrega HLS e TS, mas sem cabeçalho CORS, então o site (outro domínio) não consegue ler a resposta. Uma página que a
 * PRÓPRIA Vercel serve é "mesmo domínio" para o /_adshield/r/..., e aí o CORS não existe. O Render só gera este HTML
 * (poucos KB): o vídeo nunca passa por ele. O AdShield busca esta página no Render, reescreve os scripts do CDN para
 * passarem por ele e a entrega num iframe.
 *
 * O token é o mesmo do AdShield (assinado pelo Render): quem recebe esta página já recebia a URL da fonte no modo direto.
 * A URL do vídeo é ABSOLUTA (location.origin): o worker do mpegts.js não resolve caminho relativo.
 * Não use as palavras "popup"/"adblock" aqui: o sanitizador do AdShield descarta scripts com esses padrões.
 */

const HLS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1.7.4/dist/hls.min.js';
const MPEGTS_CDN = 'https://cdn.jsdelivr.net/npm/mpegts.js@1.8.2/dist/mpegts.js';

function validToken(token) {
  return /^[A-Za-z0-9_.-]{20,6000}$/.test(String(token || ''));
}

function playerHtml(token, kind) {
  if (!validToken(token)) throw new Error('token inválido');
  const isTs = kind === 'ts';
  const lib = isTs ? MPEGTS_CDN : HLS_CDN;
  const script = `
(function () {
  var SRC = location.origin + '/_adshield/r/' + ${JSON.stringify(String(token))}, IS_TS = ${isTs ? 'true' : 'false'};
  var v = document.getElementById('v'), note = document.getElementById('m');
  var started = false, frags = [], total = 0, lastT = Date.now(), tsMbps = null, recovered = false, reconnects = 0, player = null;
  function post(o) { o.fds = 'live'; try { parent.postMessage(o, '*'); } catch (e) {} }
  function say(t) { note.textContent = t || ''; }
  function fail(why) { post({ ev: 'error', detail: String(why) }); say('Sem sinal: ' + why); }
  v.addEventListener('playing', function () { started = true; say(''); post({ ev: 'playing', w: v.videoWidth, h: v.videoHeight }); });
  function tryPlay() {
    var p = v.play();
    if (p && p.catch) p.catch(function () { v.muted = true; v.play().catch(function () {}); say('Sem som: toque no volume do player'); });
  }
  setInterval(function () {
    var now = Date.now(), buf = 0, drop = 0;
    try { if (v.buffered && v.buffered.length) buf = Math.max(0, v.buffered.end(v.buffered.length - 1) - v.currentTime); } catch (e) {}
    try { var q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality(); if (q) drop = q.droppedVideoFrames; } catch (e) {}
    var cap = null, use = null, last = frags[frags.length - 1];
    if (tsMbps != null) { cap = tsMbps; use = tsMbps; }
    else {
      if (last && last.ms > 20 && now - last.t < 20000) cap = last.bytes * 8 / last.ms / 1000;
      var w = frags.filter(function (f) { return now - f.t < 12000; });
      if (w.length) use = w.reduce(function (a, f) { return a + f.bytes; }, 0) * 8 / 12 / 1e6;
    }
    post({ ev: 'stat', buf: buf, drop: drop, w: v.videoWidth, h: v.videoHeight, cap: cap, use: use, t: v.currentTime, paused: v.paused });
  }, 1000);

  function startHls() {
    // iPhone/iPad: o HLS nativo do Safari é o caminho confiável (MSE só existe a partir do iOS 17.1).
    var ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios && v.canPlayType('application/vnd.apple.mpegurl')) { v.src = SRC; tryPlay(); return; }
    if (!window.Hls || !Hls.isSupported()) { if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = SRC; tryPlay(); return; } return fail('navegador sem suporte a HLS'); }
    var h = new Hls({ enableWorker: true, lowLatencyMode: false, liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 10, maxBufferLength: 20, maxMaxBufferLength: 40, backBufferLength: 30,
      manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 3, fragLoadingRetryDelay: 600 });
    h.on(Hls.Events.FRAG_LOADED, function (e, d) {
      var st = d && d.frag && d.frag.stats; if (!st) return;
      var ms = st.loading && st.loading.end && st.loading.start ? st.loading.end - st.loading.start : 0;
      frags.push({ t: Date.now(), bytes: st.total || 0, ms: ms }); if (frags.length > 40) frags.shift();
      post({ ev: 'bytes', bytes: st.total || 0, dur: d.frag.duration || 0 });
    });
    h.on(Hls.Events.MANIFEST_PARSED, tryPlay);
    h.on(Hls.Events.ERROR, function (e, d) {
      if (!d || !d.fatal) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; h.recoverMediaError(); return; }
      fail((d.details || 'erro') + (d.response && d.response.code ? ' HTTP ' + d.response.code : ''));
    });
    h.loadSource(SRC); h.attachMedia(v);
  }

  function startTs() {
    if (!window.mpegts || !mpegts.getFeatureList().mseLivePlayback) return fail('navegador sem suporte a TS ao vivo');
    if (player) { try { player.destroy(); } catch (e) {} player = null; }
    var p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: SRC }, { enableWorker: true, lazyLoad: false, autoCleanupSourceBuffer: true,
      liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 8, liveBufferLatencyMinRemain: 1.5 });
    player = p;
    var lost = function (why) {
      if (player !== p) return;
      if (!started && reconnects >= 1) return fail(why);
      reconnects += 1;
      if (reconnects > 30) return fail('muitas reconexões');
      post({ ev: 'reconnect', n: reconnects });
      setTimeout(startTs, 500);   // a Vercel corta streams longos: reabre sozinho
    };
    p.on(mpegts.Events.ERROR, function (t, d) { lost(d || t); });
    p.on(mpegts.Events.LOADING_COMPLETE, function () { lost('fim do fluxo'); });
    p.on(mpegts.Events.STATISTICS_INFO, function (s) {
      var now = Date.now(), dt = Math.min(5, (now - lastT) / 1000); lastT = now;
      if (s.speed > 0) { tsMbps = s.speed * 8 / 1000; post({ ev: 'bytes', bytes: s.speed * 1024 * dt, dur: dt }); }
    });
    p.attachMediaElement(v); p.load(); var pr = p.play(); if (pr && pr.catch) pr.catch(function () { v.muted = true; try { p.play(); } catch (e) {} });
  }

  setTimeout(function () { if (!started && !note.textContent) fail('não começou a tocar'); }, 25000);
  if (IS_TS) startTs(); else startHls();
})();`;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TV ao vivo</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}video{width:100%;height:100%;background:#000;object-fit:contain}
#m{position:absolute;left:0;right:0;bottom:44px;text-align:center;color:#fff;font:13px/1.4 sans-serif;text-shadow:0 0 4px #000;pointer-events:none}</style>
</head><body><video id="v" controls autoplay playsinline></video><div id="m"></div>
<script src="${lib}"></script>
<script>${script}</script>
</body></html>`;
}

module.exports = { playerHtml, validToken };
