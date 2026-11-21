/*
 * fdsFlix · "Torrents" (dentro de "Outras fontes"; só administrador).
 *
 * Quando o link de vídeo falha, o admin procura o MESMO título nos trackers e recebe magnet/.torrent.
 * Dublado PT-BR primeiro; o motor rejeita CAM/TS/sample e casa título + ano (mesmo rigor do vídeo).
 *
 * O campo de título usa o MESMO /api/search da barra do site: digita e escolhe na lista (título + ano
 * preenchidos), como no site oficial.
 *
 * Nada disto existe para o visitante: a seção está dentro do diálogo .admin-only, o módulo não roda
 * sem html.is-admin e as rotas exigem a senha. Texto vindo da API entra por textContent.
 */
(function () {
  'use strict';

  var box = document.getElementById('torrentBox');
  var form = document.getElementById('torrentForm');
  var input = document.getElementById('torrentQ');
  var yearEl = document.getElementById('torrentYear');
  var resultsEl = document.getElementById('torrentResults');
  var noteEl = document.getElementById('torrentNote');
  var suggestEl = document.getElementById('torrentSuggest');
  var kitBtn = document.getElementById('torrentKit');
  if (!box || !form || !input || !resultsEl || !noteEl) return;
  if (!document.documentElement.classList.contains('is-admin')) return;

  var CONFIG = window.__FDSFLIX_CONFIG__ || {};
  var API_BASE = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  var seq = 0;
  var sugSeq = 0;
  var sugTimer = null;

  function key() { try { return localStorage.getItem('fdsflix.adminKey') || ''; } catch (e) { return ''; } }

  function headers() {
    var h = {};
    if (CONFIG.apiKey) h['x-api-key'] = CONFIG.apiKey;
    var k = key();
    if (k) h['x-stats-key'] = k;
    return h;
  }

  function note(text, kind) {
    noteEl.textContent = text || '';
    noteEl.className = 'pix-note' + (kind ? ' ' + kind : '');
  }

  /* --------------------------- sugestões (mesmo /api/search do site) --------------------------- */

  function hideSuggest() {
    sugSeq += 1;
    if (!suggestEl) return;
    suggestEl.hidden = true;
    suggestEl.textContent = '';
  }

  function pick(item) {
    input.value = item.title || '';
    input.dataset.original = item.originalTitle || '';
    if (yearEl && item.year) yearEl.value = item.year;
    hideSuggest();
    search();
  }

  function showSuggest(items) {
    if (!suggestEl) return;
    suggestEl.textContent = '';
    if (!items.length) { hideSuggest(); return; }
    items.slice(0, 8).forEach(function (item) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.style.cssText = 'display:flex;flex-direction:column;gap:.1rem;width:100%;padding:.45rem .6rem;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;border-radius:.35rem';
      var t = document.createElement('span');
      t.textContent = item.title || '';
      var y = document.createElement('span');
      y.style.cssText = 'font-size:.8rem;opacity:.7';
      y.textContent = (item.year || 'sem ano') + (item.type === 'tv' ? ' · série' : ' · filme');
      b.appendChild(t);
      b.appendChild(y);
      b.addEventListener('mousedown', function (e) { e.preventDefault(); pick(item); });
      suggestEl.appendChild(b);
    });
    suggestEl.hidden = false;
  }

  function suggest() {
    var q = String(input.value || '').trim();
    if (q.length < 2) { hideSuggest(); return; }
    var my = ++sugSeq;
    fetch(API_BASE + '/api/search?q=' + encodeURIComponent(q), { headers: headers(), cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) { if (my === sugSeq) showSuggest((d && d.results) || []); })
      .catch(function () { if (my === sugSeq) hideSuggest(); });
  }

  /* --------------------------- copiar o link (sem aba nova) --------------------------- */

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  function copyLink(link, btn) {
    var done = function () {
      note('Link copiado. Cole no seu app de torrent.');
      if (btn) {
        btn.textContent = 'copiado ✔';
        setTimeout(function () { btn.textContent = 'copiar magnet'; }, 1600);
      }
    };
    var fail = function () { note('Não consegui copiar o link.', 'warn'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done).catch(function () { if (legacyCopy(link)) done(); else fail(); });
    } else if (legacyCopy(link)) {
      done();
    } else {
      fail();
    }
  }

  /* --------------------------- tocar no navegador (WebTorrent) --------------------------- */

  var wt = null;
  var blobURL = '';
  var nodes = [];
  var nodeRank = [];   // nós com banda/horas sobrando, do mais folgado ao menos (vem do servidor)
  var nodeEl = document.getElementById('torrentNode');
  var logEl = document.getElementById('torrentLog');

  function log(msg) {
    if (!logEl) return;
    logEl.hidden = false;
    var t = new Date().toLocaleTimeString('pt-BR');
    logEl.textContent += '[' + t + '] ' + msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  function clearLog() { if (logEl) { logEl.textContent = ''; logEl.hidden = false; } }

  function savedNodes() {
    try {
      var v = JSON.parse(localStorage.getItem('fdsflix.torrentNodes') || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function setNodes() {
    var raw = String((nodeEl && nodeEl.value) || '');
    nodes = raw.split(/[\n,]+/).map(function (s) { return s.trim().replace(/\/+$/, ''); }).filter(Boolean);
    try { localStorage.setItem('fdsflix.torrentNodes', JSON.stringify(nodes)); } catch (e) { /* ignore */ }
    note(nodes.length + ' nó(s) salvo(s).');
  }

  // Rodízio "preso ao arquivo": o mesmo infoHash cai sempre no mesmo nó (o cache do torrent fica lá).
  // Nó esgotado (banda ou horas, segundo o painel abaixo) sai do rodízio enquanto houver outro.
  function normNode(u) { return String(u || '').trim().replace(/\/+$/, '').toLowerCase(); }

  function nodeFor(hash) {
    if (!nodes.length) return '';
    var pool = nodes;
    if (nodeRank.length) {
      var ok = nodes.filter(function (n) { return nodeRank.indexOf(normNode(n)) !== -1; });
      if (ok.length) pool = ok;
    }
    var n = parseInt(String(hash || '').slice(0, 8), 16) || 0;
    return pool[n % pool.length];
  }

  function stopTorrent() {
    playSeq += 1;
    if (wt) { try { wt.destroy(); } catch (e) { /* ignore */ } wt = null; }
    if (blobURL) { try { URL.revokeObjectURL(blobURL); } catch (e) { /* ignore */ } blobURL = ''; }
    var box = document.getElementById('torrentPlayerBox');
    if (box) { box.hidden = true; box.textContent = ''; }
    log('parado');
  }

  function showVideo(src) {
    var box = document.getElementById('torrentPlayerBox');
    if (!box) return;
    var video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText = 'width:100%;max-height:60vh;background:#000;border-radius:.5rem';
    video.src = src;
    video.addEventListener('loadedmetadata', function () { log('metadata ok: ' + Math.round(video.duration || 0) + 's'); });
    video.addEventListener('canplay', function () { log('canplay — pronto para tocar'); });
    video.addEventListener('playing', function () { log('playing'); });
    video.addEventListener('error', function () { log('ERRO no <video>: ' + (video.error && video.error.message ? video.error.message : 'code ' + (video.error && video.error.code))); });
    box.appendChild(video);
  }

  // Espera o nó baixar o começo do vídeo (e o trecho final, se o moov estiver lá) ANTES de montar o
  // <video>: assim o Chrome acha tudo no disco do nó e começa na hora, e o log mostra por que demora.
  function warmUp(node, qs, url, prep) {
    var t0 = Date.now();
    var lastLog = 0;
    var MAX_MS = 240000;
    note('Baixando o começo do filme no nó…');
    function tick() {
      return fetch(node + '/status' + qs, { cache: 'no-store' })
        .then(function (r) {
          if (r.status === 404) return { legacy: true };
          return r.json();
        })
        .then(function (st) {
          if (st.legacy) { log('nó sem /status — abrindo direto'); open(); return; }
          var w = st.warm || {};
          var secs = Math.round((Date.now() - t0) / 1000);
          if (w.done) {
            log('aquecido em ' + secs + 's | peers ' + st.wires + ' | ' + st.speedKBs + ' KB/s');
            open();
            return;
          }
          if (Date.now() - lastLog >= 5000) {
            lastLog = Date.now();
            log('baixando… ' + secs + 's | peers ' + st.wires + ' | ' + st.speedKBs + ' KB/s | começo ' +
              (w.headMB || 0) + '/' + (w.headNeedMB || '?') + ' MB' +
              (w.tailNeedMB ? ' | final ' + (w.tailMB || 0) + '/' + w.tailNeedMB + ' MB' : ''));
            note('Baixando o começo no nó… ' + (w.headMB || 0) + '/' + (w.headNeedMB || '?') + ' MB · ' + st.wires + ' peers · ' + st.speedKBs + ' KB/s');
          }
          if (Date.now() - t0 > MAX_MS) {
            log('demorou demais (' + secs + 's) — abrindo mesmo assim');
            note('Poucos peers: pode demorar para começar ou travar.', 'warn');
            open();
            return;
          }
          return new Promise(function (res) { setTimeout(res, 2000); }).then(tick);
        });
    }
    function open() {
      log('abrindo stream: ' + url.slice(0, 120) + '…');
      note('Pronto — carregando o vídeo…');
      showVideo(url);
      setTimeout(nodesRefresh, 15000); // o nó avisa o consumo a cada ~2 min; confere depois
    }
    return tick();
  }

  var playSeq = 0;

  // Ordem de tentativa: o nó "preso" ao arquivo primeiro, depois os outros (os com mais sobra de banda na frente).
  function candidates(hash) {
    var first = nodeFor(hash);
    if (!first) return [];
    var rank = function (n) { var i = nodeRank.indexOf(normNode(n)); return i === -1 ? 999 : i; };
    var rest = nodes.filter(function (n) { return n !== first; }).sort(function (a, b) { return rank(a) - rank(b); });
    return [first].concat(rest);
  }

  // Container dormindo: a plataforma responde 503 com uma página "Waking up…" SEM cabeçalho CORS, e o navegador
  // só mostra "Failed to fetch". Isso NÃO é nó quebrado: insiste a cada 3 s até ele acordar (~1 min).
  // Um GET no nó dormindo NÃO acorda nada: a página "Waking up your container..." do SnapDeploy acorda o
  // container com um POST em https://snapdeploy.dev/api/public/wake/<subdomínio> feito pelo JavaScript dela.
  // Fazemos a mesma chamada daqui (a API aceita qualquer origem). Medido: "already running" (200) num nó
  // ligado e 404 "Container not found" num que a plataforma não reconhece.
  function wakeUrlOf(node) {
    var m = /^https?:\/\/([^./]+)\.containers\.snapdeploy\.app$/i.exec(node);
    return m ? 'https://snapdeploy.dev/api/public/wake/' + m[1] : '';
  }

  function wakeNode(node, my) {
    var t0 = Date.now();
    var lastLog = 0;
    var lastWake = 0;
    var wakeUrl = wakeUrlOf(node);
    var dead = '';
    function sendWake() {
      lastWake = Date.now();
      if (!wakeUrl) return Promise.resolve();
      return fetch(wakeUrl, { method: 'POST', cache: 'no-store' })
        .then(function (r) {
          if (r.status === 404) { dead = 'o SnapDeploy não reconhece este container (apagado ou parado no painel)'; return; }
          return r.json().then(function (j) { log('sinal de acordar enviado: ' + ((j && (j.status || j.message)) || r.status)); }, function () {});
        })
        .catch(function () {
          // Sem CORS/rede: manda mesmo assim, sem ler a resposta (o POST sai do mesmo jeito).
          try { fetch(wakeUrl, { method: 'POST', mode: 'no-cors' }); } catch (e) { /* ok */ }
        });
    }
    function attempt() {
      return fetch(node + '/ping', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .catch(function (e) {
          var secs = Math.round((Date.now() - t0) / 1000);
          if (my !== playSeq) throw e;
          if (dead) throw new Error(dead);
          if (Date.now() - t0 > 100000) throw new Error('não acordou em ' + secs + 's (' + e.message + ')');
          if (Date.now() - lastLog >= 9000) {
            lastLog = Date.now();
            log('nó dormindo, acordando… ' + secs + 's (' + e.message + ')');
          }
          var step = Date.now() - lastWake >= 15000 ? sendWake() : Promise.resolve();
          return step.then(function () { return new Promise(function (res) { setTimeout(res, 3000); }); }).then(attempt);
        });
    }
    return attempt();
  }

  // Com o nó acordado: prepara o torrent (peers + metadados), aquece o começo e só então monta o <video>.
  function openOnNode(node, item) {
    var qs = '/' + item.hash + '?magnet=' + encodeURIComponent(item.magnet || '');
    var url = node + '/stream' + qs;
    note('Nó acordado — procurando peers e metadados (até ~45 s)…');
    log('preparando torrent (peers + metadados)…');
    // /prepare devolve sempre JSON com o motivo real. Sem ele o <video> só diria "Format error"
    // quando o nó responde um 504 (a plataforma troca o corpo por uma página HTML).
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 70000);
    return fetch(node + '/prepare' + qs, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        clearTimeout(to);
        if (r.status === 404) { log('nó antigo (sem /prepare) — abrindo direto'); return { legacy: true }; }
        return r.json();
      })
      .then(function (p) {
        if (p.legacy) { showVideo(url); return; }
        log('prepare: ' + (p.ready ? 'pronto' : 'NÃO pronto') + ' | peers conectados: ' + (p.wires || 0) +
          (p.name ? ' | arquivo: ' + p.name + ' (' + Math.round((p.size || 0) / 1048576) + ' MB)' : '') +
          (p.remux ? ' | vai converter para MP4 (sem avançar no tempo)' : ''));
        if (!p.ready) {
          log('motivo: ' + (p.reason || 'desconhecido'));
          note('O nó não conseguiu abrir este torrent: ' + (p.reason || 'sem resposta') + ' Tente outro resultado.', 'warn');
          return;
        }
        return warmUp(node, qs, url, p);
      });
  }

  function playTorrent(item) {
    var box = document.getElementById('torrentPlayerBox');
    if (!box) return;
    stopTorrent();
    clearLog();
    box.hidden = false;
    box.textContent = '';
    log('título: ' + (item.title || '') + ' | hash: ' + (item.hash || '') + ' | seeds: ' + (item.seeds || 0));
    log('nós configurados: ' + nodes.length + (nodes.length ? ' (' + nodes.join(', ') + ')' : ''));

    var list = candidates(item.hash);
    if (list.length) {
      var my = ++playSeq;
      var tryAt = function (i) {
        if (my !== playSeq) return; // outro vídeo foi aberto / "parar"
        if (i >= list.length) {
          log('nenhum nó respondeu — caindo no WebTorrent');
          note('Nenhum nó respondeu; tentando no navegador (WebTorrent)…', 'warn');
          playTorrentBrowser(item);
          return;
        }
        var node = list[i];
        log('nó escolhido: ' + node + (list.length > 1 ? ' (' + (i + 1) + '/' + list.length + ')' : ''));
        note('Acordando o nó… (pode levar ~1 min)');
        wakeNode(node, my)
          .then(function (txt) {
            if (my !== playSeq) return;
            log('ping respondeu: ' + txt);
            return openOnNode(node, item);
          })
          .catch(function (e) {
            if (my !== playSeq) return;
            log('falha no nó: ' + e.message + (i + 1 < list.length ? ' — tentando o próximo nó' : ''));
            tryAt(i + 1);
          });
      };
      tryAt(0);
      return;
    }
    log('sem nó configurado — usando WebTorrent do navegador');
    playTorrentBrowser(item);
  }

  function playTorrentBrowser(item) {
    var box = document.getElementById('torrentPlayerBox');
    if (!box) return;
    if (typeof WebTorrent === 'undefined') { log('WebTorrent não carregou (CDN)'); note('Sem nó e o WebTorrent não carregou (CDN).', 'warn'); return; }
    if (!WebTorrent.WEBRTC_SUPPORT) { log('navegador sem WebRTC'); note('Sem nó e este navegador não tem WebRTC.', 'warn'); return; }
    var src = item.magnet || item.torrent;
    if (!src) { log('sem link de torrent'); note('Sem link para tocar.', 'warn'); return; }
    box.hidden = false;
    box.textContent = '';
    log('webtorrent: adicionando torrent…');
    note('Conectando aos peers (WebTorrent)…');
    wt = new WebTorrent();
    wt.on('error', function (e) { note('Torrent: ' + (e && e.message ? e.message : e), 'warn'); });
    var announce = [
      'wss://tracker.webtorrent.dev',
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.files.fm:7073/announce'
    ];
    wt.add(src, { announce: announce }, function (torrent) {
      var files = (torrent.files || []).filter(function (f) { return /\.(mp4|m4v|webm|mkv|avi|mov)$/i.test(f.name); });
      var file = files.sort(function (a, b) { return (b.length || 0) - (a.length || 0); })[0];
      if (!file) { note('O torrent não tem arquivo de vídeo.', 'warn'); return; }
      note('Baixando ' + file.name + ' no navegador (fica só no cache; "parar" limpa)…');
      file.getBlobURL(function (err, url) {
        if (err) { note('Falha ao baixar: ' + (err.message || err), 'warn'); return; }
        blobURL = url;
        note('Pronto — tocando ' + file.name + '. Use "parar" para apagar do cache.');
        showVideo(url);
      });
    });
  }

  /* --------------------------- resultados de torrent --------------------------- */

  function rowOf(item) {
    var row = document.createElement('div');
    row.className = 'src-row';
    var head = document.createElement('div');
    head.className = 'src-head';
    var b = document.createElement('b');
    b.textContent = '[' + (item.audio || 'orig') + '/' + (item.quality || 'auto') + '] ' + (item.title || '');
    var meta = document.createElement('span');
    meta.className = 'src-no';
    meta.textContent = (item.seeds || 0) + ' seeds' + (item.source ? ' · ' + item.source : '');
    head.appendChild(b);
    head.appendChild(meta);
    row.appendChild(head);
    var link = item.magnet || item.torrent;
    if (link) {
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'ghost';
      copy.style.cssText = 'margin-top:.3rem';
      copy.textContent = 'copiar magnet';
      copy.title = 'Copia o link (o app não abre aba nova). Cole no seu app de torrent.';
      copy.addEventListener('click', function () { copyLink(link, copy); });
      row.appendChild(copy);

      var play = document.createElement('button');
      play.type = 'button';
      play.className = 'ghost';
      play.style.cssText = 'margin-top:.3rem;margin-left:.4rem';
      play.textContent = 'tocar aqui';
      play.title = 'Toca o vídeo no próprio navegador (WebTorrent); pode demorar para pegar peers.';
      play.addEventListener('click', function () { playTorrent(item); });
      row.appendChild(play);
      row.appendChild(document.createTextNode(' '));
      var stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'ghost';
      stop.style.cssText = 'margin-top:.3rem';
      stop.textContent = 'parar';
      stop.addEventListener('click', stopTorrent);
      row.appendChild(stop);
    }
    return row;
  }

  function render(data) {
    resultsEl.textContent = '';
    var res = (data && data.results) || [];
    if (!res.length) {
      note((data && data.note) || 'Nada encontrado.', 'warn');
      return;
    }
    var worked = ((data && data.sources) || []).filter(function (s) { return s.ok && s.count; })
      .map(function (s) { return s.name + ' (' + s.count + ')'; });
    note(res.length + ' resultado(s)' + (worked.length ? ' · ' + worked.join(', ') : ''));
    res.forEach(function (item) { resultsEl.appendChild(rowOf(item)); });
  }

  function search() {
    var title = String(input.value || '').trim();
    if (!title) { note('Informe o título.', 'warn'); return; }
    var alt = String(input.dataset.original || '').trim();
    var my = ++seq;
    note(alt && alt.toLowerCase() !== title.toLowerCase()
      ? 'Procurando "' + title + '" e "' + alt + '" nos trackers…'
      : 'Procurando no trackers…');
    resultsEl.textContent = '';
    var url = API_BASE + '/api/admin/torrents?title=' + encodeURIComponent(title) +
      '&alt=' + encodeURIComponent(alt) +
      '&year=' + encodeURIComponent(yearEl ? yearEl.value || '' : '');
    fetch(url, { headers: headers(), cache: 'no-store' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
          return d;
        });
      })
      .then(function (d) { if (my === seq) render(d); })
      .catch(function (e) { if (my === seq) note('Falhou: ' + e.message, 'warn'); });
  }

  function downloadKit() {
    note('Montando o kit…');
    fetch(API_BASE + '/api/admin/torrents/kit.zip', { headers: headers(), cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'fdsflix-torrent-kit.zip';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        note('Kit baixado (motor + CLI + README).');
      })
      .catch(function (e) { note('Não consegui baixar o kit: ' + e.message, 'warn'); });
  }

  function downloadStreamer() {
    note('Montando o streamer…');
    fetch(API_BASE + '/api/admin/torrents/streamer.zip', { headers: headers(), cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'fdsflix-torrent-streamer.zip';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        note('Streamer baixado. Suba no SnapDeploy/Koyeb (Dockerfile, porta 8080) e cole a URL (ou as URLs) dos nós aqui.');
      })
      .catch(function (e) { note('Não consegui baixar o streamer: ' + e.message, 'warn'); });
  }

  /* --------------------------- banda dos nós (abaixo do log) --------------------------- */

  var tnRows = document.getElementById('tnRows');
  var tnSummary = document.getElementById('tnSummary');
  var tnFoot = document.getElementById('tnFoot');
  var tnData = null;

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + ' MB';
    return Math.round(n / 1024) + ' KB';
  }

  function ago(ts) {
    if (!ts) return 'nunca';
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'agora há pouco';
    if (m < 90) return 'há ' + m + ' min';
    return 'há ' + Math.round(m / 60) + ' h';
  }

  function barOf(pct, small) {
    var bar = document.createElement('div');
    bar.className = 'usage-bar' + (pct >= 85 ? ' crit' : (pct >= 60 ? ' warn' : ''));
    if (small) bar.style.height = '6px';
    var i = document.createElement('i');
    i.className = 'used';
    i.style.width = Math.min(100, pct) + '%';
    bar.appendChild(i);
    return bar;
  }

  function rowFor(n, isTotal) {
    var row = document.createElement('div');
    row.className = 'usage-row';
    var name = document.createElement('div');
    name.className = 'name';
    var a = document.createElement('span');
    var state = isTotal ? '' : (n.exhausted ? ' · ⛔ esgotado (' + n.exhaustedBy + ')' : (n.asleep ? ' · 💤 dormindo' : ' · 🟢 ligado'));
    a.textContent = n.label + state;
    if (!isTotal) a.title = n.node + '\nÚltimo aviso do nó: ' + ago(n.lastSeenAt);
    var b = document.createElement('span');
    b.textContent = fmtBytes(n.egressBytes) + ' / ' + fmtBytes(n.quotaBytes) + ' (' + n.pct.toFixed(1) + '%)';
    name.appendChild(a);
    name.appendChild(b);
    row.appendChild(name);
    row.appendChild(barOf(n.pct, false));
    var meta = document.createElement('div');
    meta.className = 'usage-meta';
    meta.textContent = 'restam ' + fmtBytes(n.remainingBytes) + ' ≈ ' + n.filmsLeft + ' filme(s)' +
      (isTotal ? '' : ' (' + n.gbPerStream + ' GB/filme' + (n.gbPerStreamMeasured ? '' : ', estimado') + ')') +
      (isTotal ? '' : ' · hoje ' + fmtBytes(n.todayEgressBytes) + ' · entrou ' + fmtBytes(n.ingressBytes) + ' · ' + n.streams + ' vídeo(s)');
    row.appendChild(meta);
    var hrs = document.createElement('div');
    hrs.className = 'name';
    var h1 = document.createElement('span');
    h1.textContent = 'Horas ligado (limite de container-horas)';
    var h2 = document.createElement('span');
    h2.textContent = n.hoursUsed.toFixed(1) + ' / ' + n.hoursQuota + ' h (' + n.pctHours.toFixed(1) + '%)';
    hrs.appendChild(h1);
    hrs.appendChild(h2);
    row.appendChild(hrs);
    row.appendChild(barOf(n.pctHours, true));
    return row;
  }

  function nodesPaint(d) {
    if (!tnRows) return;
    tnData = d;
    nodeRank = (d.rank || []).map(normNode);
    tnRows.textContent = '';
    var list = d.nodes || [];
    if (!list.length) {
      tnSummary.textContent = 'nenhum nó ainda';
      tnFoot.textContent = 'Suba o streamer (zip acima) e cole a URL em "Salvar nós". O consumo aparece aqui assim que o nó reportar (até ~2 min depois de ligado).';
      return;
    }
    var t = d.total;
    tnSummary.textContent = list.length + ' nó(s) · ' + fmtBytes(t.remainingBytes) + ' livres (≈ ' + t.filmsLeft + ' filmes) · renova em ' + d.daysLeft + ' d';
    list.forEach(function (n) { tnRows.appendChild(rowFor(n, false)); });
    if (list.length > 1) {
      tnRows.appendChild(rowFor({
        label: 'TOTAL (' + list.length + ' nós)', egressBytes: t.egressBytes, quotaBytes: t.quotaBytes, pct: t.pct,
        remainingBytes: t.remainingBytes, filmsLeft: t.filmsLeft, ingressBytes: t.ingressBytes, todayEgressBytes: 0,
        hoursUsed: t.hoursUsed, hoursQuota: t.hoursQuota, pctHours: t.hoursQuota ? Math.min(100, t.hoursUsed / t.hoursQuota * 100) : 0
      }, true));
    }
    var st = d.storage || {};
    var where = !st.configured ? 'Sem Supabase: o histórico some quando o servidor reinicia.'
      : (st.tablesMissing ? '⚠ Tabela não criada: clique em "SQL do Supabase", cole no SQL Editor e rode.'
        : (st.error ? '⚠ Supabase: ' + st.error : 'Histórico no Supabase.'));
    tnFoot.textContent = 'Saída = vídeo para o navegador + upload para peers, medida pelo próprio nó. A cota (' +
      (list[0] ? fmtBytes(list[0].quotaBytes) : '?') + '/nó) é uma ASSUNÇÃO: o SnapDeploy não publica o limite de banda; ' +
      'o limite documentado é ' + d.hoursQuota + ' container-horas/mês por conta. ' + where;
    // Com TORRENT_NODES no Render, a lista é EXATAMENTE a da env (não soma o que ficou salvo neste navegador).
    var cfg = (d.configured || []).map(function (u) { return String(u || '').replace(/\/+$/, ''); });
    if (cfg.length) {
      nodes = cfg;
      if (nodeEl) nodeEl.value = nodes.join('\n');
      try { localStorage.setItem('fdsflix.torrentNodes', JSON.stringify(nodes)); } catch (e) { /* ignore */ }
    }
    var ig = d.ignored || {};
    if (ig.unresolved && ig.unresolved.length) {
      tnFoot.textContent += ' ⏳ Identificando de qual nó da env é: ' + ig.unresolved.join(', ') + ' (o consumo já está guardado e entra sozinho quando o nó acordado responder).';
    } else if (ig.count) {
      tnFoot.textContent += ' ⚠ ' + ig.count + ' relatório(s) de uma URL que não é de nenhum nó da env não puderam ser atribuídos (último: ' + ig.last + ').';
    }
  }

  function nodesRefresh() {
    if (!tnRows) return Promise.resolve();
    var qs = nodes.length ? '?nodes=' + encodeURIComponent(nodes.join(',')) : '';
    return fetch(API_BASE + '/api/admin/torrent-nodes' + qs, { headers: headers(), cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(nodesPaint)
      .catch(function (e) { if (tnSummary) tnSummary.textContent = 'sem resposta do servidor (' + e.message + ')'; });
  }

  function copySql() {
    fetch(API_BASE + '/api/admin/torrent-nodes/schema', { headers: headers(), cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (sql) {
        var done = function () { note('SQL copiado. Supabase → SQL Editor → cole → Run.'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(sql).then(done).catch(function () { if (legacyCopy(sql)) done(); });
        else if (legacyCopy(sql)) done();
      })
      .catch(function (e) { note('Não consegui pegar o SQL: ' + e.message, 'warn'); });
  }

  var tnRefreshBtn = document.getElementById('tnRefresh');
  var tnSqlBtn = document.getElementById('tnSql');
  if (tnRefreshBtn) tnRefreshBtn.addEventListener('click', nodesRefresh);
  if (tnSqlBtn) tnSqlBtn.addEventListener('click', copySql);
  // Atualiza ao carregar e a cada 60 s só enquanto o painel está na tela (não gasta chamada à toa).
  setTimeout(nodesRefresh, 1500);
  setInterval(function () { if (tnRows && tnRows.offsetParent !== null && document.visibilityState === 'visible') nodesRefresh(); }, 60000);

  var streamerBtn = document.getElementById('torrentStreamer');
  var nodeSaveBtn = document.getElementById('torrentNodeSave');
  nodes = savedNodes();
  if (nodeEl) {
    nodeEl.value = nodes.join('\n');
    nodeEl.addEventListener('change', setNodes);
  }
  if (nodeSaveBtn) nodeSaveBtn.addEventListener('click', setNodes);
  if (streamerBtn) streamerBtn.addEventListener('click', downloadStreamer);

  input.addEventListener('input', function () {
    input.dataset.original = '';
    clearTimeout(sugTimer);
    sugTimer = setTimeout(suggest, 250);
  });
  input.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideSuggest(); });
  input.addEventListener('blur', function () { setTimeout(hideSuggest, 150); });
  form.addEventListener('submit', function (e) { e.preventDefault(); hideSuggest(); search(); });
  if (kitBtn) kitBtn.addEventListener('click', downloadKit);
})();
