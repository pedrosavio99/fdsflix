/*
 * fdsFlix · tela "TokyVideo" (só administrador).
 *
 * Serve para procurar um título direto no acervo do tokyvideo.com — o lugar onde às vezes
 * aparece clássico/documentário que nenhuma outra fonte tem — e tocar o vídeo ali mesmo,
 * do CDN deles direto para o navegador (0 byte no Render).
 *
 * Regras do dono: nada disto existe para o visitante. O botão e o diálogo têm a classe
 * .admin-only, o módulo não faz nada sem html.is-admin e as rotas exigem a senha.
 * Todo texto vindo do site entra por textContent (nunca innerHTML).
 */
(function () {
  'use strict';

  var openBtn = document.getElementById('tokyoOpen');
  var dlg = document.getElementById('tokyoDialog');
  if (!openBtn || !dlg) return;
  if (!document.documentElement.classList.contains('is-admin')) return;

  var CONFIG = window.__FDSFLIX_CONFIG__ || {};
  var API_BASE = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  var $ = function (id) { return document.getElementById(id); };

  var input = $('tokyoQ');
  var form = $('tokyoForm');
  var searchBtn = $('tokyoSearch');
  var resultsEl = $('tokyoResults');
  var noteEl = $('tokyoNote');
  var playerBox = $('tokyoPlayerBox');
  var player = $('tokyoPlayer');
  var playerInfo = $('tokyoPlayerInfo');
  var onlyFilms = $('tokyoOnlyFilms');
  var seq = 0;
  var lastData = null;
  // Filme aberto no player no momento em que o painel foi chamado (id do TMDB + tipo).
  var context = { id: '', type: '' };

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }

  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (CONFIG.apiKey) headers['x-api-key'] = CONFIG.apiKey;
    var key = lsGet('fdsflix.adminKey');
    if (key) headers['x-stats-key'] = key;
    opts.headers = headers;
    opts.cache = 'no-store';
    return fetch(API_BASE + path, opts);
  }

  function json(path, opts) {
    return api(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  function say(text, kind) {
    noteEl.textContent = text || '';
    noteEl.className = 'pix-note' + (kind ? ' ' + kind : '');
  }

  function stopPlayback() {
    try { player.pause(); } catch (e) { /* sem vídeo */ }
    player.removeAttribute('src');
    try { player.load(); } catch (e) { /* ignore */ }
    playerBox.hidden = true;
  }

  function chip(text, kind) {
    var span = document.createElement('span');
    span.className = 'tk-chip' + (kind ? ' ' + kind : '');
    span.textContent = text;
    return span;
  }

  function safeLink(url) {
    return /^https:\/\//i.test(String(url || '')) ? url : '';
  }

  function render(data) {
    lastData = data || null;
    paint();
  }

  function paint() {
    resultsEl.textContent = '';
    var data = lastData;
    var all = (data && data.results) || [];
    var filtered = onlyFilms && onlyFilms.checked ? all.filter(function (r) { return r.full; }) : all;
    if (!data) return;
    if (!filtered.length) {
      say(all.length
        ? 'Nenhum filme (40 min+) nesta busca — desmarque o filtro para ver os ' + all.length + ' resultado(s).'
        : 'Nada encontrado para “' + (data.query || input.value) + '”.', 'err');
      return;
    }
    var total = data.total && data.total > all.length ? ' (de ' + data.total + ')' : '';
    var extra = data.runtimeMinutes
      ? ' · o filme aberto tem ' + data.runtimeMinutes + ' min: o ✅ é o que confere'
      : ' · confira a duração antes de usar';
    say(filtered.length + ' vídeo(s)' + total + extra, 'ok');

    filtered.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'tk-row';

      var thumb = safeLink(item.thumb);
      if (thumb) {
        var img = document.createElement('img');
        img.className = 'tk-thumb';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.src = thumb;
        row.appendChild(img);
      }

      var main = document.createElement('div');
      main.className = 'tk-main';
      var title = document.createElement('b');
      title.className = 'tk-title';
      title.textContent = item.title || ('vídeo ' + item.id);
      main.appendChild(title);

      var meta = document.createElement('div');
      meta.className = 'tk-meta';
      if (item.duration) meta.appendChild(chip(item.duration));
      if (item.minutes) meta.appendChild(chip(item.minutes + ' min'));
      if (item.full) meta.appendChild(chip('🎬 filme', 'ok'));
      if (item.matchesRuntime === true) meta.appendChild(chip('✅ confere', 'ok'));
      else if (item.matchesRuntime === false) meta.appendChild(chip('duração diferente'));
      if (item.channel) meta.appendChild(chip('@' + item.channel));
      main.appendChild(meta);
      row.appendChild(main);

      var acts = document.createElement('div');
      acts.className = 'tk-acts';

      var play = document.createElement('button');
      play.type = 'button';
      play.className = 'ghost';
      play.textContent = '▶ Tocar';
      play.disabled = !item.playable;
      if (!item.playable) play.title = 'Este vídeo não tem arquivo para tocar agora';
      play.addEventListener('click', function () { playItem(item, play); });
      acts.appendChild(play);

      var link = safeLink(item.page);
      if (link) {
        var open = document.createElement('a');
        open.className = 'ghost';
        open.href = link;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        open.textContent = 'Abrir';
        acts.appendChild(open);
      }

      row.appendChild(acts);
      resultsEl.appendChild(row);
    });
  }

  function playItem(item, btn) {
    stopPlayback();
    playerBox.hidden = false;
    playerInfo.textContent = 'Abrindo “' + (item.title || item.id) + '”…';
    btn.disabled = true;

    json('/api/admin/tokyo/play?id=' + encodeURIComponent(item.id))
      .then(function (data) {
        player.src = data.url;
        player.play().catch(function () {
          playerInfo.textContent = 'Toque no ▶ do vídeo para começar (o navegador bloqueou o autoplay).';
        });
        var parts = [];
        if (data.title) parts.push(data.title);
        if (data.duration) parts.push(data.duration);
        if (data.channel) parts.push('@' + data.channel);
        parts.push('direto do CDN deles · 0 byte no Render');
        playerInfo.textContent = parts.join(' · ');
      })
      .catch(function (err) {
        stopPlayback();
        say(err.message || 'Não foi possível abrir este vídeo.', 'err');
      })
      .then(function () { btn.disabled = false; });
  }

  function search() {
    var q = String(input.value || '').trim();
    if (!q) { say('Digite um título.', 'err'); input.focus(); return; }
    var mine = ++seq;
    searchBtn.disabled = true;
    resultsEl.textContent = '';
    say('Buscando “' + q + '”…');

    var url = '/api/admin/tokyo/search?q=' + encodeURIComponent(q);
    if (context.id) url += '&id=' + encodeURIComponent(context.id) + '&type=' + encodeURIComponent(context.type || 'movie');
    json(url)
      .then(function (data) { if (mine === seq) render(data); })
      .catch(function (err) { if (mine === seq) say(err.message || 'A busca falhou.', 'err'); })
      .then(function () {
        if (mine !== seq) return;
        searchBtn.disabled = false;
        input.focus();
      });
  }

  // Chamado pelo player quando o filme está aberto: já busca aquele título.
  function openFor(item) {
    context = { id: String((item && item.id) || ''), type: String((item && item.type) || '') };
    if (!dlg.open) dlg.showModal();
    if (item && item.title) input.value = item.title;
    resultsEl.textContent = '';
    lastData = null;
    input.focus();
    if (input.value.trim()) search();
    else say('Este título não tem nome para buscar — digite um.', 'err');
  }

  openBtn.addEventListener('click', function () {
    context = { id: '', type: '' };  // aberto pela barra: busca livre
    if (!dlg.open) dlg.showModal();
    input.focus();
    if (input.value.trim() && !resultsEl.children.length) search();
  });
  $('tokyoClose').addEventListener('click', function () { dlg.close(); });
  form.addEventListener('submit', function (e) { e.preventDefault(); search(); });
  if (onlyFilms) onlyFilms.addEventListener('change', paint);
  dlg.addEventListener('close', stopPlayback);

  // Ponte para o player (index.html): "buscar este filme no acervo".
  window.fdsFlixTokyo = { openFor: openFor };
})();
