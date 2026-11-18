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
  var nodeUrl = '';
  var nodeEl = document.getElementById('torrentNode');

  function savedNode() { try { return localStorage.getItem('fdsflix.torrentNode') || ''; } catch (e) { return ''; } }

  function setNode() {
    nodeUrl = String((nodeEl && nodeEl.value) || '').trim().replace(/\/+$/, '');
    try { localStorage.setItem('fdsflix.torrentNode', nodeUrl); } catch (e) { /* ignore */ }
    note(nodeUrl ? 'Nó salvo: ' + nodeUrl : 'Nó removido.');
  }

  function stopTorrent() {
    if (wt) { try { wt.destroy(); } catch (e) { /* ignore */ } wt = null; }
    if (blobURL) { try { URL.revokeObjectURL(blobURL); } catch (e) { /* ignore */ } blobURL = ''; }
    var box = document.getElementById('torrentPlayerBox');
    if (box) { box.hidden = true; box.textContent = ''; }
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
    box.appendChild(video);
  }

  function playTorrent(item) {
    var box = document.getElementById('torrentPlayerBox');
    if (!box) return;
    stopTorrent();
    box.hidden = false;
    box.textContent = '';

    var node = nodeUrl || savedNode();
    if (node) {
      note('Acordando o nó (pode levar alguns segundos)…');
      fetch(node + '/ping', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function () {
          note('Nó acordado — carregando o vídeo…');
          showVideo(node + '/stream/' + item.hash + '?magnet=' + encodeURIComponent(item.magnet || ''));
        })
        .catch(function () {
          note('Nó não respondeu; tentando no navegador (WebTorrent)…', 'warn');
          playTorrentBrowser(item);
        });
      return;
    }
    playTorrentBrowser(item);
  }

  function playTorrentBrowser(item) {
    var box = document.getElementById('torrentPlayerBox');
    if (!box) return;
    if (typeof WebTorrent === 'undefined') { note('Sem nó e o WebTorrent não carregou (CDN).', 'warn'); return; }
    if (!WebTorrent.WEBRTC_SUPPORT) { note('Sem nó e este navegador não tem WebRTC.', 'warn'); return; }
    var src = item.magnet || item.torrent;
    if (!src) { note('Sem link para tocar.', 'warn'); return; }
    box.hidden = false;
    box.textContent = '';
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
        note('Streamer baixado. Suba no Koyeb (Dockerfile, porta 8080) e cole a URL do nó aqui.');
      })
      .catch(function (e) { note('Não consegui baixar o streamer: ' + e.message, 'warn'); });
  }

  var streamerBtn = document.getElementById('torrentStreamer');
  var nodeSaveBtn = document.getElementById('torrentNodeSave');
  if (nodeEl) {
    nodeUrl = savedNode();
    nodeEl.value = nodeUrl;
    nodeEl.addEventListener('change', setNode);
  }
  if (nodeSaveBtn) nodeSaveBtn.addEventListener('click', setNode);
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
