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
  var srcTitle = $('srcTestTitle');
  var srcNote = $('srcTestNote');
  var srcList = $('srcTestList');
  var srcRun = $('srcTestRun');
  var relayBtn = $('relayTestBtn');
  var relayList = $('relayList');
  var webRun = $('webRun');
  var webNote = $('webNote');
  var webList = $('webList');
  var seq = 0;
  var lastData = null;
  var hls = null;        // player HLS do painel (quando a fonte entrega .m3u8)
  var srcTesting = false;
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
    var old = document.getElementById('tkFrame');
    if (old) { old.src = 'about:blank'; old.style.display = 'none'; }
    player.style.display = '';
    if (hls) { try { hls.destroy(); } catch (e) { /* ignore */ } hls = null; }
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
    if (data.catalog) extra += ' · acervo: ' + data.catalog + ' vídeo(s)';
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
      if (item.via === 'acervo') meta.appendChild(chip('📚 acervo', 'ok'));
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

  /* ---- teste de todas as fontes (é o "ver o que funciona") ---- */

  function paintSources(data) {
    srcList.textContent = '';
    var list = (data && data.results) || [];
    var okCount = list.filter(function (r) { return r.ok; }).length;
    var relay = data && data.relay;
    var via = relay ? ' · saída: ' + (relay.home ? 'residencial + worker' : (relay.worker ? 'worker' : 'só direto')) : '';
    srcNote.textContent = 'Fontes que entregaram vídeo: ' + okCount + ' de ' + list.length + via;
    srcNote.className = 'pix-note' + (okCount ? ' ok' : ' err');

    list.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'src-row';

      var name = document.createElement('span');
      name.className = 'src-name';
      name.textContent = item.name;
      row.appendChild(name);

      if (item.ok && item.dubbed) {
        var br = document.createElement('span');
        br.className = 'src-ok';
        br.style.background = '#1d3a1f';
        br.textContent = '🇧🇷 dublado';
        row.appendChild(br);
      }
      var tag = document.createElement('span');
      if (item.ok) {
        tag.className = 'src-ok';
        tag.textContent = (item.kind || 'mp4') + ' · ' + item.quality;
      } else {
        tag.className = 'src-no';
        // Mostra o motivo (curto) em vez de "sem vídeo": é o que diz POR QUE falhou.
        var reason = item.error || '';
        tag.textContent = reason ? reason.slice(0, 28) : 'sem vídeo';
        if (reason) row.title = reason;
      }
      row.appendChild(tag);

      var ms = document.createElement('span');
      ms.className = 'src-ms';
      ms.textContent = item.ms ? (item.ms > 1000 ? (item.ms / 1000).toFixed(1) + 's' : item.ms + 'ms') : '';
      row.appendChild(ms);

      if (item.ok) {
        var play = document.createElement('button');
        play.type = 'button';
        play.className = 'ghost';
        play.textContent = '▶';
        play.title = 'Tocar este resultado no painel';
        play.addEventListener('click', function () { playSource(item, play); });
        row.appendChild(play);
      }

      srcList.appendChild(row);
    });
  }

  function runSources() {
    if (srcTesting) return;
    if (!context.id) {
      srcNote.textContent = 'Abra um filme (ou episódio) primeiro — o teste usa o id do TMDB.';
      srcNote.className = 'pix-note err';
      return;
    }
    srcTesting = true;
    srcRun.disabled = true;
    srcList.textContent = '';
    srcNote.textContent = 'Testando as fontes… (pode levar alguns segundos)';
    srcNote.className = 'pix-note';

    var url = '/api/admin/sources/test?id=' + encodeURIComponent(context.id) +
      '&type=' + encodeURIComponent(context.type || 'movie') +
      '&s=' + encodeURIComponent(context.season || 1) +
      '&e=' + encodeURIComponent(context.episode || 1) +
      '&title=' + encodeURIComponent(context.title || input.value || '');

    json(url)
      .then(paintSources)
      .catch(function (err) {
        srcNote.textContent = err.message || 'O teste falhou.';
        srcNote.className = 'pix-note err';
      })
      .then(function () { srcTesting = false; srcRun.disabled = false; });
  }

  /* ---- buscar na web ("assistir <título> online grátis") ---- */

  function chip(text, cls) {
    var span = document.createElement('span');
    span.className = 'src-' + (cls || 'no');
    span.textContent = text;
    return span;
  }

  function paintWeb(data) {
    webList.textContent = '';

    // 1) O que foi achado DENTRO dos sites (redecanais e cia), com os servidores deles.
    (data.sites || []).forEach(function (site) {
      if (!site.film) return;
      var head = document.createElement('div');
      head.className = 'src-row';
      var name = document.createElement('span');
      name.className = 'src-name';
      name.textContent = site.site + ' · ' + (site.title || site.film);
      head.appendChild(name);
      var open = document.createElement('a');
      open.className = 'ghost';
      open.href = site.film;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.textContent = 'Abrir';
      head.appendChild(open);
      webList.appendChild(head);

      (site.servers || []).forEach(function (server) {
        var row = document.createElement('div');
        row.className = 'src-row';
        row.style.marginLeft = '1.2rem';
        var label = document.createElement('span');
        label.className = 'src-name';
        label.textContent = server.label + ' · ' + server.url.slice(0, 70);
        row.appendChild(label);
        if (server.audio === 'dublado') row.appendChild(chip('dublado', 'ok'));
        var playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'ghost';
        playBtn.textContent = '▶';
        playBtn.title = 'Tocar aqui dentro (player do site)';
        playBtn.addEventListener('click', function () { playEmbed(server.url, site.site + ' · ' + server.label); });
        row.appendChild(playBtn);
        var link = document.createElement('a');
        link.className = 'ghost';
        link.href = server.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Abrir';
        row.appendChild(link);
        webList.appendChild(row);
      });
    });

    var list = (data && data.results) || [];
    var blocked = (data.sites || []).filter(function (s) { return s.ok === false; });
    if (!list.length && !(data.sites || []).some(function (s) { return s.film; })) {
      var why = data && data.error ? data.error : 'Nada encontrado na busca.';
      if (blocked.length) {
        why += ' · ' + blocked.map(function (s) { return s.site + ' HTTP ' + (s.status || '?'); }).join(', ') +
          ' — o site recusou o IP do servidor (o relay também não passou).';
      }
      if (data && data.relay === false) why += ' · relay desligado.';
      webNote.textContent = why;
      webNote.className = 'pix-note err';
      return;
    }
    var foundSites = (data.sites || []).filter(function (s) { return s.film; }).length;
    webNote.textContent = (foundSites ? foundSites + ' site(s) com o filme · ' : '') +
      list.length + ' página(s) da busca · ' + (data.queries || []).join(' | ');
    webNote.className = 'pix-note ok';

    list.forEach(function (item) {
      var page = item.page || {};
      var row = document.createElement('div');
      row.className = 'src-row';

      var name = document.createElement('span');
      name.className = 'src-name';
      name.textContent = (page.host || hostOf(item.url)) + ' · ' + (page.title || item.title || '').slice(0, 60);
      row.appendChild(name);

      var hasDub = (page.options || []).some(function (o) { return o.audio === 'dublado'; });
      if (hasDub) row.appendChild(chip('dublado', 'ok'));
      if ((page.streams || []).length) row.appendChild(chip('arquivo', 'ok'));
      if ((page.options || []).length) row.appendChild(chip((page.options.length) + ' player(s)', 'ok'));
      if ((page.iframes || []).length) row.appendChild(chip((page.iframes.length) + ' iframe(s)', 'ok'));

      var open = document.createElement('a');
      open.className = 'ghost';
      open.href = item.url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.textContent = 'Abrir';
      row.appendChild(open);

      webList.appendChild(row);

      // O que a página entrega para tocar (embeds marcados como dublado primeiro).
      var options = (page.options || []).slice().sort(function (a, b) {
        return (b.audio === 'dublado' ? 1 : 0) - (a.audio === 'dublado' ? 1 : 0);
      });
      options.slice(0, 4).forEach(function (opt) {
        var sub = document.createElement('div');
        sub.className = 'src-row';
        sub.style.marginLeft = '1.2rem';
        var label = document.createElement('span');
        label.className = 'src-name';
        label.textContent = (opt.audio ? opt.audio + ' · ' : '') + opt.url.slice(0, 80);
        sub.appendChild(label);
        var play = document.createElement('button');
        play.type = 'button';
        play.className = 'ghost';
        play.textContent = '▶';
        play.title = 'Tocar aqui dentro (player do site)';
        play.addEventListener('click', function () { playEmbed(opt.url, (page.host || 'site') + ' · ' + (opt.audio || 'player')); });
        sub.appendChild(play);
        var a = document.createElement('a');
        a.className = 'ghost';
        a.href = opt.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Abrir';
        sub.appendChild(a);
        webList.appendChild(sub);
      });
    });
  }

  function runWebSearch() {
    var title = (context.title || input.value || '').trim();
    if (!title) {
      webNote.textContent = 'Abra um filme (ou digite um título) primeiro.';
      webNote.className = 'pix-note err';
      return;
    }
    webRun.disabled = true;
    webList.textContent = '';
    webNote.textContent = 'Procurando "assistir ' + title + ' online grátis"…';
    webNote.className = 'pix-note';

    var url = '/api/admin/websearch?title=' + encodeURIComponent(title) +
      (context.id ? '&id=' + encodeURIComponent(context.id) : '') +
      (context.year ? '&year=' + encodeURIComponent(context.year) : '') +
      '&type=' + encodeURIComponent(context.type || 'movie') +
      '&s=' + encodeURIComponent(context.season || 1) +
      '&e=' + encodeURIComponent(context.episode || 1);

    json(url)
      .then(paintWeb)
      .catch(function (err) {
        webNote.textContent = err.message || 'A busca falhou.';
        webNote.className = 'pix-note err';
      })
      .then(function () { webRun.disabled = false; });
  }

  // Toca o player do próprio site DENTRO do painel (iframe). É o caminho para os
  // provedores que travam o token no IP de quem assiste (vidsrc.sh e cia): o player
  // deles roda aqui e resolve o token a partir do nosso visitante.
  function playEmbed(url, label) {
    stopPlayback();
    playerBox.hidden = false;
    try { player.pause(); } catch (e) { /* ignore */ }
    player.removeAttribute('src');
    player.style.display = 'none';

    var frame = document.getElementById('tkFrame');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'tkFrame';
      frame.className = 'tk-frame';
      frame.setAttribute('allowfullscreen', '');
      frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
      frame.setAttribute('referrerpolicy', 'origin');
      playerBox.insertBefore(frame, playerInfo);
    }
    frame.style.display = 'block';
    frame.src = url;
    playerInfo.textContent = (label || 'player do site') + ' · tocando aqui dentro (o player é deles)';
  }

  /* ---- autoteste das saídas de rede (relay) ---- */

  function runRelayTest() {
    if (!relayBtn) return;
    relayBtn.disabled = true;
    relayList.textContent = '';
    var note = document.createElement('p');
    note.className = 'pix-note';
    note.textContent = 'Testando as saídas (direto, residencial, worker)…';
    relayList.appendChild(note);

    json('/api/admin/relay/test')
      .then(function (data) {
        relayList.textContent = '';
        (data.relays || []).forEach(function (relay) {
          var row = document.createElement('div');
          row.className = 'src-row';
          var name = document.createElement('span');
          name.className = 'src-name';
          name.textContent = relay.relay;
          row.appendChild(name);
          (relay.targets || []).forEach(function (t) {
            var chip = document.createElement('span');
            if (t.ok) { chip.className = 'src-ok'; chip.textContent = t.name + ' ✅'; }
            else { chip.className = 'src-no'; chip.textContent = t.name + (t.challenge ? ' 🚫' : ' ✕') + ' ' + (t.status || ''); }
            row.appendChild(chip);
          });
          relayList.appendChild(row);
        });
      })
      .catch(function (err) {
        relayList.textContent = '';
        var p = document.createElement('p');
        p.className = 'pix-note err';
        p.textContent = err.message || 'O teste falhou.';
        relayList.appendChild(p);
      })
      .then(function () { relayBtn.disabled = false; });
  }

  function playSource(item, btn) {
    stopPlayback();
    playerBox.hidden = false;
    playerInfo.textContent = 'Abrindo ' + item.name + '…';
    btn.disabled = true;

    // CORS: o CDN de uns exige, o de outros quebra com ele.
    if (item.cors) player.crossOrigin = 'anonymous';
    else player.removeAttribute('crossorigin');

    if (item.kind === 'hls' && window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
      hls.attachMedia(player);
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
        player.play().catch(function () { /* autoplay bloqueado */ });
      });
      hls.on(window.Hls.Events.ERROR, function (evt, data) {
        if (!data || !data.fatal) return;
        playerInfo.textContent = item.name + ' · o stream HLS não abriu (' + (data.details || data.type) + ')';
      });
      hls.loadSource(item.url);
    } else {
      player.src = item.url;
      player.play().catch(function () {
        playerInfo.textContent = 'Toque no ▶ do vídeo para começar (o navegador bloqueou o autoplay).';
      });
    }

    var parts = [item.name];
    if (item.quality) parts.push(String(item.quality));
    parts.push(item.kind === 'hls' ? 'stream HLS' : 'arquivo direto');
    playerInfo.textContent = parts.join(' · ');
    btn.disabled = false;
  }

  function playItem(item, btn) {
    stopPlayback();
    playerBox.hidden = false;
    playerInfo.textContent = 'Abrindo “' + (item.title || item.id) + '”…';
    btn.disabled = true;

    json('/api/admin/tokyo/play?id=' + encodeURIComponent(item.id))
      .then(function (data) {
        player.src = data.url;
        try { player.load(); } catch (e) { /* ignore */ }
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
    context = {
      id: String((item && item.id) || ''),
      type: String((item && item.type) || ''),
      season: Number(item && item.season) || 1,
      episode: Number(item && item.episode) || 1,
      title: String((item && item.title) || '')
    };
    if (srcTitle) srcTitle.textContent = context.title || 'Título aberto';
    if (!dlg.open) dlg.showModal();
    if (item && item.title) input.value = item.title;
    resultsEl.textContent = '';
    lastData = null;
    input.focus();
    if (input.value.trim()) search();
    else say('Este título não tem nome para buscar — digite um.', 'err');
    runSources();
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  if (webRun) webRun.addEventListener('click', runWebSearch);
  if (relayBtn) relayBtn.addEventListener('click', runRelayTest);

  openBtn.addEventListener('click', function () {
    if (!dlg.open) dlg.showModal();
    input.focus();
    // Sem contexto (nenhum filme aberto no player), o teste de fontes não tem o que testar.
    if (context.id) runSources();
    else if (input.value.trim() && !resultsEl.children.length) search();
    else {
      srcNote.textContent = 'Abra um filme e use o botão 🎬 nos controles do player para testar as fontes.';
      srcNote.className = 'pix-note';
    }
  });
  $('tokyoClose').addEventListener('click', function () { dlg.close(); });
  form.addEventListener('submit', function (e) { e.preventDefault(); search(); });
  if (onlyFilms) onlyFilms.addEventListener('change', paint);
  dlg.addEventListener('close', stopPlayback);

  // Ponte para o player (index.html): "buscar este filme no acervo".
  window.fdsFlixTokyo = { openFor: openFor };
})();
