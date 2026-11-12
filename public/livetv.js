/*
 * fdsFlix - aba "TV ao vivo".
 *
 * Módulo separado do player de filmes (nada aqui mexe no fluxo de títulos). Pede ao servidor
 * /api/live/channels e /api/live/stream; o servidor testa as fontes (cascata própria) e diz por onde
 * o vídeo vai: direto da fonte, pela Vercel ou, para páginas de player, pelo AdShield (sem anúncios).
 * O vídeo NUNCA passa pelo Render: aqui só chegam alguns KB de JSON.
 */
(function () {
  'use strict';

  var openBtn = document.getElementById('liveOpen');
  if (!openBtn) return;

  var CONFIG = window.__FDSFLIX_CONFIG__ || {};
  var API_BASE = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  var MAX_ATTEMPTS = 4;          // fontes diferentes tentadas antes de desistir
  var START_TIMEOUT_MS = 16000;  // sem quadro tocando nesse tempo = fonte ruim
  var STORE_KEY = 'fdsflix.live';
  // MPEG-TS cru (ESPN 2, SporTV 3, Premiere...): tocado por mpegts.js, carregado só quando um canal precisa (CDN; cópia local de reserva).
  var MPEGTS_CDN = 'https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js';
  var MPEGTS_SRI = 'sha384-gWBszQzp4KdKY3PNUrFbTuvAcChcUSMKpSrt/OjDS3qe16Ef4OZSfP5E/+KcPueP';
  var MAX_RECONNECTS = 30;       // a Vercel corta streams longos (~5 min); reconecta sozinho

  var state = {
    open: false, data: null, group: '', onlyLive: false,
    cur: null, seq: 0, hls: null, ts: null, tsLast: null, watch: 0, poll: 0, polls: 0,
    log: [], diag: null, diagAt: 0, diagTimer: 0, diagBusy: false, netTimer: 0,
    net: { frags: [], samples: [], bytes: 0, count: 0, tsMbps: null }
  };
  var els = {};

  /* ------------------------------- utilitários ------------------------------ */

  function api(path) {
    var headers = {};
    if (CONFIG.apiKey) headers['x-api-key'] = CONFIG.apiKey;
    return fetch(API_BASE + path, { headers: headers, cache: 'no-store' });
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'text') node.textContent = attrs[key];
      else if (key === 'class') node.className = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  /* Registro do navegador para a área nerd (só memória; nada sai daqui sem o administrador copiar). */
  function nlog(type, msg) {
    state.log.push({ t: Date.now(), type: type, msg: String(msg).slice(0, 300) });
    if (state.log.length > 200) state.log.shift();
    if (els.nerd && els.nerd.open) { clearTimeout(state.logPaint); state.logPaint = setTimeout(renderCli, 150); }
  }
  function shortUrl(u) {
    try { var x = new URL(u, location.href); return x.host + x.pathname.replace(/([A-Za-z0-9_-]{20,})/g, function (m) { return m.slice(0, 4) + '…'; }) + (x.search ? '?…' : ''); } catch (e) { return String(u).slice(0, 60); }
  }
  function adminKey() { try { return localStorage.getItem('fdsflix.adminKey') || ''; } catch (e) { return ''; } }

  function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function save(patch) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(Object.assign(load(), patch))); } catch (e) { /* sem storage */ }
  }

  /* --------------------------------- estilo --------------------------------- */

  var css = [
    '.ltv{position:fixed;inset:0;z-index:25;background:var(--bg);overflow-y:auto;overscroll-behavior:contain;',
    '  padding:calc(var(--nav-h) + 1rem) var(--gutter) calc(2rem + env(safe-area-inset-bottom,0px));}',
    '.ltv[hidden]{display:none}',
    '/* com a TV aberta a barra do topo fica sólida, senão o conteúdo rola por baixo do logo */',
    'html.ltv-open .topbar{background:rgba(11,11,16,.94);-webkit-backdrop-filter:saturate(1.4) blur(18px);backdrop-filter:saturate(1.4) blur(18px);',
    '  box-shadow:0 1px 0 rgba(255,255,255,.06)}',
    '.ltv-wrap{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:1.1rem}',
    '.ltv-head{display:flex;align-items:center;gap:.8rem;flex-wrap:wrap}',
    '.ltv-head h2{margin:0;font-size:clamp(1.3rem,2.6vw,1.8rem);letter-spacing:-.02em}',
    '.ltv-live{display:inline-flex;align-items:center;gap:.4rem;font-size:.72rem;font-weight:800;letter-spacing:.08em;',
    '  text-transform:uppercase;color:#fff;background:var(--brand);padding:.2rem .55rem;border-radius:6px}',
    '.ltv-live::before{content:"";width:7px;height:7px;border-radius:50%;background:#fff;animation:ltvPulse 1.4s ease-in-out infinite}',
    '@keyframes ltvPulse{50%{opacity:.25}}',
    '.ltv-sub{color:var(--muted);font-size:.88rem;margin-left:auto}',
    '.ltv-stage{display:flex;flex-direction:column;gap:.7rem}',
    '.ltv-stage[hidden]{display:none}',
    '.ltv-screen{position:relative;width:100%;aspect-ratio:16/9;max-height:68vh;background:#000;border-radius:var(--radius);',
    '  overflow:hidden;border:1px solid var(--line)}',
    '.ltv-screen video,.ltv-screen iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000}',
    '.ltv-screen video[hidden],.ltv-screen iframe[hidden]{display:none}',
    '.ltv-msg{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.7rem;',
    '  padding:1rem;text-align:center;background:rgba(0,0,0,.72);color:var(--text);font-size:.95rem}',
    '.ltv-msg[hidden]{display:none}',
    '.ltv-msg .spinner{display:block}',
    '.ltv-info{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;font-size:.88rem;color:var(--muted)}',
    '.ltv-info b{color:var(--text);font-size:1rem}',
    '.ltv-info .ltv-actions{margin-left:auto;display:flex;gap:.5rem;flex-wrap:wrap}',
    '.ltv-bar{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}',
    '.ltv-chip{background:var(--panel-2);border:1px solid var(--line);color:var(--text);border-radius:999px;padding:.4rem .9rem;',
    '  font-size:.84rem;font-weight:600}',
    '.ltv-chip[aria-pressed="true"]{background:var(--brand);border-color:var(--brand);color:#fff}',
    '.ltv-bar .switch{margin-left:auto}',
    '.ltv-group{display:flex;flex-direction:column;gap:.55rem}',
    '.ltv-group h3{margin:.4rem 0 0;font-size:.82rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}',
    '.ltv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:var(--gap)}',
    '.ltv-ch{display:flex;align-items:center;gap:.6rem;text-align:left;background:var(--panel);border:1px solid var(--line);',
    '  color:var(--text);border-radius:10px;padding:.8rem .9rem;min-height:56px}',
    '.ltv-ch:hover{background:var(--panel-2);border-color:#3a3a4e;filter:none}',
    '.ltv-ch[aria-current="true"]{border-color:var(--brand);box-shadow:0 0 0 1px var(--brand) inset}',
    '.ltv-ch .nm{flex:1;min-width:0;font-weight:700;font-size:.92rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ltv-ch.down{opacity:.55}',
    '.ltv-dot{flex:none;width:10px;height:10px;border-radius:50%;background:#5b5b6e}',
    '.ltv-dot.ok{background:var(--ok);box-shadow:0 0 0 3px rgba(53,208,127,.2)}',
    '.ltv-dot.unknown{background:var(--warn);animation:ltvPulse 1.2s ease-in-out infinite}',
    '.ltv-dot.raw{background:#8a7bd9}',
    '.ltv-empty{color:var(--muted);padding:1rem 0}',
    '.ltv-note{color:var(--muted);font-size:.8rem;line-height:1.5}',
    '.ltv-nerd{border:1px dashed var(--line);border-radius:10px;padding:.6rem .8rem;background:var(--panel)}',
    '.ltv-nerd>summary{cursor:pointer;font-weight:700;font-size:.9rem;color:var(--muted)}',
    '.ltv-nerd-bar{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.7rem 0}',
    '.ltv-nerd-bar select{background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:.4rem .6rem;max-width:100%}',
    '.ltv-nerd-bar label{display:inline-flex;align-items:center;gap:.35rem;font-size:.82rem;color:var(--muted)}',
    '.ltv-nerd-warn{color:var(--warn);font-size:.8rem;margin:0 0 .5rem}',
    '.ltv-nerd h4{margin:.9rem 0 .4rem;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}',
    '.ltv-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.5rem;margin-bottom:.7rem}',
    '.ltv-tile{background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:.45rem .6rem;display:flex;flex-direction:column;gap:.15rem;min-width:0}',
    '.ltv-tile span{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}',
    '.ltv-tile b{font:600 .85rem ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}',
    '.ltv-chartbox{background:#07070b;border:1px solid var(--line);border-radius:8px;padding:.4rem .5rem .3rem}',
    '.ltv-chart{display:block;width:100%;height:130px}',
    '.ltv-legend{display:flex;gap:1rem;flex-wrap:wrap;font-size:.72rem;margin-top:.2rem}',
    '.ltv-legend .g{color:#7ee2a8}.ltv-legend .a{color:#ffd479}.ltv-legend .b{color:#7fb2ff}',
    '.ltv-log{max-height:260px;overflow:auto;background:#07070b;border:1px solid var(--line);border-radius:8px;padding:.5rem .7rem;',
    '  font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;user-select:text}',
    '.ltv-log.tall{max-height:60vh}',
    '.ltv-log div{white-space:pre-wrap;word-break:break-all}',
    '.ltv-log .step{color:#9fd1ff;font-weight:700;margin-top:.35rem}.ltv-log .ok{color:#7ee2a8}.ltv-log .warn{color:#ffd479}',
    '.ltv-log .err{color:#ff8f8f}.ltv-log .info{color:#c9d4e3}.ltv-log .dim{color:#7d8597}',
    '.ltv-nerd pre{margin:0;max-height:60vh;overflow:auto;background:#07070b;border:1px solid var(--line);border-radius:8px;padding:.7rem;',
    '  font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-all;color:#cfd2dc;user-select:text}',
    '@media (max-width:640px){.ltv{padding-top:calc(var(--nav-h) + .6rem)}.ltv-screen{max-height:none}.ltv-sub{margin-left:0;width:100%}}'
  ].join('\n');
  document.head.appendChild(el('style', { text: css }));

  /* ---------------------------------- DOM ----------------------------------- */

  function build() {
    els.root = el('section', { id: 'liveTv', class: 'ltv', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'ltvTitle', hidden: '' });

    els.sub = el('span', { class: 'ltv-sub', text: '' });
    var head = el('div', { class: 'ltv-head' }, [
      el('span', { class: 'ltv-live', text: 'Ao vivo' }),
      el('h2', { id: 'ltvTitle', text: 'TV ao vivo' }),
      els.sub,
      (els.close = el('button', { class: 'ghost', type: 'button', 'aria-label': 'Fechar a TV ao vivo (Esc)', text: '✕ Fechar' }))
    ]);

    els.video = el('video', { controls: '', playsinline: '', preload: 'none', 'aria-label': 'Transmissão ao vivo' });
    els.frame = el('iframe', {
      hidden: '', title: 'Transmissão ao vivo (player sem anúncios)', allowfullscreen: '',
      allow: 'autoplay; fullscreen; encrypted-media; picture-in-picture', referrerpolicy: 'origin'
    });
    els.msgText = el('div', { text: '' });
    els.spin = el('div', { class: 'spinner' });
    els.retry = el('button', { class: 'ghost', type: 'button', hidden: '', text: 'Tentar outra fonte' });
    els.msg = el('div', { class: 'ltv-msg', role: 'status', 'aria-live': 'polite', hidden: '' }, [els.spin, els.msgText, els.retry]);

    els.name = el('b', { text: '' });
    els.via = el('span', { text: '' });
    els.next = el('button', { class: 'ghost', type: 'button', text: '⏭ Outra fonte' });
    els.reload = el('button', { class: 'ghost', type: 'button', text: '↻ Recarregar' });
    els.stage = el('div', { class: 'ltv-stage', hidden: '' }, [
      el('div', { class: 'ltv-screen' }, [els.video, els.frame, els.msg]),
      el('div', { class: 'ltv-info' }, [els.name, els.via, el('div', { class: 'ltv-actions' }, [els.next, els.reload])])
    ]);

    els.chips = el('div', { class: 'ltv-bar', role: 'group', 'aria-label': 'Filtrar por categoria' });
    els.onlyLive = el('input', { id: 'ltvOnlyLive', type: 'checkbox' });
    var sw = el('label', { class: 'switch', title: 'Mostra só os canais que têm uma fonte funcionando agora' }, [
      els.onlyLive, el('span', { class: 'slider' }), el('span', { text: 'Só os que estão no ar' })
    ]);
    els.chips.appendChild(sw);
    els.list = el('div', { class: 'ltv-groups' });
    els.note = el('p', { class: 'ltv-note', text: 'Os canais são testados de verdade antes de abrir. O vídeo não passa pelo servidor do fdsFlix; ' +
      'fontes que são páginas de player abrem pelo AdShield, que tira os anúncios.' });

    buildNerd();
    els.root.appendChild(el('div', { class: 'ltv-wrap' }, [head, els.stage, els.chips, els.list, els.note, els.nerd]));
    document.body.appendChild(els.root);

    els.close.addEventListener('click', close);
    els.next.addEventListener('click', function () { if (state.cur) failSource('troca manual'); });
    els.reload.addEventListener('click', function () { if (state.cur) play(state.cur.id, true); });
    els.retry.addEventListener('click', function () { if (state.cur) { state.cur.attempt = 0; request(); } });
    els.onlyLive.addEventListener('change', function () { state.onlyLive = els.onlyLive.checked; save({ onlyLive: state.onlyLive }); renderList(); });
    els.video.addEventListener('playing', onPlaying);
    els.video.addEventListener('timeupdate', function () { if (els.video.currentTime > 0 && !els.video.paused) onPlaying(); });
  }

  /* ------------------------- área nerd (só administrador) ------------------- */

  function tile(key, label) {
    var v = el('b', { text: '–' });
    els.tile[key] = v;
    return el('div', { class: 'ltv-tile' }, [el('span', { text: label }), v]);
  }

  function buildNerd() {
    els.tile = {};
    els.nerdSel = el('select', { 'aria-label': 'Detalhar um canal' });
    els.nerdFull = el('input', { type: 'checkbox' });
    els.nerdAuto = el('input', { type: 'checkbox' });
    els.nerdWarn = el('p', { class: 'ltv-nerd-warn', hidden: '', text: '⚠ "URLs inteiras" inclui usuário/senha de painéis IPTV. Não cole isso em lugar público.' });
    var bRefresh = el('button', { class: 'ghost', type: 'button', text: '↻ Atualizar servidor' });
    var bRetest = el('button', { class: 'ghost', type: 'button', text: '🧪 Retestar canal' });
    var bCopy = el('button', { class: 'ghost', type: 'button', text: '📋 Copiar logs' });
    var bClear = el('button', { class: 'ghost', type: 'button', text: 'Limpar' });
    els.tiles = el('div', { class: 'ltv-tiles' }, [
      tile('down', '⬇ Rede (por baixada)'), tile('use', 'Consumo do vídeo'), tile('buf', 'Buffer'), tile('q', 'Qualidade'),
      tile('drop', 'Quadros perdidos'), tile('lat', 'Atraso ao vivo'), tile('tot', 'Baixado'), tile('net', 'Internet do aparelho')
    ]);
    els.chart = el('canvas', { class: 'ltv-chart', height: '130', role: 'img', 'aria-label': 'Gráfico da rede: velocidade de download, consumo do vídeo e buffer nos últimos 90 segundos' });
    els.chartLegend = el('div', { class: 'ltv-legend' }, [
      el('span', { class: 'lg g', text: '— velocidade da baixada' }), el('span', { class: 'lg a', text: '--- bitrate do vídeo' }),
      el('span', { class: 'lg b', text: '▮ buffer (0–30 s)' })
    ]);
    els.logCli = el('div', { class: 'ltv-log', 'aria-live': 'polite' });
    els.logSrv = el('div', { class: 'ltv-log tall' });
    els.nerd = el('details', { class: 'ltv-nerd admin-only' }, [
      el('summary', { text: '🤓 Área para nerds (administrador)' }),
      el('div', { class: 'ltv-nerd-bar' }, [
        bRefresh, bRetest, bCopy, bClear, els.nerdSel,
        el('label', {}, [els.nerdFull, el('span', { text: 'URLs inteiras' })]),
        el('label', {}, [els.nerdAuto, el('span', { text: 'Servidor sozinho (5 s)' })])
      ]),
      els.nerdWarn,
      els.tiles,
      el('div', { class: 'ltv-chartbox' }, [els.chart, els.chartLegend]),
      el('h4', { text: 'Navegador (ao vivo)' }), els.logCli,
      el('h4', { text: 'Servidor' }), els.logSrv
    ]);
    bRefresh.addEventListener('click', function () { loadDiag(); });
    bRetest.addEventListener('click', function () { loadDiag(state.cur ? state.cur.id : (els.nerdSel.value || '')); });
    bCopy.addEventListener('click', function () { copyReport(bCopy); });
    bClear.addEventListener('click', function () { state.log = []; renderCli(); });
    els.nerdSel.addEventListener('change', renderSrv);
    els.nerdFull.addEventListener('change', function () { els.nerdWarn.hidden = !els.nerdFull.checked; loadDiag(); });
    els.nerdAuto.addEventListener('change', function () {
      clearInterval(state.diagTimer);
      if (els.nerdAuto.checked) state.diagTimer = setInterval(function () { if (state.open && els.nerd.open) loadDiag(); }, 5000);
    });
    els.nerd.addEventListener('toggle', function () {
      if (!els.nerd.open) return;
      renderCli(); renderTiles(); drawChart();
      if (!state.diag) loadDiag();
    });
    window.addEventListener('resize', function () { if (state.open && els.nerd.open) drawChart(); });
  }

  /* --- métricas de rede do player (só coleta para administrador) --- */

  function netFrag(data) {
    if (!adminKey() || !data || !data.frag || !data.frag.stats) return;
    var st = data.frag.stats;
    var ms = st.loading && st.loading.end && st.loading.start ? st.loading.end - st.loading.start : 0;
    var bytes = st.total || 0;
    state.net.frags.push({ t: Date.now(), bytes: bytes, ms: ms, dur: data.frag.duration || 0 });
    if (state.net.frags.length > 40) state.net.frags.shift();
    state.net.bytes += bytes; state.net.count += 1;
  }

  function sampleNet() {
    if (!state.open || !adminKey()) return;
    var now = Date.now(), v = els.video, n = state.net, s = { t: now, cap: null, use: null, buf: 0, drop: 0, lat: null, h: 0, kbps: 0 };
    var recent = n.frags.filter(function (f) { return now - f.t < 20000; });
    var last = recent[recent.length - 1];
    if (n.tsMbps == null && last && last.ms > 20) s.cap = last.bytes * 8 / last.ms / 1000;                        // Mbps durante a baixada do último pedaço
    if (n.tsMbps != null) { s.cap = n.tsMbps; s.use = n.tsMbps; }
    var win = n.frags.filter(function (f) { return now - f.t < 12000; });
    if (n.tsMbps == null && win.length) s.use = win.reduce(function (a, f) { return a + f.bytes; }, 0) * 8 / 12 / 1e6; // Mbps médios consumidos
    try { if (v.buffered && v.buffered.length) s.buf = Math.max(0, v.buffered.end(v.buffered.length - 1) - v.currentTime); } catch (e) { /* ignora */ }
    try { var q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality(); if (q) s.drop = q.droppedVideoFrames; } catch (e) { /* ignora */ }
    if (state.hls) {
      try {
        var lv = state.hls.levels && state.hls.levels[state.hls.currentLevel];
        if (lv) { s.h = lv.height || 0; s.kbps = Math.round((lv.bitrate || 0) / 1000); }
        if (typeof state.hls.latency === 'number' && isFinite(state.hls.latency)) s.lat = state.hls.latency;
      } catch (e) { /* ignora */ }
    }
    if (n.ext && now - n.ext.t < 3500) {
      s.cap = n.ext.cap; s.use = n.ext.use; s.buf = n.ext.buf || 0; s.drop = n.ext.drop || 0; s.w = n.ext.w; s.h = n.ext.h;
    }
    n.samples.push(s);
    if (n.samples.length > 90) n.samples.shift();
    if (els.nerd && els.nerd.open) { renderTiles(); drawChart(); }
  }

  function fmt(n, d) { return n == null || !isFinite(n) ? '–' : n.toFixed(d == null ? 1 : d); }

  function renderTiles() {
    var s = state.net.samples[state.net.samples.length - 1] || {}, v = els.video, T = els.tile;
    T.down.textContent = s.cap == null ? '–' : fmt(s.cap) + ' Mbps';
    T.use.textContent = s.use == null ? '–' : fmt(s.use, 2) + ' Mbps';
    T.buf.textContent = s.buf == null ? '–' : fmt(s.buf) + ' s';
    T.q.textContent = (s.w ? s.w + 'x' + s.h : (v && v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : '–')) + (s.kbps ? ' · ' + s.kbps + ' kbps' : '');
    T.drop.textContent = s.drop == null ? '–' : String(s.drop);
    T.lat.textContent = s.lat == null ? '–' : fmt(s.lat) + ' s';
    T.tot.textContent = fmt(state.net.bytes / 1048576, 1) + ' MB' + (state.net.count ? ' · ' + state.net.count + ' pedaços' : '');
    var c = navigator.connection;
    T.net.textContent = c ? ((c.effectiveType || '?') + (c.downlink ? ' · ↓' + c.downlink + ' Mbps' : '') + (c.rtt ? ' · ' + c.rtt + ' ms' : '')) : 'sem dado do navegador';
  }

  function drawChart() {
    var c = els.chart;
    if (!c || !els.nerd.open) return;
    var w = c.clientWidth || 600, h = 130, dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    var S = state.net.samples, N = 90, step = w / (N - 1);
    var maxM = 2;
    S.forEach(function (s) { maxM = Math.max(maxM, s.cap || 0, s.use || 0); });
    maxM = Math.ceil(maxM * 1.15);
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1; g.fillStyle = '#7d8597'; g.font = '11px ui-monospace,monospace';
    for (var i = 0; i <= 3; i++) { var gy = Math.round(8 + i * (h - 16) / 3) + .5; g.beginPath(); g.moveTo(0, gy); g.lineTo(w, gy); g.stroke(); }
    g.fillText(maxM + ' Mbps', 4, 18); g.fillText('0', 4, h - 4);
    if (!S.length) { g.fillText('Sem dados ainda: toque num canal para começar a medir.', Math.max(8, w / 2 - 150), h / 2); return; }
    var X = function (idx) { return w - (S.length - 1 - idx) * step; };
    var Y = function (m) { return h - 8 - Math.min(1, m / maxM) * (h - 16); };
    g.beginPath(); g.moveTo(X(0), h - 8);
    S.forEach(function (s, idx) { g.lineTo(X(idx), h - 8 - Math.min(1, s.buf / 30) * (h - 16)); });
    g.lineTo(X(S.length - 1), h - 8); g.closePath();
    g.fillStyle = 'rgba(90,160,255,.22)'; g.fill();
    function line(key, color, dash) {
      g.beginPath(); g.strokeStyle = color; g.lineWidth = 2; g.setLineDash(dash || []);
      var started = false;
      S.forEach(function (s, idx) { if (s[key] == null) return; if (!started) { g.moveTo(X(idx), Y(s[key])); started = true; } else g.lineTo(X(idx), Y(s[key])); });
      g.stroke(); g.setLineDash([]);
    }
    line('cap', '#7ee2a8'); line('use', '#ffd479', [5, 4]);
  }

  /* --- linhas coloridas (mesmo estilo do diagnóstico dos filmes) --- */

  function cliClass(e) {
    var m = e.msg;
    if (e.type === 'abrir') return 'step';
    if (e.type === 'tocando') return 'ok';
    if (e.type === 'falhou' || e.type === 'rede') return 'err';
    if (e.type === 'hls') return /^FATAL/.test(m) ? 'err' : 'warn';
    if (e.type === 'diagnostico' || e.type === 'entrega') return 'warn';
    if (e.type === 'servidor') return /sem sinal/.test(m) ? 'err' : 'ok';
    return 'info';
  }
  function srvClass(tipo, msg) {
    if (tipo === 'teste') return /^OK/.test(msg) ? 'ok' : 'dim';
    if (tipo === 'cascata') return /sem sinal/.test(msg) ? 'err' : 'ok';
    if (tipo === 'entrega') return /pulada/.test(msg) ? 'warn' : 'ok';
    if (tipo === 'navegador') return 'warn';
    if (tipo === 'vercel') return 'err';
    if (tipo === 'retestar') return 'step';
    return 'info';
  }

  function two(n) { return n < 10 ? '0' + n : '' + n; }
  function clock(t) { var d = new Date(t); return two(d.getUTCHours()) + ':' + two(d.getUTCMinutes()) + ':' + two(d.getUTCSeconds()); }
  function yn(v) { return v === true ? 's' : v === false ? 'n' : '?'; }

  function cliLines() {
    var cur = state.cur, v = els.video, L = [];
    L.push(['step', '== NAVEGADOR ==']);
    L.push(['info', 'agora: ' + new Date().toISOString() + ' (horas em UTC, igual ao servidor)']);
    L.push(['info', 'navegador: ' + navigator.userAgent]);
    L.push(['info', 'tela: ' + window.innerWidth + 'x' + window.innerHeight + ' · dpr ' + (window.devicePixelRatio || 1)]);
    L.push(['info', 'hls.js: ' + (window.Hls ? ('v' + (Hls.version || '?') + (Hls.isSupported() ? ' (MSE ok)' : ' (sem MSE)')) : 'não carregou') +
      ' · HLS nativo: ' + (v && v.canPlayType('application/vnd.apple.mpegurl') ? 'sim' : 'não')]);
    L.push(['info', 'api: ' + (API_BASE || location.origin)]);
    var c = navigator.connection;
    if (c) L.push(['info', 'internet do aparelho: ' + (c.effectiveType || '?') + ' · ↓' + (c.downlink || '?') + ' Mbps · rtt ' + (c.rtt || '?') + ' ms' + (c.saveData ? ' · economia de dados LIGADA' : '')]);
    if (cur) {
      L.push(['info', 'canal atual: ' + cur.name + ' (' + cur.id + ') · fonte ' + (cur.sid || '-') + ' · tentativa ' + cur.attempt + '/' + MAX_ATTEMPTS + ' · puladas: ' + (cur.skip.join(',') || '-')]);
      L.push(['info', 'video: t=' + (v.currentTime || 0).toFixed(1) + 's · pausado=' + v.paused + ' · readyState=' + v.readyState + ' · ' + (v.videoWidth || 0) + 'x' + (v.videoHeight || 0)]);
    } else L.push(['dim', 'canal atual: nenhum']);
    var n = state.net, s = n.samples[n.samples.length - 1];
    if (s) L.push(['info', 'rede: baixada ' + fmt(s.cap) + ' Mbps · vídeo ' + fmt(s.use, 2) + ' Mbps · buffer ' + fmt(s.buf) + ' s · perdidos ' + s.drop + ' · total ' + fmt(n.bytes / 1048576) + ' MB' + (n.count ? ' em ' + n.count + ' pedaços' : '')]);
    L.push(['step', '== EVENTOS DO NAVEGADOR (últimos 80) ==']);
    state.log.slice(-80).forEach(function (e) { L.push([cliClass(e), clock(e.t) + ' ' + e.type + ' ' + e.msg]); });
    if (!state.log.length) L.push(['dim', '(vazio)']);
    return L;
  }

  function srvLines(only) {
    var d = state.diag, L = [];
    if (!d) return [['dim', '== SERVIDOR ==\n(sem dados; toque em "Atualizar servidor")']];
    L.push(['step', '== SERVIDOR ==']);
    var sv = d.servidor || {}, t = d.totais || {}, c = d.config || {};
    L.push(['info', 'hora: ' + d.agora + ' · node ' + sv.node + ' · no ar há ' + sv.uptimeMin + ' min · memória ' + sv.memoriaMB + ' MB']);
    L.push(['info', 'fontes: ' + t.fontes + ' · testadas ' + t.testadas + ' · HLS ' + t.hls + ' · TS cru ' + t.ts + ' · página ' + t.pagina + ' · mortas ' + t.mortas]);
    L.push(['info', 'config: varrer listas=' + c.varrerListas + ' · aquecer=' + c.aquecer + ' · listas lidas=' + c.listas + ' · entradas casadas=' + c.entradasCasadas +
      ' · listas atualizadas há ' + c.listasAtualizadasHaMin + ' min · testes em andamento=' + c.testesEmAndamento + ' · aquecendo=' + c.aquecendo]);
    L.push(['info', 'vercels (pool): ' + ((d.pool || []).join(', ') || 'nenhuma')]);
    (d.vercels || []).forEach(function (v) { L.push([v.serveTV ? 'ok' : 'err', '  rota ' + v.rota + ': serve TV=' + v.serveTV + ' (há ' + v.idadeS + 's)']); });
    L.push(['step', '== CANAIS ==']);
    (d.channels || []).forEach(function (ch) {
      var f = ch.fontes || [], ok = 0, dead = 0, untested = 0;
      f.forEach(function (s) { if (!s.teste) untested += 1; else if (s.teste.ok) ok += 1; else dead += 1; });
      var head = ch.name + ' [' + ch.id + '] status=' + (ch.status || '?') + ' · fontes ' + f.length + ' (ok ' + ok + ', mortas ' + dead + ', sem teste ' + untested + ')';
      L.push([ch.status === 'ok' ? 'ok' : (ch.status === 'down' ? 'err' : 'warn'), head]);
      if (only !== ch.id) return;
      f.slice(0, 40).forEach(function (s) {
        var h = s.teste, res = !h ? 'sem teste' : (h.ok ? ('OK ' + h.tipo) : ('FALHA ' + h.motivo));
        L.push([!h ? 'dim' : (h.ok ? 'ok' : 'dim'), '  ' + s.sid + ' ' + s.origem + (s.pagina ? ' (página)' : '') + ' · ' + res +
          (h ? ' · ' + h.ms + 'ms · https=' + yn(h.https) + ' porta=' + (h.porta || '-') + ' cors=' + yn(h.cors) + ' · há ' + h.idadeS + 's' + (h.foraDaRotacaoS ? ' · fora ' + h.foraDaRotacaoS + 's' : '') : '')]);
        L.push(['dim', '      ' + s.url]);
      });
      if (f.length > 40) L.push(['dim', '  … +' + (f.length - 40) + ' fontes']);
    });
    var evs = d.eventos || [];
    var main = evs.filter(function (e) { return e.tipo !== 'teste'; }).slice(-70);
    var tests = evs.filter(function (e) { return e.tipo === 'teste'; }).slice(-15);
    L.push(['step', '== EVENTOS DO SERVIDOR: cascata, entrega, Vercel (últimos 70) ==']);
    main.forEach(function (e) { L.push([srvClass(e.tipo, e.msg), e.hora + ' ' + e.tipo + ' ' + e.msg]); });
    if (!main.length) L.push(['dim', '(vazio)']);
    L.push(['step', '== ÚLTIMOS TESTES DE FONTE (15) ==']);
    tests.forEach(function (e) { L.push([srvClass(e.tipo, e.msg), e.hora + ' ' + e.msg]); });
    return L;
  }

  function paint(box, lines, stick) {
    var keep = !stick ? box.scrollTop : 0;
    box.textContent = '';
    lines.forEach(function (ln) { box.appendChild(el('div', { class: ln[0], text: ln[1] })); });
    box.scrollTop = stick ? box.scrollHeight : keep;
  }

  function renderCli() { if (els.logCli && els.nerd.open) paint(els.logCli, cliLines(), true); }
  function renderSrv() { if (els.logSrv) paint(els.logSrv, srvLines(els.nerdSel.value), false); }

  function reportText() {
    var all = cliLines().concat(srvLines(els.nerdSel.value));
    return '== fdsFlix · TV ao vivo · relatório ==\n' + all.map(function (l) { return l[1]; }).join('\n') + '\n';
  }

  function loadDiag(retest) {
    var key = adminKey();
    if (!key) { paint(els.logSrv, [['warn', 'Entre no modo administrador (senha) para ver os dados do servidor.']], false); return Promise.resolve(); }
    if (state.diagBusy) return Promise.resolve();
    state.diagBusy = true;
    var q = '/api/live/diag?' + (els.nerdFull.checked ? 'full=1&' : '') + (retest ? 'retest=' + encodeURIComponent(retest) : '');
    var headers = { 'x-stats-key': key };
    if (CONFIG.apiKey) headers['x-api-key'] = CONFIG.apiKey;
    if (retest) paint(els.logSrv, [['warn', 'Retestando as fontes de ' + retest + '… (pode levar até ~25 s)']], false);
    return fetch(API_BASE + q, { headers: headers, cache: 'no-store' }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (res) {
      state.diagBusy = false;
      if (!res.ok) { state.diag = null; paint(els.logSrv, [['err', 'O servidor recusou (HTTP ' + res.status + '): ' + ((res.j && res.j.error) || '')]], false); return; }
      state.diag = res.j; state.diagAt = Date.now();
      fillSelect();
      renderSrv();
    }).catch(function (e) {
      state.diagBusy = false;
      paint(els.logSrv, [['err', 'Falha ao buscar o diagnóstico: ' + e.message + ' (o Render pode estar acordando; tente de novo)']], false);
    });
  }

  function fillSelect() {
    var d = state.diag, keep = els.nerdSel.value;
    els.nerdSel.textContent = '';
    els.nerdSel.appendChild(el('option', { value: '', text: 'Resumo (todos os canais)' }));
    (d && d.channels || []).forEach(function (c) { els.nerdSel.appendChild(el('option', { value: c.id, text: 'Detalhar: ' + c.name })); });
    els.nerdSel.value = keep;
  }

  function copyReport(btn) {
    var old = btn.textContent;
    btn.textContent = '… buscando dados frescos';
    // O relatório sempre sai com o estado atual do servidor, não com o de quando a seção foi aberta.
    loadDiag().then(function () {
      var text = reportText();
      var done = function (ok) { btn.textContent = ok ? '✔ Copiado' : '✖ Não deu; selecione o texto'; setTimeout(function () { btn.textContent = old; }, 1800); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      else {
        var ta = el('textarea', { style: 'position:fixed;left:-9999px' });
        ta.value = text; document.body.appendChild(ta); ta.select();
        var ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* ignora */ }
        ta.remove(); done(ok);
      }
    });
  }

  /* ------------------------------ lista de canais --------------------------- */

  var ORDER = { ok: 0, unknown: 1, raw: 2, down: 3 };
  var LABEL = { ok: 'no ar', unknown: 'testando', raw: 'só TS cru (sem suporte)', down: 'fora do ar agora' };

  function renderChips() {
    var data = state.data;
    Array.prototype.slice.call(els.chips.querySelectorAll('.ltv-chip')).forEach(function (n) { n.remove(); });
    var names = [''].concat(data ? data.groups : []);
    names.forEach(function (name, i) {
      var chip = el('button', { class: 'ltv-chip', type: 'button', 'aria-pressed': String(state.group === name), text: name || 'Todos' });
      chip.addEventListener('click', function () { state.group = name; save({ group: name }); renderChips(); renderList(); });
      els.chips.insertBefore(chip, els.chips.lastChild);
    });
  }

  function renderList() {
    var data = state.data;
    els.list.textContent = '';
    if (!data) { els.list.appendChild(el('p', { class: 'ltv-empty', text: 'Carregando os canais…' })); return; }
    var shown = 0;
    data.groups.forEach(function (group) {
      if (state.group && state.group !== group) return;
      var items = data.channels.filter(function (c) { return c.group === group && (!state.onlyLive || c.status === 'ok'); });
      if (!items.length) return;
      items = items.map(function (c, i) { return { c: c, i: i }; })
        .sort(function (a, b) { return (ORDER[a.c.status] - ORDER[b.c.status]) || (a.i - b.i); })
        .map(function (x) { return x.c; });
      var grid = el('div', { class: 'ltv-grid' });
      items.forEach(function (c) {
        var btn = el('button', {
          class: 'ltv-ch' + (c.status === 'down' ? ' down' : ''), type: 'button', 'data-id': c.id,
          'aria-label': c.name + ', ' + LABEL[c.status] }, [
          el('span', { class: 'ltv-dot ' + c.status, title: LABEL[c.status] }),
          el('span', { class: 'nm', text: c.name })
        ]);
        if (state.cur && state.cur.id === c.id) btn.setAttribute('aria-current', 'true');
        btn.addEventListener('click', function () { play(c.id); });
        grid.appendChild(btn);
        shown += 1;
      });
      els.list.appendChild(el('div', { class: 'ltv-group' }, [el('h3', { text: group }), grid]));
    });
    if (!shown) {
      els.list.appendChild(el('p', { class: 'ltv-empty', text: state.onlyLive
        ? 'Nenhum canal está no ar agora. Aguarde alguns segundos (os testes ainda rodam) ou desligue o filtro.'
        : 'Nenhum canal nesta categoria.' }));
    }
    var live = data.channels.filter(function (c) { return c.status === 'ok'; }).length;
    var unknown = data.channels.filter(function (c) { return c.status === 'unknown'; }).length;
    els.sub.textContent = live + ' no ar de ' + data.channels.length + (unknown ? ' · testando ' + unknown + '…' : '');
  }

  function refresh() {
    return api('/api/live/channels').then(function (r) { return r.json(); }).then(function (data) {
      state.data = data;
      renderChips();
      renderList();
      return data;
    }).catch(function () {
      if (!state.data) els.list.textContent = '', els.list.appendChild(el('p', { class: 'ltv-empty', text: 'Não consegui falar com o servidor. Tente de novo em instantes.' }));
    });
  }

  function schedulePoll() {
    clearTimeout(state.poll);
    if (!state.open) return;
    var pending = state.data && state.data.channels.some(function (c) { return c.status === 'unknown'; });
    state.polls += 1;
    var wait = pending && state.polls < 30 ? 3500 : 45000;
    state.poll = setTimeout(function () { refresh().then(schedulePoll); }, wait);
  }

  /* -------------------------------- reprodução ------------------------------ */

  function setMsg(text, kind, retry) {
    if (!text) { els.msg.hidden = true; return; }
    els.msg.hidden = false;
    els.msgText.textContent = text;
    els.spin.hidden = kind !== 'work';
    els.retry.hidden = !retry;
  }

  function stopPlayer() {
    clearTimeout(state.watch);
    if (state.hls) { try { state.hls.destroy(); } catch (e) { /* ignora */ } state.hls = null; }
    if (state.ts) {
      try { state.ts.pause(); state.ts.unload(); state.ts.detachMediaElement(); state.ts.destroy(); } catch (e) { /* ignora */ }
      state.ts = null; state.tsLast = null; state.net.tsMbps = null;
    }
    if (state.net) state.net.ext = null;
    try { els.video.pause(); } catch (e) { /* ignora */ }
    els.video.removeAttribute('src');
    try { els.video.load(); } catch (e) { /* ignora */ }
    els.frame.src = 'about:blank';
  }

  function cur0log() { return state.cur.name + ' (' + state.cur.id + ')'; }

  function play(id, again) {
    stopPlayer();
    var ch = state.data && state.data.channels.filter(function (c) { return c.id === id; })[0];
    state.seq += 1;
    state.net = { frags: [], samples: [], bytes: 0, count: 0, tsMbps: null };
    state.cur = { id: id, name: ch ? ch.name : id, sid: '', skip: [], bad: [], attempt: 0, token: state.seq };
    els.stage.hidden = false;
    els.name.textContent = state.cur.name;
    els.via.textContent = '';
    els.video.hidden = false;
    els.frame.hidden = true;
    save({ last: id });
    renderList();
    els.stage.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    nlog('abrir', cur0log());
    request();
  }

  function request() {
    var cur = state.cur;
    if (!cur) return;
    var token = cur.token;
    setMsg('Procurando a melhor fonte para ' + cur.name + '…', 'work');
    var q = '/api/live/stream?ch=' + encodeURIComponent(cur.id) +
      (cur.skip.length ? '&skip=' + cur.skip.join(',') : '') + (cur.bad.length ? '&bad=' + cur.bad.join(',') + (cur.badWhy ? '&why=' + cur.badWhy : '') : '');
    cur.bad = []; cur.badWhy = ''; // o servidor guarda o aviso; não precisa repetir
    api(q).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (res) {
      if (!state.cur || state.cur.token !== token) return; // trocou de canal no meio
      nlog('servidor', res.ok && res.j.ok
        ? res.j.mode + ' via ' + res.j.via + ' · fonte ' + res.j.sid + ' (' + res.j.origin + ') · ' + res.j.kind + ' · testes=' + res.j.tried + ' · puladas=' + ((res.j.skipped || []).length) + ' · ' + shortUrl(res.j.url)
        : 'resposta sem sinal: ' + ((res.j && res.j.error) || 'sem detalhe'));
      if (res.j && res.j.skipped && res.j.skipped.length) res.j.skipped.forEach(function (k) { nlog('entrega', 'fonte ' + k.sid + ' pulada: ' + k.reason); });
      if (!res.ok || !res.j.ok) {
        setMsg((res.j && res.j.error) || 'Sem sinal agora.', 'err', true);
        refresh();
        return;
      }
      start(res.j);
    }).catch(function (e) {
      nlog('rede', 'falha ao pedir a fonte: ' + e.message);
      if (state.cur && state.cur.token === token) setMsg('Não consegui falar com o servidor.', 'err', true);
    });
  }

  function start(job) {
    var cur = state.cur;
    cur.sid = job.sid;
    cur.mode = job.mode;
    cur.shield = false;
    cur.videoCheckSid = '';
    cur.played = false;
    els.via.textContent = '· ' + job.via;
    if (job.mode === 'shield') { startShield(job); return; }
    if (job.mode === 'page') {
      // Página de player entregue pelo AdShield: não dá para medir quadros dentro do iframe.
      els.video.hidden = true;
      els.frame.hidden = false;
      els.frame.src = job.url;
      nlog('pagina', 'player em iframe via AdShield');
      setMsg('Abrindo o player sem anúncios…', 'work');
      setTimeout(function () { if (state.cur && state.cur.sid === job.sid) setMsg(''); }, 2500);
      return;
    }
    els.frame.hidden = true;
    els.video.hidden = false;
    if (job.kind === 'ts') attachTs(job.url); else attach(job.url);
    clearTimeout(state.watch);
    var sid = job.sid;
    state.watch = setTimeout(function () {
      if (state.cur && state.cur.sid === sid && !(els.video.currentTime > 0 && !els.video.paused)) failSource('não começou a tocar');
    }, START_TIMEOUT_MS);
  }

  function attach(url) {
    var video = els.video;
    if (window.Hls && Hls.isSupported()) {
      var hls = new Hls({
        enableWorker: true, lowLatencyMode: false, liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 10,
        maxBufferLength: 20, maxMaxBufferLength: 40, backBufferLength: 30,
        manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 3, fragLoadingRetryDelay: 600
      });
      state.hls = hls;
      var sid = state.cur.sid;
      hls.on(Hls.Events.FRAG_LOADED, function (event, data) {
        // Conta a banda das Vercels (barra do pool); sem isso o uso da TV ao vivo não apareceria.
        try {
          netFrag(data);
          var bytes = data && data.frag && data.frag.stats && data.frag.stats.total;
          if (window.FdsUsage && bytes) window.FdsUsage.add(data.frag.url, bytes, data.frag.duration || 0);
        } catch (e) { /* estatística nunca derruba a TV */ }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        video.play().catch(function () { setMsg('Toque no ▶ para começar.', 'err'); });
      });
      hls.on(Hls.Events.ERROR, function (event, data) {
        if (data) nlog('hls', (data.fatal ? 'FATAL ' : '') + data.type + '/' + data.details + (data.response && data.response.code ? ' HTTP ' + data.response.code : '') + (data.frag ? ' frag ' + data.frag.sn : ''));
        if (data && data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR && /manifest|level/i.test(data.details || '')) explain(data);
        if (!data || !data.fatal || !state.cur || state.cur.sid !== sid) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !state.cur.recovered) {
          state.cur.recovered = true;
          hls.recoverMediaError();
          return;
        }
        var noReply = !(data.response && data.response.code);
        var directFetch = state.cur.mode === 'direct' && !state.cur.played && noReply && data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          /manifestLoadError|manifestLoadTimeOut|levelLoadError|levelLoadTimeOut|fragLoadError/.test(data.details || '');
        failSource((data.details || 'erro') + (data.response && data.response.code ? ' HTTP ' + data.response.code : ''), directFetch ? 'direct' : '');
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url; // HLS nativo (Safari/iOS antigo)
      video.play().catch(function () { /* o usuário toca no ▶ */ });
    } else {
      setMsg('Este navegador não tem suporte a HLS.', 'err');
    }
  }

  /** Só para o administrador: repete o pedido da playlist que falhou e registra o que o servidor/Vercel respondeu. */
  function explain(data) {
    var url = data.url || (data.context && data.context.url);
    if (!url || !adminKey()) return;
    fetch(url, { cache: 'no-store' }).then(function (r) {
      return r.text().then(function (t) { nlog('diagnostico', 'GET ' + shortUrl(url) + ' → HTTP ' + r.status + ' · ' + t.slice(0, 160).replace(/\s+/g, ' ')); });
    }).catch(function (e) { nlog('diagnostico', 'GET ' + shortUrl(url) + ' falhou: ' + e.message); });
  }

  /** Fontes HTTP sem CORS: um player que a PRÓPRIA Vercel serve (AdShield) toca o vídeo e avisa o site por postMessage. */
  function startShield(job) {
    var cur = state.cur, sid = job.sid;
    cur.shield = true;
    state.net.ext = null;
    els.video.hidden = true;
    els.frame.hidden = false;
    els.frame.src = job.url;
    nlog('shield', 'player na Vercel (' + (job.kind === 'ts' ? 'TS' : 'HLS') + ')');
    setMsg('Abrindo o player pela Vercel…', 'work');
    clearTimeout(state.watch);
    state.watch = setTimeout(function () {
      if (state.cur && state.cur.sid === sid && !state.cur.played) failSource('o player da Vercel não começou a tocar');
    }, 30000);
  }

  window.addEventListener('message', function (e) {
    var d = e.data, cur = state.cur;
    if (!d || d.fds !== 'live' || !cur || !cur.shield || !els.frame || e.source !== els.frame.contentWindow) return;
    if (d.ev === 'playing') {
      clearTimeout(state.watch);
      setMsg('');
      if (!cur.played) { cur.played = true; nlog('tocando', cur.name + ' fonte ' + cur.sid + ' · ' + d.w + 'x' + d.h + ' (player na Vercel)'); }
      armVideoCheck();
    } else if (d.ev === 'error') {
      nlog('shield', 'ERRO ' + d.detail);
      if (!cur.played) failSource(d.detail);
      else setMsg('A transmissão parou (' + d.detail + ').', 'err', true);
    } else if (d.ev === 'bytes') {
      try { if (window.FdsUsage && d.bytes) window.FdsUsage.add(els.frame.src, d.bytes, d.dur || 0); } catch (err) { /* estatística nunca derruba a TV */ }
      state.net.bytes += d.bytes || 0;
    } else if (d.ev === 'stat') {
      state.net.ext = { t: Date.now(), buf: d.buf, drop: d.drop, w: d.w, h: d.h, cap: d.cap, use: d.use };
    } else if (d.ev === 'reconnect') {
      nlog('shield', 'a Vercel cortou o fluxo; reconectando ' + d.n + '/30');
    }
  });

  function loadMpegts(done) {
    if (window.mpegts) return done(null);
    var tag = document.createElement('script');
    tag.src = MPEGTS_CDN; tag.integrity = MPEGTS_SRI; tag.crossOrigin = 'anonymous';
    tag.onload = function () { done(null); };
    tag.onerror = function () {
      nlog('mpegts', 'CDN falhou; usando a cópia local');
      var local = document.createElement('script');
      local.src = '/vendor/mpegts.min.js';
      local.onload = function () { done(null); };
      local.onerror = function () { done(new Error('não consegui carregar o mpegts.js')); };
      document.head.appendChild(local);
    };
    document.head.appendChild(tag);
  }

  /** MPEG-TS ao vivo (sem playlist): mpegts.js lê o fluxo pela Vercel. Reconecta quando a Vercel corta o stream. */
  function attachTs(url) {
    var sid = state.cur.sid, token = state.cur.token;
    setMsg('Carregando o player de TS…', 'work');
    loadMpegts(function (err) {
      if (!state.cur || state.cur.sid !== sid || state.cur.token !== token) return;
      if (err || !window.mpegts || !mpegts.getFeatureList().mseLivePlayback) {
        failSource(err ? err.message : 'este navegador não toca TS ao vivo');
        return;
      }
      var player = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: url }, {
        enableWorker: true, lazyLoad: false, autoCleanupSourceBuffer: true,
        liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 8, liveBufferLatencyMinRemain: 1.5
      });
      state.ts = player;
      var cur = state.cur;
      var lost = function (why) {
        if (!state.cur || state.cur.sid !== sid || state.ts !== player) return;
        if (cur.played) {
          cur.reconnects = (cur.reconnects || 0) + 1;
          nlog('mpegts', 'fluxo terminou (' + why + '); reconectando ' + cur.reconnects + '/' + MAX_RECONNECTS);
          if (cur.reconnects > MAX_RECONNECTS) { failSource('muitas reconexões'); return; }
          stopPlayer(); cur.played = false; request();
        } else failSource(why);
      };
      player.on(mpegts.Events.ERROR, function (type, detail, info) {
        nlog('mpegts', 'ERRO ' + type + '/' + detail + (info && info.msg ? ' ' + info.msg : ''));
        lost(detail || type);
      });
      player.on(mpegts.Events.LOADING_COMPLETE, function () { lost('fim do fluxo'); });
      player.on(mpegts.Events.STATISTICS_INFO, function (st) {
        // O mpegts.js não informa bytes totais, só a velocidade (KB/s): integra no tempo para contar a banda da Vercel.
        var now = Date.now();
        try {
          if (state.tsLast && st.speed > 0) {
            var dt = Math.min(5, (now - state.tsLast) / 1000);
            var delta = st.speed * 1024 * dt;
            if (window.FdsUsage && delta) window.FdsUsage.add(url, delta, dt);
            state.net.bytes += delta;
          }
          state.tsLast = now;
          state.net.tsMbps = st.speed != null ? st.speed * 8 / 1000 : null; // KB/s -> Mbps
        } catch (e) { /* estatística nunca derruba a TV */ }
      });
      player.attachMediaElement(els.video);
      player.load();
      var started = player.play();
      if (started && started.catch) started.catch(function () { setMsg('Toque no ▶ para começar.', 'err'); });
    });
  }

  function onPlaying() {
    if (state.cur && !state.cur.played) { state.cur.played = true; nlog('tocando', state.cur.name + ' fonte ' + state.cur.sid + ' · ' + els.video.videoWidth + 'x' + els.video.videoHeight); }
    if (!els.msg.hidden && state.cur) setMsg('');
    clearTimeout(state.watch);
    if (state.cur) { state.cur.recovered = false; armVideoCheck(); }
  }

  /** Tocou mas sem imagem (só áudio, ou vídeo que este navegador não decodifica, como HEVC): descarta a fonte e pede outra. */
  function armVideoCheck() {
    var cur = state.cur;
    if (!cur || cur.videoCheckSid === cur.sid) return;
    cur.videoCheckSid = cur.sid;
    var sid = cur.sid;
    setTimeout(function () {
      var c = state.cur;
      if (!c || c.sid !== sid || !c.played) return;
      var w = c.shield ? (state.net.ext && state.net.ext.w) : els.video.videoWidth;
      if (w > 0) return;
      failSource('toca só o áudio, sem imagem', 'novideo');
    }, 9000);
  }

  /** A fonte atual não serve para este navegador: avisa o servidor e pede a próxima. */
  function failSource(reason, why) {
    var cur = state.cur;
    if (!cur) return;
    // 'direct': o navegador não conseguiu buscar direto (CORS/rede). O servidor passa a entregar a MESMA fonte pela Vercel; não pula.
    if (cur.sid) { cur.bad.push(cur.sid); cur.badWhy = why || ''; if (why !== 'direct') cur.skip.push(cur.sid); }
    cur.attempt += 1;
    nlog('falhou', 'fonte ' + (cur.sid || '-') + ': ' + reason + ' (tentativa ' + cur.attempt + '/' + MAX_ATTEMPTS + ')');
    stopPlayer();
    if (cur.attempt >= MAX_ATTEMPTS) {
      cur.attempt = 0;
      cur.skip = [];
      setMsg('Nenhuma fonte de ' + cur.name + ' tocou agora (' + reason + '). Tente outro canal ou mais tarde.', 'err', true);
      return;
    }
    setMsg('Essa fonte não tocou (' + reason + '). Tentando a próxima…', 'work');
    request();
  }

  /* --------------------------------- abrir/fechar --------------------------- */

  function open() {
    if (!els.root) build();
    if (state.open) return;
    var saved = load();
    state.group = saved.group || '';
    state.onlyLive = !!saved.onlyLive;
    els.onlyLive.checked = state.onlyLive;
    state.open = true;
    state.polls = 0;
    els.root.hidden = false;
    document.documentElement.classList.add('ltv-open');
    document.documentElement.style.overflow = 'hidden';
    openBtn.setAttribute('aria-pressed', 'true');
    try { if (location.hash !== '#tv') history.replaceState(null, '', '#tv'); } catch (e) { /* ignora */ }
    renderChips();
    renderList();
    clearInterval(state.netTimer);
    state.netTimer = setInterval(sampleNet, 1000);
    refresh().then(schedulePoll);
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    clearTimeout(state.poll);
    clearInterval(state.diagTimer);
    clearInterval(state.netTimer);
    if (els.nerdAuto) els.nerdAuto.checked = false;
    stopPlayer();
    state.cur = null;
    state.seq += 1;
    els.stage.hidden = true;
    els.root.hidden = true;
    document.documentElement.classList.remove('ltv-open');
    document.documentElement.style.overflow = '';
    openBtn.setAttribute('aria-pressed', 'false');
    try { if (location.hash === '#tv') history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignora */ }
  }

  openBtn.addEventListener('click', function () { if (state.open) close(); else open(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.open && !document.fullscreenElement) close();
  });
  // Buscar ou clicar no logo volta para o catálogo de filmes.
  ['searchToggle', 'logoLink'].forEach(function (id) {
    var node = document.getElementById(id);
    if (node) node.addEventListener('click', function () { if (state.open) close(); });
  });
  var searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.addEventListener('focus', function () { if (state.open) close(); });
  window.addEventListener('hashchange', function () { if (location.hash === '#tv') open(); });
  window.addEventListener('pagehide', stopPlayer);
  if (location.hash === '#tv') open();
})();
