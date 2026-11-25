/*
 * fdsFlix · legendas OPCIONAIS em português no player de torrent.
 *
 * Não mexe no motor de torrent: só usa o <video> que o FdsTorPlayer expõe. A lista vem de /api/torrent/subtitles
 * (o mesmo buscador/conferidor do resto do site). Botão "Legenda" no canto (ou tecla c), com ajuste de tempo,
 * porque cada cópia do filme pode ter um corte diferente.
 *
 * Padrão: segue a preferência da pessoa (fdsflix.sub.pref); sem preferência, dublado começa sem e original com.
 * A faixa entra como blob: (mesma origem), então o <video> não precisa de `crossorigin` (o nó não é afetado).
 *
 *   FdsTorSubs.attach(controlador, { id, type, s, e, isDub(hash) }) -> { destroy }
 */
(function (root) {
  'use strict';

  var CONFIG = root.__FDSFLIX_CONFIG__ || {};
  var API_BASE = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  var PREF_KEY = 'fdsflix.sub.pref';
  var STEP = 0.5;

  var CSS = [
    '.tp-cc{position:absolute;top:.5rem;right:3rem;z-index:5;height:2rem;padding:0 .65rem;border-radius:.4rem;border:0;background:rgba(0,0,0,.6);color:#fff;font-size:.8rem;font-weight:600;cursor:pointer;opacity:.85}',
    '.tp-cc.on{box-shadow:inset 0 -2px 0 #e50914;opacity:1}',
    '.tp-ccmenu{position:absolute;top:2.8rem;right:.5rem;z-index:6;max-height:calc(100% - 6rem);overflow:auto;min-width:14rem;padding:.3rem;border-radius:.5rem;background:rgba(14,14,20,.96);border:1px solid rgba(255,255,255,.14);display:flex;flex-direction:column;color:#fff;font-size:.84rem;text-align:left}',
    '.tp-ccmenu[hidden],.tp-cc[hidden]{display:none}',
    '.tp-ccmenu button{border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:.45rem .6rem;border-radius:.35rem;cursor:pointer}',
    '.tp-ccmenu button:hover,.tp-ccmenu button:focus-visible{background:rgba(255,255,255,.12)}',
    '.tp-ccmenu button[aria-checked="true"]{background:rgba(229,9,20,.28)}',
    '.tp-ccsync{display:flex;align-items:center;justify-content:space-between;gap:.3rem;border-top:1px solid rgba(255,255,255,.14);margin-top:.3rem;padding-top:.3rem}',
    '.tp-ccsync span{opacity:.75;font-variant-numeric:tabular-nums}'
  ].join('');

  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* sem storage */ } }

  // Legenda começa ligada? Escolha da pessoa manda; sem escolha, só a versão original liga.
  function startsOn(pref, dub) {
    if (pref === 'off') return false;
    if (pref === 'pt') return true;
    return !dub;
  }

  function fmtOffset(v) {
    if (!v) return 'no tempo';
    return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1).replace('.', ',') + ' s';
  }

  function headers() {
    var h = {};
    if (CONFIG.apiKey) h['x-api-key'] = CONFIG.apiKey;
    return h;
  }

  function abs(url) { return /^https?:\/\//i.test(url) ? url : API_BASE + url; }

  function injectCss() {
    if (document.getElementById('tpSubStyles')) return;
    var s = document.createElement('style');
    s.id = 'tpSubStyles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function attach(controller, o) {
    var video = controller && controller.video && controller.video();
    var wrap = video && video.parentNode;
    var none = { destroy: function () {} };
    if (!video || !wrap || !o || !o.id) return none;
    injectCss();

    var dead = false;
    var list = [];
    var current = -1;      // faixa escolhida (-1 = sem legenda)
    var offset = 0;
    var decided = false;   // o padrão já foi aplicado (ou a pessoa escolheu antes)
    var load = 0;
    var track = null;
    var blobUrl = '';
    var timer = null;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tp-cc';
    btn.textContent = 'Legenda';
    btn.hidden = true;
    btn.setAttribute('aria-haspopup', 'menu');
    var menu = document.createElement('div');
    menu.className = 'tp-ccmenu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    wrap.appendChild(btn);
    wrap.appendChild(menu);

    function hash() { var st = controller.state && controller.state(); return String((st && st.hash) || ''); }
    function offsetKey() { return 'fdsflix.torsub.' + o.id + '.' + (o.s || 0) + '.' + (o.e || 0) + '.' + hash().toLowerCase() + '.' + current; }

    function clearTrack() {
      if (track) { track.track.mode = 'disabled'; if (track.parentNode) track.parentNode.removeChild(track); track = null; }
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = ''; }
    }

    // O deslocamento é aplicado nas falas já carregadas (na hora, sem baixar de novo).
    function shiftCues() {
      var cues = track && track.track.cues;
      if (!cues) return;
      var all = Array.prototype.slice.call(cues);
      all.forEach(function (c) {
        if (c.fdsStart == null) { c.fdsStart = c.startTime; c.fdsEnd = c.endTime; }
        var a = Math.max(0, c.fdsStart + offset);
        var b = Math.max(a, c.fdsEnd + offset);
        if (a > c.endTime) { c.endTime = b; c.startTime = a; } else { c.startTime = a; c.endTime = b; }
      });
    }

    function show(index, tried) {
      var my = ++load;
      current = index;
      clearTrack();
      offset = index < 0 ? 0 : Number(read(offsetKey())) || 0;
      paint();
      var cap = list[index];
      if (!cap) return;
      fetch(abs(cap.url), { headers: headers() })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function (vtt) {
          if (dead || my !== load) return;
          blobUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
          track = document.createElement('track');
          track.kind = 'subtitles';
          track.label = cap.label;
          track.srclang = 'pt';
          track.addEventListener('load', shiftCues);
          track.src = blobUrl;
          video.appendChild(track);
          track.track.mode = 'showing';
        })
        .catch(function () {
          if (dead || my !== load) return;
          // Faixa que não abriu: tenta a próxima (a lista é toda em português).
          var seen = (tried || []).concat(index);
          var next = -1;
          for (var i = 0; i < list.length; i++) if (seen.indexOf(i) === -1) { next = i; break; }
          if (next >= 0) show(next, seen); else { current = -1; paint(); }
        });
    }

    function option(label, checked, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(checked));
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    }

    function choose(index) {
      decided = true;
      write(PREF_KEY, index < 0 ? 'off' : 'pt');
      menu.hidden = true;
      show(index);
    }

    function nudge(delta) {
      offset = Math.round((offset + delta) * 10) / 10;
      write(offsetKey(), String(offset));
      shiftCues();
      paint();
    }

    function paint() {
      btn.classList.toggle('on', current >= 0);
      menu.textContent = '';
      menu.appendChild(option('Sem legenda', current < 0, function () { choose(-1); }));
      list.forEach(function (cap, i) { menu.appendChild(option(cap.label, current === i, function () { choose(i); })); });
      if (current < 0) return;
      var row = document.createElement('div');
      row.className = 'tp-ccsync';
      var minus = option('◀ Mais cedo', false, function () { nudge(-STEP); });
      var val = document.createElement('span');
      val.textContent = fmtOffset(offset);
      var plus = option('Mais tarde ▶', false, function () { nudge(STEP); });
      [minus, plus].forEach(function (b) { b.setAttribute('role', 'menuitem'); b.removeAttribute('aria-checked'); });
      row.appendChild(minus);
      row.appendChild(val);
      row.appendChild(plus);
      menu.appendChild(row);
    }

    btn.addEventListener('click', function () { menu.hidden = !menu.hidden; });
    function onKey(e) {
      if (e.key === 'Escape') menu.hidden = true;
      if ((e.key === 'c' || e.key === 'C') && list.length && !e.ctrlKey && !e.metaKey) { e.preventDefault(); choose(current >= 0 ? -1 : 0); }
    }
    wrap.addEventListener('keydown', onKey);
    video.addEventListener('click', function () { menu.hidden = true; });
    // Reconexão recarrega o vídeo: garante que a faixa escolhida continua visível.
    video.addEventListener('loadedmetadata', function () { if (track) track.track.mode = 'showing'; });

    // O botão só aparece com o vídeo na tela; o padrão é decidido aí, quando já se sabe qual cópia está tocando.
    function tick() {
      if (dead) return;
      if (!video.isConnected) { destroy(); return; }
      if (!list.length || video.style.visibility === 'hidden') return;
      btn.hidden = false;
      if (!decided) {
        decided = true;
        if (startsOn(read(PREF_KEY), !!(o.isDub && o.isDub(hash())))) show(0);
      }
      clearInterval(timer);
    }

    var qs = '?id=' + encodeURIComponent(o.id) + '&type=' + encodeURIComponent(o.type || 'movie') +
      (o.type === 'tv' ? '&s=' + (o.s || 1) + '&e=' + (o.e || 1) : '');
    function fetchList(retry) {
      fetch(API_BASE + '/api/torrent/subtitles' + qs, { headers: headers(), cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          if (dead) return;
          list = (d && d.subtitles) || [];
          if (!list.length) { if (retry) setTimeout(function () { if (!dead) fetchList(false); }, 20000); return; }
          paint();
          clearInterval(timer);
          timer = setInterval(tick, 500);
          tick();
        })
        .catch(function () { if (!dead && retry) setTimeout(function () { if (!dead) fetchList(false); }, 20000); });
    }

    function destroy() {
      if (dead) return;
      dead = true;
      clearInterval(timer);
      wrap.removeEventListener('keydown', onKey);
      clearTrack();
      [btn, menu].forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    }

    paint();
    fetchList(true);
    return { destroy: destroy };
  }

  root.FdsTorSubs = { attach: attach, _t: { startsOn: startsOn, fmtOffset: fmtOffset } };
})(window);
