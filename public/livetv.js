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

  var state = {
    open: false, data: null, group: '', onlyLive: false,
    cur: null, seq: 0, hls: null, watch: 0, poll: 0, polls: 0
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

    els.root.appendChild(el('div', { class: 'ltv-wrap' }, [head, els.stage, els.chips, els.list, els.note]));
    document.body.appendChild(els.root);

    els.close.addEventListener('click', close);
    els.next.addEventListener('click', function () { if (state.cur) failSource('troca manual'); });
    els.reload.addEventListener('click', function () { if (state.cur) play(state.cur.id, true); });
    els.retry.addEventListener('click', function () { if (state.cur) { state.cur.attempt = 0; request(); } });
    els.onlyLive.addEventListener('change', function () { state.onlyLive = els.onlyLive.checked; save({ onlyLive: state.onlyLive }); renderList(); });
    els.video.addEventListener('playing', onPlaying);
    els.video.addEventListener('timeupdate', function () { if (els.video.currentTime > 0 && !els.video.paused) onPlaying(); });
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
    try { els.video.pause(); } catch (e) { /* ignora */ }
    els.video.removeAttribute('src');
    try { els.video.load(); } catch (e) { /* ignora */ }
    els.frame.src = 'about:blank';
  }

  function play(id, again) {
    stopPlayer();
    var ch = state.data && state.data.channels.filter(function (c) { return c.id === id; })[0];
    state.seq += 1;
    state.cur = { id: id, name: ch ? ch.name : id, sid: '', skip: [], bad: [], attempt: 0, token: state.seq };
    els.stage.hidden = false;
    els.name.textContent = state.cur.name;
    els.via.textContent = '';
    els.video.hidden = false;
    els.frame.hidden = true;
    save({ last: id });
    renderList();
    els.stage.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    request();
  }

  function request() {
    var cur = state.cur;
    if (!cur) return;
    var token = cur.token;
    setMsg('Procurando a melhor fonte para ' + cur.name + '…', 'work');
    var q = '/api/live/stream?ch=' + encodeURIComponent(cur.id) +
      (cur.skip.length ? '&skip=' + cur.skip.join(',') : '') + (cur.bad.length ? '&bad=' + cur.bad.join(',') : '');
    cur.bad = []; // o servidor guarda o aviso; não precisa repetir
    api(q).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (res) {
      if (!state.cur || state.cur.token !== token) return; // trocou de canal no meio
      if (!res.ok || !res.j.ok) {
        setMsg((res.j && res.j.error) || 'Sem sinal agora.', 'err', true);
        refresh();
        return;
      }
      start(res.j);
    }).catch(function () {
      if (state.cur && state.cur.token === token) setMsg('Não consegui falar com o servidor.', 'err', true);
    });
  }

  function start(job) {
    var cur = state.cur;
    cur.sid = job.sid;
    els.via.textContent = '· ' + job.via;
    if (job.mode === 'page') {
      // Página de player entregue pelo AdShield: não dá para medir quadros dentro do iframe.
      els.video.hidden = true;
      els.frame.hidden = false;
      els.frame.src = job.url;
      setMsg('Abrindo o player sem anúncios…', 'work');
      setTimeout(function () { if (state.cur && state.cur.sid === job.sid) setMsg(''); }, 2500);
      return;
    }
    els.frame.hidden = true;
    els.video.hidden = false;
    attach(job.url);
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
          var bytes = data && data.frag && data.frag.stats && data.frag.stats.total;
          if (window.FdsUsage && bytes) window.FdsUsage.add(data.frag.url, bytes, data.frag.duration || 0);
        } catch (e) { /* estatística nunca derruba a TV */ }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        video.play().catch(function () { setMsg('Toque no ▶ para começar.', 'err'); });
      });
      hls.on(Hls.Events.ERROR, function (event, data) {
        if (!data || !data.fatal || !state.cur || state.cur.sid !== sid) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !state.cur.recovered) {
          state.cur.recovered = true;
          hls.recoverMediaError();
          return;
        }
        failSource((data.details || 'erro') + (data.response && data.response.code ? ' HTTP ' + data.response.code : ''));
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

  function onPlaying() {
    if (!els.msg.hidden && state.cur) setMsg('');
    clearTimeout(state.watch);
    if (state.cur) state.cur.recovered = false;
  }

  /** A fonte atual não serve para este navegador: avisa o servidor e pede a próxima. */
  function failSource(reason) {
    var cur = state.cur;
    if (!cur) return;
    if (cur.sid) { cur.bad.push(cur.sid); cur.skip.push(cur.sid); }
    cur.attempt += 1;
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
    refresh().then(schedulePoll);
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    clearTimeout(state.poll);
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
