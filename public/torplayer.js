/*
 * fdsFlix · player de torrent "esperto" (cliente dos nós deploy/torrent-streamer).
 *
 * Tudo aqui roda no NAVEGADOR e só usa as rotas que os nós JÁ têm (/health, /ping, /status, /prepare,
 * /stream). Nada exige reenviar nó. O que o módulo faz:
 *
 *  1. ESCOLHE o nó certo sem esperar à toa: pergunta /health a todos ao mesmo tempo. Nó acordado (ou que já
 *     tem este filme em cache) vence um nó dormindo (acordar = ~1 min). Se todos dormem, acorda o preferido
 *     e, se ele demorar, acorda o seguinte em paralelo.
 *  2. MAGNET MELHORADO: soma trackers HTTP(S) vivos ao magnet (a plataforma costuma bloquear UDP/DHT, então
 *     é por TCP que os peers aparecem). Mais trackers = mais peers = download mais rápido.
 *  3. COLCHÃO ANTES DE TOCAR: mede a velocidade real de download e o bitrate do arquivo e só libera o filme
 *     quando dá para ir até o fim sem parar (ou, se o arquivo é lento demais, um colchão de segurança).
 *  4. SEM TRAVADINHA: durante o filme, quando o buffer está acabando, PAUSA sozinho e retoma só depois de
 *     juntar um colchão (maior quando a conexão é fraca). Ao avançar para um trecho que ainda não chegou,
 *     o mesmo vale ("Indo para 1:23:45…"). Em vez de 20 micro-travadas, 1 espera curta e clara.
 *  5. PROGRESSO VISÍVEL em linguagem NEUTRA (etapas, % e frases), no lugar do terminal. Nada de nó, peers,
 *     servidor ou banda para quem não é admin: o detalhe técnico fica em `.admin-only` (e no log do admin).
 *
 * API:  FdsTorPlayer.play({ host, item:{hash,magnet,title}, nodes, rank, log, note, onFail, onUsage })
 *         -> { destroy(), video() }       FdsTorPlayer.prewarm(item, nodes, rank)
 */
(function (root) {
  'use strict';

  /* ------------------------------ trackers (TCP) ------------------------------ */

  // Conferidos vivos (resposta HTTP no /announce) em 2026-11-24. Os que a plataforma bloqueia por UDP
  // não importam: aqui só entra HTTP(S). Lista curta de propósito (cada um vira 1 requisição do nó).
  var TRACKERS = [
    'http://tracker.opentrackr.org:1337/announce',
    'http://open.tracker.cl:1337/announce',
    'http://tracker.dler.org:6969/announce',
    'http://t.overflow.biz:6969/announce',
    'http://tracker.qu.ax:6969/announce',
    'http://retracker.hotplug.ru:2710/announce'
  ];

  function boostMagnet(magnet, hash) {
    var m = String(magnet || '');
    if (!/^magnet:\?/i.test(m)) m = 'magnet:?xt=urn:btih:' + hash;
    TRACKERS.forEach(function (t) {
      if (m.indexOf(encodeURIComponent(t)) === -1 && m.indexOf(t) === -1) m += '&tr=' + encodeURIComponent(t);
    });
    return m;
  }

  /* ------------------------------ utilidades ------------------------------ */

  var MB = 1048576;

  function now() { return Date.now(); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function normNode(u) { return String(u || '').trim().replace(/\/+$/, '').toLowerCase(); }

  function fmtTime(s) {
    s = Math.max(0, Math.round(s || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') + m : m) + ':' + (ss < 10 ? '0' : '') + ss;
  }

  function fmtEta(sec) {
    if (!isFinite(sec) || sec < 0) return '';
    if (sec < 10) return 'alguns segundos';
    if (sec < 60) return 'cerca de ' + Math.round(sec / 5) * 5 + ' s';
    var m = Math.round(sec / 60);
    return 'cerca de ' + m + ' min';
  }

  function fetchJson(url, ms, init) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    var o = { cache: 'no-store' };
    if (init) for (var k in init) o[k] = init[k];
    if (ctl) o.signal = ctl.signal;
    return fetch(url, o).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return r.json();
    }, function (e) { clearTimeout(timer); throw e; });
  }

  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  /* ------------------------------ escolha do nó ------------------------------ */

  // /health responde na hora num nó acordado (e diz quais torrents ele já tem). Nó dormindo devolve uma
  // página sem CORS: o fetch falha rápido e tratamos como "dormindo".
  function probe(node) {
    var t0 = now();
    return fetchJson(node + '/health', 3500).then(function (h) {
      return { node: node, awake: true, engines: (h && h.engines) || [], ms: now() - t0 };
    }, function () {
      return { node: node, awake: false, engines: [], ms: now() - t0 };
    });
  }

  function stickyIndex(hash, n) {
    var v = parseInt(String(hash || '').slice(0, 8), 16) || 0;
    return n ? v % n : 0;
  }

  // Menor nota = melhor. Já tem o filme pronto > acordado (menos carregado primeiro) > dormindo
  // (o "preso ao arquivo" primeiro, esgotados por último).
  function orderNodes(probes, hash, rank) {
    var n = probes.length;
    var sticky = stickyIndex(hash, n);
    return probes.map(function (p, i) {
      var has = p.engines.filter(function (e) { return String(e.hash || '').toLowerCase() === String(hash).toLowerCase(); })[0];
      var ri = rank && rank.length ? rank.indexOf(normNode(p.node)) : 0;
      var score;
      if (p.awake) score = (has && has.ready ? 0 : 10) + p.engines.length * 0.5 + (ri === -1 ? 50 : 0);
      else score = 100 + ((i - sticky + n) % n) + (ri === -1 ? 50 : 0);
      return { node: p.node, awake: p.awake, has: !!(has && has.ready), score: score };
    }).sort(function (a, b) { return a.score - b.score; });
  }

  function wakeUrlOf(node) {
    var m = /^https?:\/\/([^./]+)\.containers\.snapdeploy\.app$/i.exec(node);
    return m ? 'https://snapdeploy.dev/api/public/wake/' + m[1] : '';
  }

  // Container dormindo: a plataforma só acorda com um POST na API dela (um GET na URL do nó NÃO acorda).
  function wakeNode(node, ctl) {
    var t0 = now();
    var lastLog = 0;
    var lastWake = 0;
    var wakeUrl = wakeUrlOf(node);
    var dead = '';
    function sendWake() {
      lastWake = now();
      if (!wakeUrl) return Promise.resolve();
      return fetch(wakeUrl, { method: 'POST', cache: 'no-store' }).then(function (r) {
        if (r.status === 404) { dead = 'o provedor não reconhece este container (apagado ou parado no painel)'; return; }
        return r.json().then(function (j) { ctl.log('sinal de acordar enviado: ' + ((j && (j.status || j.message)) || r.status)); }, function () {});
      }).catch(function () {
        try { fetch(wakeUrl, { method: 'POST', mode: 'no-cors' }); } catch (e) { /* ok */ }
      });
    }
    function attempt() {
      if (ctl.dead()) return Promise.reject(new Error('cancelado'));
      return fetch(node + '/ping', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return node;
      }).catch(function (e) {
        if (ctl.dead()) throw e;
        var secs = Math.round((now() - t0) / 1000);
        if (dead) throw new Error(dead);
        if (now() - t0 > 100000) throw new Error('não acordou em ' + secs + 's (' + e.message + ')');
        if (now() - lastLog >= 9000) { lastLog = now(); ctl.log('nó dormindo, acordando… ' + secs + 's (' + e.message + ')'); }
        ctl.tick(node, secs);
        var step = now() - lastWake >= 15000 ? sendWake() : Promise.resolve();
        return step.then(function () { return sleep(2500); }).then(attempt);
      });
    }
    return sendWake().then(attempt);
  }

  // Todos dormindo: acorda o preferido e, se ele passar de 20 s, acorda o próximo em paralelo (o 1º que
  // responder vence; quem perdeu para de tentar). Custo: ~0,25 container-hora do 2º nó (o limite é 100 h/mês).
  var WAKE_STAGGER_MS = 20000;
  function wakeRace(ordered, parent) {
    return new Promise(function (resolve, reject) {
      var ctl = {
        dead: function () { return parent.dead() || done; },
        log: parent.log,
        tick: parent.tick
      };
      var next = 0;
      var failed = 0;
      var done = false;
      var lastErr = null;
      var timer = null;
      function start() {
        if (done || next >= ordered.length) return;
        var n = ordered[next++].node;
        ctl.log('acordando ' + n + (ordered.length > 1 ? ' (' + next + '/' + ordered.length + ')' : ''));
        wakeNode(n, ctl).then(win, lose);
        clearTimeout(timer);
        if (next < ordered.length) timer = setTimeout(start, WAKE_STAGGER_MS);
      }
      function win(n) { if (done) return; done = true; clearTimeout(timer); resolve(n); }
      function lose(e) {
        failed += 1;
        lastErr = e;
        ctl.log('falha ao acordar: ' + (e && e.message));
        if (done) return;
        if (next < ordered.length) { start(); return; }
        if (failed >= ordered.length) { done = true; clearTimeout(timer); reject(lastErr || new Error('nenhum nó respondeu')); }
      }
      start();
    });
  }

  var prewarmed = {}; // node -> quando mandamos o sinal de acordar (não repete em 3 min)

  // Passou o mouse / encostou no "tocar": acorda o nó que vai ser usado e já deixa o torrent aberto lá.
  function prewarm(item, nodes, rank) {
    if (!item || !item.hash || !nodes || !nodes.length) return;
    Promise.all(nodes.map(probe)).then(function (probes) {
      var ordered = orderNodes(probes, item.hash, rank);
      var best = ordered[0];
      if (!best) return;
      if (best.awake) {
        // abre o torrent no nó (peers + metadados começam agora)
        fetch(best.node + '/status/' + item.hash + '?magnet=' + encodeURIComponent(boostMagnet(item.magnet, item.hash)), { cache: 'no-store' }).catch(function () {});
        return;
      }
      var url = wakeUrlOf(best.node);
      if (!url || now() - (prewarmed[best.node] || 0) < 180000) return;
      prewarmed[best.node] = now();
      try { fetch(url, { method: 'POST', mode: 'no-cors', cache: 'no-store' }); } catch (e) { /* ok */ }
    }).catch(function () {});
  }

  /* ------------------------------ aparência ------------------------------ */

  var CSS = [
    '.tp{position:relative;width:100%;aspect-ratio:16/9;max-height:60vh;background:#000;border-radius:.6rem;overflow:hidden;outline:none;color:#fff;font-family:inherit;container-type:size}',
    '.tp:fullscreen{max-height:none;border-radius:0}',
    '.tp-video{position:absolute;inset:0;width:100%;height:100%;background:#000;object-fit:contain}',
    '.tp-ov{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.55rem;padding:1rem;text-align:center;',
    'background:radial-gradient(ellipse at 50% 40%,rgba(32,16,22,.92),rgba(8,8,14,.97));opacity:1;transition:opacity .45s ease;z-index:3}',
    '.tp-ov.tp-lite{background:rgba(0,0,0,.52);gap:.35rem}',
    '.tp-ov.tp-off{opacity:0;pointer-events:none}',
    '.tp-ring{position:relative;width:86px;height:86px;flex:none}',
    '.tp-ring svg{width:100%;height:100%;transform:rotate(-90deg)}',
    '.tp-ring circle{fill:none;stroke-width:6}',
    '.tp-ring .bg{stroke:rgba(255,255,255,.13)}',
    '.tp-ring .fg{stroke:#e50914;stroke-linecap:round;transition:stroke-dashoffset .6s ease}',
    '.tp-ring.indet svg{animation:tpspin 1.15s linear infinite}',
    '.tp-ring.indet .fg{stroke-dashoffset:210 !important}',
    '.tp-pct{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.05rem;font-variant-numeric:tabular-nums}',
    '.tp-lite .tp-ring{width:62px;height:62px}',
    '.tp-lite .tp-pct{font-size:.85rem}',
    '.tp-title{font-size:1.08rem;font-weight:650;letter-spacing:.01em}',
    '.tp-sub{font-size:.85rem;opacity:.72;min-height:1.2em;max-width:30rem}',
    '.tp-bar{width:min(22rem,80%);height:6px;border-radius:4px;background:rgba(255,255,255,.12);overflow:hidden;position:relative}',
    '.tp-bar i{position:absolute;left:0;top:0;bottom:0;width:0;background:linear-gradient(90deg,#e50914,#ff6a3d);border-radius:4px;transition:width .6s ease}',
    '.tp-bar.indet i{width:38%;animation:tpslide 1.3s ease-in-out infinite}',
    '.tp-lite .tp-bar,.tp-lite .tp-steps,.tp-lite .tp-feed{display:none}',
    '.tp-steps{list-style:none;margin:.3rem 0 0;padding:0;display:flex;flex-direction:column;gap:.22rem;font-size:.84rem;text-align:left}',
    '.tp-steps li{display:flex;align-items:center;gap:.5rem;opacity:.42;transition:opacity .3s}',
    '.tp-steps li.on,.tp-steps li.done{opacity:1}',
    '.tp-steps li.done{opacity:.8}',
    '.tp-dot{width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,.28);flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:.62rem;box-sizing:border-box}',
    '.tp-steps li.on .tp-dot{border-color:#e50914;border-top-color:transparent;animation:tpspin .9s linear infinite}',
    '.tp-steps li.done .tp-dot{border-color:#3ecf8e;background:#3ecf8e;color:#06130d;animation:none}',
    '.tp-feed{min-height:3.1em;font-size:.76rem;opacity:.62;display:flex;flex-direction:column;gap:.1rem;font-family:ui-monospace,Menlo,Consolas,monospace}',
    '.tp-feed div{animation:tpfade .5s ease both}',
    '.tp-tech{font-size:.7rem;opacity:.5;font-family:ui-monospace,Menlo,Consolas,monospace}',
    '.tp-btn{margin-top:.3rem;padding:.42rem .9rem;border-radius:.45rem;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.08);color:#fff;font-size:.82rem;cursor:pointer}',
    '.tp-btn:hover{background:rgba(255,255,255,.18)}',
    '.tp-btn[hidden]{display:none}',
    '.tp-fs{position:absolute;top:.5rem;right:.5rem;z-index:4;width:2rem;height:2rem;border-radius:.4rem;border:0;background:rgba(0,0,0,.5);color:#fff;font-size:1rem;cursor:pointer;opacity:0;transition:opacity .2s}',
    '.tp:hover .tp-fs,.tp:focus-within .tp-fs{opacity:.85}',
    '@keyframes tpspin{to{transform:rotate(270deg)}}',
    '@keyframes tpslide{0%{left:-40%}100%{left:102%}}',
    '@keyframes tpfade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
    '.tp-ov{overflow:hidden}',
    '.tp-sub{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    /* player baixo (janela pequena/celular): tira o que não cabe, na ordem do menos importante */
    '@container (max-height:440px){.tp-feed{display:none}.tp-ring{width:66px;height:66px}.tp-ov{gap:.4rem}}',
    '@container (max-height:320px){.tp-steps,.tp-tech{display:none}.tp-ring{width:54px;height:54px}.tp-pct{font-size:.8rem}.tp-title{font-size:.95rem}.tp-sub{font-size:.78rem}}',
    '@container (max-height:210px){.tp-ring{display:none}.tp-ov{gap:.3rem;padding:.5rem}}',
    '@media (prefers-reduced-motion:reduce){.tp-ring.indet svg,.tp-bar.indet i,.tp-steps li.on .tp-dot{animation:none}}'
  ].join('');

  function injectCss() {
    if (document.getElementById('tpStyles')) return;
    var s = document.createElement('style');
    s.id = 'tpStyles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var STEPS = [
    ['connect', 'Iniciando a sessão'],
    ['find', 'Localizando o filme'],
    ['load', 'Carregando o começo'],
    ['buffer', 'Preparando para tocar sem travar']
  ];

  var TIPS = [
    'Hora de pegar a pipoca 🍿',
    'Ajeitando as luzes da sala…',
    'Quase lá…',
    'Silenciando o celular, o filme já vai começar',
    'Caprichando na imagem e no som…',
    'Segura que vem coisa boa 🎬'
  ];

  var RING_LEN = 2 * Math.PI * 36; // r = 36

  /* ------------------------------ o player ------------------------------ */

  function play(opts) {
    injectCss();
    var host = opts.host;
    var item = opts.item || {};
    var hash = String(item.hash || '').toLowerCase();
    var nodes = (opts.nodes || []).slice();
    var rank = opts.rank || [];
    var logFn = opts.log || function () {};
    var noteFn = opts.note || function () {};
    var magnet = boostMagnet(item.magnet, hash);

    var dead = false;
    var timers = [];
    var ctl = {
      dead: function () { return dead; },
      log: function (m) { logFn(m); },
      tick: function (node, secs) { onConnectTick(secs); }
    };

    /* ---- DOM ---- */
    host.textContent = '';
    var wrap = el('div', 'tp');
    wrap.tabIndex = 0;
    var video = document.createElement('video');
    video.className = 'tp-video';
    video.playsInline = true;
    video.preload = 'auto';
    video.controls = false;
    video.setAttribute('controlslist', 'nofullscreen');
    video.style.visibility = 'hidden';

    var ov = el('div', 'tp-ov');
    var ring = el('div', 'tp-ring indet');
    ring.innerHTML = '<svg viewBox="0 0 86 86"><circle class="bg" cx="43" cy="43" r="36"></circle><circle class="fg" cx="43" cy="43" r="36" stroke-dasharray="' + RING_LEN.toFixed(1) + '" stroke-dashoffset="' + RING_LEN.toFixed(1) + '"></circle></svg>';
    var pctEl = el('div', 'tp-pct', '');
    ring.appendChild(pctEl);
    var titleEl = el('div', 'tp-title', 'Iniciando…');
    var subEl = el('div', 'tp-sub', TIPS[0]);
    var bar = el('div', 'tp-bar indet');
    var barFill = document.createElement('i');
    bar.appendChild(barFill);
    var stepsEl = el('ol', 'tp-steps');
    var stepLis = {};
    STEPS.forEach(function (s) {
      var li = document.createElement('li');
      var dot = el('span', 'tp-dot', '');
      li.appendChild(dot);
      li.appendChild(el('span', '', s[1]));
      stepsEl.appendChild(li);
      stepLis[s[0]] = li;
    });
    var feedEl = el('div', 'tp-feed');
    var techEl = el('div', 'tp-tech admin-only', '');
    var skipBtn = el('button', 'tp-btn', 'Tocar assim mesmo');
    skipBtn.type = 'button';
    skipBtn.hidden = true;
    var retryBtn = el('button', 'tp-btn', 'Tentar de novo');
    retryBtn.type = 'button';
    retryBtn.hidden = true;
    ov.appendChild(ring);
    ov.appendChild(titleEl);
    ov.appendChild(subEl);
    ov.appendChild(bar);
    ov.appendChild(stepsEl);
    ov.appendChild(feedEl);
    ov.appendChild(techEl);
    ov.appendChild(skipBtn);
    ov.appendChild(retryBtn);
    var fsBtn = el('button', 'tp-fs', '⛶');
    fsBtn.type = 'button';
    fsBtn.title = 'Tela cheia';
    fsBtn.setAttribute('aria-label', 'Tela cheia');
    wrap.appendChild(video);
    wrap.appendChild(ov);
    wrap.appendChild(fsBtn);
    host.appendChild(wrap);

    function toggleFs() {
      var d = document;
      var on = d.fullscreenElement || d.webkitFullscreenElement;
      if (on) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); return; }
      var fn = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
      if (fn) fn.call(wrap);
    }
    fsBtn.addEventListener('click', toggleFs);
    wrap.addEventListener('keydown', function (e) { if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFs(); } });

    /* ---- estado de progresso ---- */
    var phase = 'connect';
    var maxPct = 0;
    var startedAt = now();
    var tipIdx = 0;
    var feed = [];

    function say(text) {
      if (feed.length && feed[feed.length - 1] === text) return;
      feed.push(text);
      if (feed.length > 3) feed.shift();
      feedEl.textContent = '';
      feed.forEach(function (t, i) {
        var d = el('div', '', (i === feed.length - 1 ? '› ' : '✓ ') + t.replace(/^[✓› ]+/, ''));
        feedEl.appendChild(d);
      });
    }

    function setRing(pct, indet) {
      ring.classList.toggle('indet', !!indet);
      bar.classList.toggle('indet', !!indet);
      if (indet) { pctEl.textContent = ''; return; }
      pct = clamp(pct, 0, 100);
      if (pct < maxPct && phase !== 'rebuffer' && phase !== 'seek') pct = maxPct; else if (phase !== 'rebuffer' && phase !== 'seek') maxPct = pct;
      ring.querySelector('.fg').style.strokeDashoffset = (RING_LEN * (1 - pct / 100)).toFixed(1);
      barFill.style.width = pct.toFixed(1) + '%';
      pctEl.textContent = Math.round(pct) + '%';
    }

    function setSteps(cur) {
      var idx = -1;
      STEPS.forEach(function (s, i) { if (s[0] === cur) idx = i; });
      STEPS.forEach(function (s, i) {
        var li = stepLis[s[0]];
        li.className = cur === 'ready' || i < idx ? 'done' : (i === idx ? 'on' : '');
        li.firstChild.textContent = cur === 'ready' || i < idx ? '✓' : '';
      });
    }

    function showOv(lite) {
      ov.classList.remove('tp-off');
      ov.classList.toggle('tp-lite', !!lite);
    }

    function hideOv() { ov.classList.add('tp-off'); }

    function setPhase(p, title, sub) {
      phase = p;
      if (title != null) titleEl.textContent = title;
      if (sub != null) subEl.textContent = sub;
      if (STEPS.some(function (s) { return s[0] === p; })) setSteps(p);
    }

    function setTech(text) { techEl.textContent = text || ''; }

    // gira as frases leves enquanto espera
    timers.push(setInterval(function () {
      if (dead || phase === 'error' || phase === 'play' || phase === 'rebuffer' || phase === 'seek') return;
      if (!skipBtn.hidden && phase === 'buffer') return;
      tipIdx = (tipIdx + 1) % TIPS.length;
      if (phase === 'connect' || phase === 'find') subEl.textContent = TIPS[tipIdx];
    }, 4500));

    /* ---- coleta de números do nó ---- */
    var node = '';
    var base = '';
    var samples = [];      // { t, dl }  (dl em bytes, total baixado do swarm)
    var last = { wires: 0, speedKBs: 0, dl: 0, headMB: 0, tailMB: 0, headNeedMB: 0, tailNeedMB: 0, warmDone: false, ready: false, reason: '' };
    var vEma = 0;          // bytes/s suavizado (download real do nó)
    var prep = null;       // resposta do /prepare (tamanho, remux, nome)
    var legacy = false;
    var statusFails = 0;

    function pushSample(st) {
      var dl = (st.downloadedMB || 0) * MB;
      var t = now();
      samples.push({ t: t, dl: dl });
      while (samples.length > 2 && t - samples[0].t > 15000) samples.shift();
      var v = 0;
      if (samples.length >= 2) {
        var a = samples[0];
        var b = samples[samples.length - 1];
        if (b.t - a.t >= 1500) v = Math.max(0, (b.dl - a.dl) / ((b.t - a.t) / 1000));
      }
      var sp = (st.speedKBs || 0) * 1024;
      if (!v) v = sp; else v = Math.max(v, sp * 0.6);
      vEma = vEma ? vEma * 0.6 + v * 0.4 : v;
    }

    function readStatus(st) {
      var w = st.warm || {};
      last.wires = st.wires || 0;
      last.speedKBs = st.speedKBs || 0;
      last.dl = (st.downloadedMB || 0) * MB;
      last.headMB = w.headMB || 0; last.tailMB = w.tailMB || 0;
      last.headNeedMB = w.headNeedMB || 0; last.tailNeedMB = w.tailNeedMB || 0;
      last.warmDone = !!w.done;
      last.ready = !!st.ready;
      last.reason = st.reason || '';
      pushSample(st);
    }

    function techLine() {
      var host2 = (node || '').replace(/^https?:\/\//, '').split('.')[0];
      return 'nó ' + (host2 || '?') + ' · ' + last.wires + ' peers · ' + Math.round(vEma / 1024) + ' KB/s · baixado ' + (last.dl / MB).toFixed(1) + ' MB' +
        (prep && prep.size ? ' de ' + (prep.size / MB).toFixed(0) + ' MB' : '');
    }

    function fetchStatus() {
      return fetchJson(base.status, 6000).then(function (st) { statusFails = 0; readStatus(st); return st; });
    }

    /* ---- etapa 1: escolher/acordar o nó ---- */
    function onConnectTick(secs) {
      if (phase !== 'connect') return;
      setRing(2 + 16 * (1 - Math.exp(-secs / 28)), false);
      subEl.textContent = secs < 12 ? TIPS[tipIdx] : 'Isso pode levar um minutinho na primeira vez…';
    }

    function failNow(reason, techReason) {
      if (dead) return;
      setPhase('error', 'Não consegui carregar este filme agora.', 'Tente outra opção da lista.');
      ring.classList.remove('indet');
      bar.classList.remove('indet');
      barFill.style.width = '0';
      pctEl.textContent = '!';
      stepsEl.style.display = 'none';
      skipBtn.hidden = true;
      showOv(false);
      setTech(techReason || reason || '');
      logFn('FALHA: ' + (techReason || reason || ''));
      if (opts.onFail) opts.onFail(reason || 'falha', techReason || '');
    }

    function begin() {
      setPhase('connect', 'Iniciando…', TIPS[0]);
      setRing(2, true);
      say('Iniciando a sessão');
      if (!nodes.length) { failNow('sem nó', 'nenhum nó configurado'); return; }
      Promise.all(nodes.map(probe)).then(function (probes) {
        if (dead) return null;
        var ordered = orderNodes(probes, hash, rank);
        logFn('nós: ' + ordered.map(function (o) { return o.node.replace(/^https?:\/\//, '').split('.')[0] + (o.awake ? (o.has ? ' (acordado, com o filme)' : ' (acordado)') : ' (dormindo)'); }).join(' · '));
        if (ordered[0] && ordered[0].awake) { logFn('nó acordado: ' + ordered[0].node + ' — sem esperar para acordar'); return ordered[0].node; }
        return wakeRace(ordered, ctl);
      }).then(function (n) {
        if (dead || !n) return;
        node = n;
        var qs = '/' + hash + '?magnet=' + encodeURIComponent(magnet);
        base = { status: node + '/status' + qs, prepare: node + '/prepare' + qs, stream: node + '/stream' + qs };
        setPhase('find', 'Localizando o filme…', TIPS[tipIdx]);
        setRing(18, false);
        say('Sessão iniciada');
        say('Localizando o filme');
        logFn('preparando torrent (peers + metadados)…');
        findLoop();
      }).catch(function (e) {
        failNow('nenhum nó respondeu', 'nenhum nó respondeu: ' + (e && e.message));
      });
    }

    /* ---- etapa 2: peers + metadados (acompanha o /status, sem bloquear) ---- */
    var FIND_MAX = 150000;
    function findLoop() {
      var t0 = now();
      function step() {
        if (dead) return;
        fetchStatus().then(function (st) {
          if (dead) return;
          setTech(techLine());
          if (st.ready) { return afterReady(); }
          var secs = (now() - t0) / 1000;
          setRing(18 + 20 * (1 - Math.exp(-secs / 22)), false);
          if (now() - t0 > FIND_MAX) {
            failNow('sem fonte', 'sem metadados em ' + Math.round(secs) + 's: ' + (st.reason || 'sem resposta'));
            return;
          }
          if (Math.round(secs) % 6 === 0) logFn('procurando… ' + Math.round(secs) + 's | peers ' + last.wires + ' | ' + last.speedKBs + ' KB/s');
          return sleep(1200).then(step);
        }).catch(function (e) {
          if (dead) return;
          if (e && e.status === 404) { legacy = true; logFn('nó antigo (sem /status) — abrindo direto'); return startVideo(); }
          statusFails += 1;
          if (statusFails >= 6) { failNow('o nó parou de responder', 'o nó parou de responder (' + (e && e.message) + ')'); return; }
          return sleep(1500).then(step);
        });
      }
      step();
    }

    function afterReady() {
      // Metadados chegaram: pega tamanho/nome/remux (instantâneo agora).
      return fetchJson(base.prepare, 20000).then(function (p) {
        if (dead) return;
        prep = p;
        logFn('prepare: ' + (p.ready ? 'pronto' : 'NÃO pronto') + ' | peers ' + (p.wires || 0) +
          (p.name ? ' | arquivo: ' + p.name + ' (' + Math.round((p.size || 0) / MB) + ' MB)' : '') +
          (p.remux ? ' | converte para MP4 (sem avançar no tempo)' : ''));
        if (!p.ready) { failNow('sem vídeo', 'o nó não conseguiu abrir este torrent: ' + (p.reason || 'sem resposta')); return; }
        setPhase('load', 'Carregando o começo…', 'Só mais um pouquinho.');
        say('Filme localizado');
        say('Carregando o começo');
        loadLoop();
      }).catch(function (e) {
        if (dead) return;
        if (e && e.status === 404) { legacy = true; return startVideo(); }
        failNow('falha ao preparar', 'falha no /prepare: ' + (e && e.message));
      });
    }

    /* ---- etapa 3: começo do arquivo (moov + 6 MB) ---- */
    var LOAD_MAX = 240000;
    function loadLoop() {
      var t0 = now();
      var lastLog = 0;
      function step() {
        if (dead) return;
        fetchStatus().then(function (st) {
          if (dead) return;
          setTech(techLine());
          var need = (last.headNeedMB || 0) + (last.tailNeedMB || 0);
          var have = Math.min(last.headMB, last.headNeedMB || last.headMB) + Math.min(last.tailMB, last.tailNeedMB || last.tailMB);
          var frac = need > 0 ? clamp(have / need, 0, 1) : 0;
          setRing(38 + 24 * frac, false);
          var secs = Math.round((now() - t0) / 1000);
          if (last.warmDone) { logFn('começo carregado em ' + secs + 's | peers ' + last.wires + ' | ' + last.speedKBs + ' KB/s'); return startVideo(); }
          if (now() - lastLog >= 5000) {
            lastLog = now();
            logFn('baixando o começo… ' + secs + 's | peers ' + last.wires + ' | ' + last.speedKBs + ' KB/s | ' + have.toFixed(1) + '/' + need.toFixed(1) + ' MB');
          }
          if (now() - t0 > LOAD_MAX) { logFn('o começo demorou demais (' + secs + 's) — seguindo mesmo assim'); return startVideo(); }
          return sleep(1200).then(step);
        }).catch(function () {
          if (dead) return;
          statusFails += 1;
          if (statusFails >= 6) { failNow('o nó parou de responder', 'o nó parou de responder durante o carregamento'); return; }
          return sleep(1500).then(step);
        });
      }
      step();
    }

    /* ---- etapa 4: abre o vídeo escondido e junta o colchão ---- */
    var D = 0;            // duração (s)
    var started = false;
    var userGaveUp = false;

    function bitrate() {
      // bytes por segundo de vídeo
      var S = prep && prep.size ? prep.size : 0;
      if (S && D && isFinite(D) && D > 30) return S / D;
      return 190 * 1024; // sem duração (mkv convertido): chuta ~1,5 Mbps
    }

    function durationSec() {
      var S = prep && prep.size ? prep.size : 0;
      if (D && isFinite(D) && D > 30) return D;
      return S ? S / bitrate() : 0;
    }

    function startVideo() {
      if (dead || started) return;
      started = true;
      setPhase('buffer', 'Preparando para tocar sem travar…', 'Medindo a velocidade para não travar no meio.');
      say('Começo carregado');
      say('Preparando para tocar sem travar');
      video.addEventListener('loadedmetadata', function () {
        D = video.duration;
        logFn('metadata ok: ' + Math.round(D || 0) + 's');
      });
      video.addEventListener('error', onVideoError);
      video.src = base.stream || '';
      try { video.load(); } catch (e) { /* ok */ }
      if (legacy) { beginPlayback(); return; } // nó antigo: sem /status não há como medir o colchão
      bufferLoop();
    }

    // O que precisa estar baixado a partir do início para tocar sem parar nos próximos HORIZON segundos:
    // piso de ~14 s de filme + o que falta se a velocidade (com folga de 15%) for menor que o bitrate.
    // (garantir o filme inteiro seria esperar demais em filme longo; a velocidade oscila de qualquer jeito)
    var HORIZON_S = 300;
    function needBytes() {
      var S = prep && prep.size ? prep.size : 0;
      var b = bitrate();
      var floor = b * 14;
      if (!S) return floor;
      var vEff = vEma * 0.85;
      var deficit = Math.max(0, b - vEff) * Math.min(durationSec() || HORIZON_S, HORIZON_S);
      return clamp(floor + deficit, Math.min(floor, S), S);
    }

    function haveBytes() {
      // contíguo a partir do início ≈ baixado menos o trecho final (moov) aquecido;
      // e nunca menos do que o navegador já guardou desde o começo (arquivo que já estava no disco do nó)
      var fromDl = Math.max(0, last.dl - last.tailMB * MB);
      var br = video.buffered;
      var fromBrowser = 0;
      for (var i = 0; i < br.length; i++) if (br.start(i) <= 0.5) fromBrowser = br.end(i) * bitrate();
      return Math.max(fromDl, fromBrowser);
    }

    // Sem download andando há alguns segundos: esperar mais não melhora nada (arquivo completo/já em disco, ou sem peers).
    function downloadIdle() {
      if (samples.length < 2) return false;
      var a = samples[0];
      var b = samples[samples.length - 1];
      return b.t - a.t >= 4000 && vEma < 8 * 1024;
    }

    var SKIP_AFTER = 12000;
    var SOFT_AFTER = 90000;   // passou disso e já há ~45 s de filme no disco do nó: libera (a pausa inteligente cuida do resto)
    var HARD_MAX = 240000;
    function bufferLoop() {
      var t0 = now();
      var lastLog = 0;
      function go(reason) {
        logFn('liberando o filme: ' + reason);
        beginPlayback();
      }
      function step() {
        if (dead || phase !== 'buffer') return;
        fetchStatus().then(function () {
          if (dead || phase !== 'buffer') return;
          setTech(techLine());
          var need = needBytes();
          var have = haveBytes();
          var b = bitrate();
          var frac = need > 0 ? clamp(have / need, 0, 1) : 1;
          setRing(62 + 38 * frac, false);
          var waited = now() - t0;
          var eta = vEma > 1024 ? (need - have) / vEma : Infinity;
          var ratio = vEma / b;
          if (waited >= SKIP_AFTER && skipBtn.hidden) skipBtn.hidden = false;
          var metaOk = !!(D || legacy) && video.readyState >= 1;
          if (frac >= 1 && metaOk) { return go('colchão de ' + Math.round(have / MB) + ' MB (precisava de ' + Math.round(need / MB) + ' MB)'); }
          if (metaOk && downloadIdle() && bufferedAhead(0) >= 10) { return go('sem download em andamento e ' + Math.round(bufferedAhead(0)) + ' s já guardados (arquivo já no disco do nó?)'); }
          if (userGaveUp) { return go('você pediu para tocar já'); }
          if (metaOk && waited >= SOFT_AFTER && have >= b * 45) { return go('colchão parcial: ' + Math.round(have / b) + ' s de filme depois de ' + Math.round(waited / 1000) + 's de espera'); }
          if (waited >= HARD_MAX && metaOk) { return go('tempo máximo de espera (' + Math.round(waited / 1000) + 's)'); }
          if (isFinite(eta)) {
            subEl.textContent = (ratio < 1
              ? 'Este filme está chegando devagar; juntando um pouco mais para não travar. '
              : 'Quase pronto. ') + (eta > 5 ? 'Faltam ' + fmtEta(eta) + '.' : '');
          } else {
            subEl.textContent = 'Medindo a velocidade para não travar no meio…';
          }
          if (now() - lastLog >= 5000) {
            lastLog = now();
            logFn('colchão ' + (have / MB).toFixed(1) + '/' + (need / MB).toFixed(1) + ' MB (' + Math.round(frac * 100) + '%) | ' + Math.round(vEma / 1024) + ' KB/s vs filme ' + Math.round(b / 1024) + ' KB/s' +
              (isFinite(eta) ? ' | falta ~' + Math.round(eta) + 's' : ''));
          }
          return sleep(1000).then(step);
        }).catch(function () {
          if (dead) return;
          statusFails += 1;
          if (statusFails >= 6) { failNow('o nó parou de responder', 'o nó parou de responder (colchão)'); return; }
          return sleep(1500).then(step);
        });
      }
      skipBtn.onclick = function () { userGaveUp = true; };
      step();
    }

    /* ---- reprodução + proteção contra travadas ---- */
    var wantPlay = true;       // a pessoa quer assistir (não pausou de propósito)
    var autoPaused = false;    // fomos nós que pausamos
    var rebuf = null;          // { why, t0, H, bufEnd, growAt }
    var graceUntil = 0;
    var monitor = null;
    var errors = 0;

    function bufferedAhead(t) {
      var br = video.buffered;
      for (var i = 0; i < br.length; i++) {
        if (br.start(i) <= t + 0.35 && br.end(i) >= t) return Math.max(0, br.end(i) - t);
      }
      return 0;
    }

    function bufferedEnd(t) {
      var br = video.buffered;
      for (var i = 0; i < br.length; i++) if (br.start(i) <= t + 0.35 && br.end(i) >= t) return br.end(i);
      return 0;
    }

    // Colchão para retomar: quanto pior a conexão em relação ao filme, maior (6 s a 30 s).
    function resumeTarget(why) {
      var b = bitrate();
      var r = vEma > 0 ? vEma / b : 0.8;
      var H = r >= 1.3 ? 6 : 6 + ((1.3 - r) / 1.3) * 24;
      if (downloadIdle()) H = 8; // nada baixando: juntar mais não adianta
      if (why === 'seek') H = Math.min(H, 8);
      var left = (video.duration || durationSec() || 1e9) - video.currentTime;
      return clamp(Math.min(H, Math.max(1, left - 0.5)), 2, 30);
    }

    function beginPlayback() {
      if (dead) return;
      video.style.visibility = 'visible';
      video.controls = true;
      var p = video.play();
      var fin = function () {
        setPhase('play', null, null);
        setSteps('ready');
        setRing(100, false);
        titleEl.textContent = 'Tudo pronto!';
        say('Tudo pronto');
        setTimeout(function () { if (!dead && phase === 'play') hideOv(); }, 450);
        startMonitor();
        noteFn('Tocando.');
        if (opts.onUsage) setTimeout(opts.onUsage, 15000);
      };
      if (p && p.then) {
        p.then(fin, function (e) {
          // autoplay barrado: deixa um botão grande
          logFn('o navegador pediu um clique para tocar (' + (e && e.name) + ')');
          wantPlay = false;
          setPhase('play', null, null);
          hideOv();
          startMonitor();
        });
      } else fin();
    }

    function startMonitor() {
      if (monitor) return;
      monitor = setInterval(monitorTick, 250);
      timers.push(monitor);
      timers.push(setInterval(function () {
        if (dead || (phase !== 'play' && phase !== 'rebuffer' && phase !== 'seek')) return;
        fetchStatus().then(function () { setTech(techLine()); }).catch(function () {});
      }, 3000));
      video.addEventListener('pause', function () { if (!autoPaused && !video.ended) wantPlay = false; });
      video.addEventListener('play', function () {
        wantPlay = true;
        // nós só chamamos play() depois de limpar `rebuf`; então um play com `rebuf` ativo é da pessoa: respeita
        if (rebuf) { graceUntil = now() + 8000; leaveRebuffer('você retomou'); }
      });
    }

    function enterRebuffer(why) {
      if (rebuf || dead) return;
      var H = resumeTarget(why);
      var t = video.currentTime;
      rebuf = { why: why, t0: now(), H: H, bufEnd: bufferedEnd(t), growAt: now(), target: t };
      autoPaused = true;
      try { video.pause(); } catch (e) { /* ok */ }
      setPhase(why === 'seek' ? 'seek' : 'rebuffer', why === 'seek' ? 'Indo para ' + fmtTime(t) + '…' : 'Carregando mais um pouco…',
        why === 'seek' ? 'Buscando esse ponto do filme.' : 'Para o filme não travar.');
      setRing(0, false);
      showOv(true);
      skipBtn.hidden = true;
      logFn((why === 'seek' ? 'avançou para ' + fmtTime(t) + ' (sem dados ali ainda)' : 'buffer acabando em ' + fmtTime(t)) + ' — pausa para juntar ' + H.toFixed(0) + ' s');
    }

    function leaveRebuffer(reason) {
      if (!rebuf) return;
      var secs = ((now() - rebuf.t0) / 1000).toFixed(1);
      logFn('retomando após ' + secs + 's (' + reason + ')');
      rebuf = null;
      autoPaused = false;
      skipBtn.hidden = true;
      setPhase('play', null, null);
      hideOv();
      if (wantPlay) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
    }

    function monitorTick() {
      if (dead || !started) return;
      if (phase !== 'play' && phase !== 'rebuffer' && phase !== 'seek') return;
      var t = video.currentTime;
      var ahead = bufferedAhead(t);
      var dur = video.duration;
      var nearEnd = isFinite(dur) && dur - t < 1.5;
      if (rebuf) {
        var be = bufferedEnd(t);
        if (be > rebuf.bufEnd + 0.25) { rebuf.bufEnd = be; rebuf.growAt = now(); }
        // recalcula o alvo (a velocidade muda)
        rebuf.H = resumeTarget(rebuf.why);
        var frac = clamp(ahead / rebuf.H, 0, 1);
        setRing(frac * 100, false);
        var left = rebuf.H - ahead;
        var eta = vEma > 1024 ? (left * bitrate()) / vEma : Infinity;
        subEl.textContent = (rebuf.why === 'seek' ? 'Buscando esse ponto do filme' : 'Para o filme não travar') + (isFinite(eta) && eta > 3 ? ' · ' + fmtEta(eta) : '') + '.';
        if (isFinite(dur) && be >= dur - 0.5) return leaveRebuffer('o resto do filme já chegou');
        if (ahead >= rebuf.H) return leaveRebuffer('colchão de ' + ahead.toFixed(0) + ' s');
        // o navegador só guarda um tanto à frente: se parou de crescer e já temos o bastante, vai
        if (ahead >= 5 && now() - rebuf.growAt > 6000) return leaveRebuffer('o navegador não guarda mais que ' + ahead.toFixed(0) + ' s');
        if (now() - rebuf.t0 > 10000 && skipBtn.hidden) { skipBtn.hidden = false; skipBtn.onclick = function () { graceUntil = now() + 10000; leaveRebuffer('você pediu'); }; }
        return;
      }
      if (!wantPlay || video.paused || video.ended || nearEnd || now() < graceUntil) return;
      var seeking = video.seeking;
      if (seeking || ahead < 1.2) enterRebuffer(seeking || (video.readyState <= 1) ? 'seek' : 'low');
    }

    // Avançar/voltar para um ponto sem dados: pausa antes de o navegador ficar engasgando.
    video.addEventListener('seeking', function () {
      if (dead || !started || phase === 'buffer' || !wantPlay || now() < graceUntil) return;
      if (bufferedAhead(video.currentTime) >= 2) return; // trecho já guardado: segue normal
      // já estava pausado por nós? só atualiza o destino
      if (rebuf) { rebuf.why = 'seek'; rebuf.bufEnd = bufferedEnd(video.currentTime); rebuf.growAt = now(); rebuf.t0 = now(); titleEl.textContent = 'Indo para ' + fmtTime(video.currentTime) + '…'; return; }
      enterRebuffer('seek');
    });

    video.addEventListener('ended', function () { logFn('fim do vídeo'); });

    /* ---- queda de conexão no meio do filme ---- */
    function onVideoError() {
      if (dead) return;
      var err = video.error;
      logFn('ERRO no <video>: ' + (err && err.message ? err.message : 'code ' + (err && err.code)));
      errors += 1;
      if (errors > 3 || !started) { failNow('falha ao reproduzir', 'o navegador não conseguiu reproduzir (' + (err && err.code) + ')'); return; }
      var at = video.currentTime;
      setPhase('rebuffer', 'Reconectando…', 'Só um instante.');
      setRing(0, true);
      showOv(true);
      autoPaused = true;
      rebuf = null;
      wakeNode(node, ctl).catch(function () { return node; }).then(function () {
        if (dead) return;
        video.src = base.stream;
        try { video.load(); } catch (e) { /* ok */ }
        video.addEventListener('loadedmetadata', function once() {
          video.removeEventListener('loadedmetadata', once);
          try { video.currentTime = at; } catch (e) { /* ok */ }
          autoPaused = false;
          phase = 'play';
          enterRebuffer('seek');
        });
      });
    }

    /* ---- pronto: encerra tudo ---- */
    function destroy() {
      if (dead) return;
      dead = true;
      timers.forEach(function (t) { clearInterval(t); clearTimeout(t); });
      try { video.pause(); } catch (e) { /* ok */ }
      try { video.removeAttribute('src'); video.load(); } catch (e) { /* ok */ } // fecha a conexão com o nó
      try { if (document.fullscreenElement === wrap) document.exitFullscreen(); } catch (e) { /* ok */ }
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }

    retryBtn.onclick = function () {
      destroy();
      if (opts.onRetry) opts.onRetry();
    };

    begin();

    return {
      destroy: destroy,
      video: function () { return video; },
      state: function () {
        return { phase: phase, node: node, vKBs: Math.round(vEma / 1024), have: haveBytes(), need: needBytes(), D: D, wantPlay: wantPlay, rebuffering: !!rebuf };
      }
    };
  }

  root.FdsTorPlayer = { play: play, prewarm: prewarm, boostMagnet: boostMagnet, _t: { orderNodes: orderNodes, fmtTime: fmtTime } };
})(window);
