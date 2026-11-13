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
  var MPEGTS_CDN = 'https://cdn.jsdelivr.net/npm/mpegts.js@1.8.2/dist/mpegts.js'; // 1.8+ toca no iPhone (iOS 17.1+, ManagedMediaSource)
  var MPEGTS_SRI = 'sha384-sQp+4cJv0jChNCYvgy6W0RSfQZB/w6d3ZTDoIBlY4Uorfw4PLS56T2yM2z47bSkl';
  // iPhone/iPad (inclusive iPadOS que se diz Mac): o Safari toca HLS nativo e só tem MSE (ManagedMediaSource) a partir do iOS 17.1.
  var IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var NO_TS = !(window.MediaSource || window.ManagedMediaSource); // sem MSE não há como tocar MPEG-TS cru: o servidor nem oferece
  var MAX_RECONNECTS = 30;       // a Vercel corta streams longos (~5 min); reconecta sozinho

  var state = {
    open: false, data: null, group: '', onlyLive: false,
    epg: null, hero: '', cur: null, seq: 0, hls: null, ts: null, tsLast: null, watch: 0, poll: 0, polls: 0,
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


  var UI_CSS = [
    '/* herói, fileiras e cartões usam as MESMAS classes da área de filmes (.hero, .row, .rail, .track, .card); aqui só o que é da TV */',
    '.ltv .hero{height:clamp(400px,66svh,700px);margin-bottom:calc(-1 * clamp(36px,7vw,110px))}',
    '.ltv .hero-slide{background:var(--hb,linear-gradient(135deg,#2a1020,#0b0b10));opacity:1}',
    '.ltv .hero-slide::after{content:"";position:absolute;inset:0;background:radial-gradient(120% 90% at 82% 8%,rgba(255,255,255,.18),rgba(255,255,255,0) 55%)}',
    '.ltv .hero-body{padding-bottom:clamp(76px,11vw,160px)}',
    '.ltv .hero-genres .live{display:inline-flex;align-items:center;gap:.4rem;background:var(--brand);color:#fff;padding:.18rem .5rem;border-radius:5px;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase}',
    '.ltv .hero-genres .live::before{content:"";width:6px;height:6px;border-radius:50%;background:#fff;animation:ltvPulse 1.4s ease-in-out infinite}',
    '.ltv-hero-meta{display:flex;align-items:center;gap:.8rem;color:#e4e4ee;font-size:.86rem;font-weight:600;max-width:440px;margin:-.4rem 0 1.2rem}',
    '.ltv-hero-meta .ltv-prog{flex:1}',
    '.ltv-prog{height:4px;border-radius:99px;background:rgba(255,255,255,.24);overflow:hidden}',
    '.ltv-prog i{display:block;height:100%;width:0;background:var(--brand);border-radius:inherit;transition:width .6s var(--ease)}',
    '.ltv-x{position:fixed!important;z-index:30;top:calc(var(--nav-h) + .7rem);right:var(--gutter)}',
    '.ltv-barrow{position:relative;z-index:3;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;padding:0 var(--gutter);margin:0 0 .6rem}',
    '.ltv.no-hero .ltv-barrow{margin-top:1.2rem}',
    '.ltv-barrow .switch{margin-left:auto}',
    '.ltv-groups{display:flex;flex-direction:column}',
    '.ltv .hero-title{font-size:clamp(1.9rem,4.4vw,3.6rem);line-height:1.05;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}',
    '.ltv .row-title{display:flex;align-items:baseline;gap:.6rem}',
    '.ltv .row-title small{font-size:.78rem;font-weight:600;color:var(--muted);letter-spacing:0}',
    '.ltv .track{--per:1.7}',
    '@media (min-width:560px){.ltv .track{--per:2.6}}@media (min-width:860px){.ltv .track{--per:3.4}}',
    '@media (min-width:1180px){.ltv .track{--per:4.2}}@media (min-width:1640px){.ltv .track{--per:5.2}}',
    '.ltv .poster-wrap{aspect-ratio:16/9;background:var(--g,#1b1b27)}',
    '.ltv .poster-wrap::before{content:"";position:absolute;inset:0;background:radial-gradient(110% 80% at 90% 0,rgba(255,255,255,.16),rgba(255,255,255,0) 60%);z-index:1}',
    // Mais específico que `.poster-wrap img` do site (que preenche e corta): a logo fica inteira, centralizada, sem zoom.
    '.ltv .poster-wrap img.ltv-logo,.ltv .rec-poster img.ltv-logo,.ltv-modal .rec-poster img.ltv-logo,.ltv-heroart img.ltv-logo{position:absolute;inset:auto;left:50%;top:40%;transform:translate(-50%,-50%);z-index:2;',
    '  width:auto;height:auto;max-width:56%;max-height:38%;object-fit:contain;pointer-events:none;user-select:none;transition:transform .35s var(--ease)}',
    '.ltv .card:hover .poster-wrap img.ltv-logo{transform:translate(-50%,-50%) scale(1.06)}',
    '.ltv .card .poster-wrap img.ltv-logo{filter:drop-shadow(0 2px 6px rgba(0,0,0,.18))}',
    '.ltv .rec-poster img.ltv-logo,.ltv-modal .rec-poster img.ltv-logo{top:50%;max-width:62%;max-height:56%}',
    '.ltv-chname[hidden],.rec-chname[hidden]{display:none}',
    '@media (max-width:559px){.ltv .poster-wrap{aspect-ratio:3/2}.ltv .poster-wrap img.ltv-logo{top:37%;max-height:34%}}',
    '.ltv-heroart{position:absolute;z-index:1;right:var(--gutter);bottom:clamp(120px,15vw,210px);width:min(32vw,440px);aspect-ratio:16/9;border-radius:14px;background:var(--g);',
    '  box-shadow:0 22px 70px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08)}',
    '.ltv-heroart[hidden]{display:none}.ltv-heroart img.ltv-logo{top:50%;max-width:62%;max-height:58%}',
    '@media (max-width:860px){.ltv-heroart{display:none}}',
    '.ltv-chname{position:absolute;left:.9rem;right:.9rem;top:42%;transform:translateY(-50%);z-index:2;font-size:clamp(1.05rem,1.9vw,1.55rem);font-weight:900;',
    '  letter-spacing:-.02em;line-height:1.05;text-transform:uppercase;text-shadow:0 2px 12px rgba(0,0,0,.5);overflow-wrap:anywhere}',
    '.ltv-badge{position:absolute;left:.6rem;top:.6rem;z-index:4;display:inline-flex;align-items:center;gap:.35rem;font-size:.66rem;font-weight:800;letter-spacing:.08em;',
    '  text-transform:uppercase;padding:.22rem .5rem;border-radius:6px;background:rgba(0,0,0,.62);color:#fff;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}',
    '.ltv-badge.ok{background:var(--brand)}.ltv-badge.ok::before{content:"";width:6px;height:6px;border-radius:50%;background:#fff;animation:ltvPulse 1.4s ease-in-out infinite}',
    '.ltv-badge.unknown{color:var(--warn)}.ltv-badge.down{color:#9a9aae}',
    '.ltv-age{position:absolute;right:.6rem;top:.6rem;z-index:4;min-width:1.6rem;height:1.6rem;display:grid;place-items:center;border-radius:4px;font-size:.78rem;font-weight:900;color:#fff;background:#2e8b57}',
    '.ltv-age[hidden]{display:none}',
    '.ltv-age.a10{background:#0a7cc4}.ltv-age.a12{background:#d8a400;color:#111}.ltv-age.a14{background:#e8731a}.ltv-age.a16{background:#d92f2f}.ltv-age.a18{background:#111;box-shadow:inset 0 0 0 1px #fff4}',
    '.ltv-cap{position:absolute;left:0;right:0;bottom:0;z-index:3;padding:2.6rem .8rem .65rem;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.78) 55%,rgba(0,0,0,.94))}',
    '.ltv-cap[hidden]{display:none}',
    '.ltv-cap-t{display:block;font-weight:800;font-size:.92rem;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ltv-cap-m{display:block;color:#cfcfdc;font-size:.74rem;font-weight:600;margin:.1rem 0 .4rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ltv .card.down{opacity:.55}.ltv .card.down .poster-wrap{filter:grayscale(.75)}',
    '.ltv .card.active{box-shadow:0 0 0 3px #fff}',
    '.ltv .rail-btn{opacity:0}.ltv .rail:hover .rail-btn{opacity:1}',
    '.ltv-groups.settled .card,.ltv-groups.settled .row-title{animation:none}',
    '/* modal do canal: mesma estrutura do modal de filmes */',
    '.ltv-modal{z-index:40}',
    '.ltv-modal .modal-bg{background-image:var(--g);background-size:cover}',
    '.ltv-modal .video-wrap{aspect-ratio:16/9;background:#000}',
    '.ltv-modal .video-wrap video,.ltv-modal .video-wrap iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;max-height:none}',
    '.ltv-tap{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.5rem;border:0;color:#fff;font:800 1rem inherit;',
    '  background:rgba(0,0,0,.45);cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '.ltv-tap[hidden],.ltv-unmute[hidden]{display:none}',
    '.ltv-tap svg{width:64px;height:64px;fill:#fff;background:var(--brand);border-radius:50%;padding:16px 14px 16px 18px;box-sizing:border-box}',
    '.ltv-unmute{position:absolute;left:50%;top:.7rem;transform:translateX(-50%);z-index:5;border:0;border-radius:999px;padding:.5rem .95rem;font:800 .85rem inherit;color:#fff;',
    '  background:rgba(0,0,0,.72);box-shadow:0 0 0 1px rgba(255,255,255,.25);cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '.ltv-modal .video-wrap video[hidden],.ltv-modal .video-wrap iframe[hidden]{display:none}',
    '.ltv-title-row{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;padding-right:2.6rem}',
    '.ltv-title-row h2{padding-right:0!important}',
    '.ltv-meta{color:var(--muted);font-size:.84rem;margin-top:.2rem}',
    '.ltv-actions{display:flex;gap:.5rem;flex-wrap:wrap}',
    '.ltv-modal .main-pad{display:flex;flex-direction:column;gap:.9rem}',
    '.ltv-side-title{margin:0 0 .7rem;font-size:.95rem;font-weight:800;letter-spacing:-.01em}',
    '.ltv-modal .rec-item{grid-template-columns:118px minmax(0,1fr)}',
    '.ltv-modal .rec-poster{aspect-ratio:16/9;background:var(--g,#1b1b27)}',
    '.rec-chname{position:absolute;inset:0;display:grid;place-items:center;padding:.3rem;text-align:center;font-weight:900;font-size:.7rem;text-transform:uppercase;text-shadow:0 1px 6px rgba(0,0,0,.55)}',
    '.rec-dot{position:absolute;left:.35rem;top:.35rem;width:8px;height:8px;border-radius:50%;background:#5b5b6e;z-index:2}.rec-dot.ok{background:var(--brand)}',
    '.ltv-modal .rec-item.on{border-color:var(--brand);background:var(--panel-2)}',
    '.ltv-modal .rec-item.down{opacity:.5}',
    '.ltv-nowbox{display:flex;flex-direction:column;gap:.45rem;background:var(--panel-2);border:1px solid var(--line);border-radius:var(--radius);padding:.85rem 1rem}',
    '.ltv-nowbox[hidden]{display:none}',
    '.ltv-nowrow{display:flex;gap:.5rem .8rem;align-items:center;flex-wrap:wrap}',
    '.ltv-nowrow .tag{font-size:.66rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#fff;background:var(--brand);padding:.18rem .45rem;border-radius:5px}',
    '.ltv-nowtitle{font-weight:800;font-size:1.08rem;letter-spacing:-.01em}',
    '.ltv-nowmeta{color:var(--muted);font-size:.84rem}',
    '.ltv-nowdesc{color:#d6d6e4;font-size:.9rem;line-height:1.5;margin:0}',
    '.ltv-nowbox .ltv-prog{background:rgba(255,255,255,.14)}',
    '.ltv-nowfoot{color:var(--muted);font-size:.84rem}',
    '.ltv-sched-title{margin:.2rem 0 -.3rem;font-size:.95rem;font-weight:800}',
    '.ltv-sched{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:var(--panel-2);max-height:320px;overflow-y:auto}',
    '.ltv-srow{display:grid;grid-template-columns:3.6rem 1fr auto;gap:.2rem .8rem;padding:.65rem 1rem;border-top:1px solid var(--line);align-items:baseline}',
    '.ltv-srow:first-child{border-top:0}',
    '.ltv-srow time{font-weight:800;font-variant-numeric:tabular-nums;color:var(--muted)}',
    '.ltv-srow b{font-size:.95rem}.ltv-srow small{display:block;color:var(--muted);font-size:.8rem;font-weight:500;margin-top:.1rem}',
    '.ltv-srow.now{background:rgba(229,9,20,.12);box-shadow:inset 3px 0 0 var(--brand)}.ltv-srow.now time{color:#fff}',
    '.ltv-srow .ltv-age{position:static;min-width:1.5rem;height:1.5rem;font-size:.72rem}',
    '.ltv-credit{color:var(--muted);font-size:.74rem}',
    '.ltv-pad{padding:0 var(--gutter)}',
    '/* ---- celular, tablet e iPhone ---- */',
    '.ltv{padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)}',
    '.ltv-chips{display:flex;flex-wrap:wrap;gap:.5rem;flex:1 1 auto;min-width:0}',
    '.ltv-chip{min-height:40px;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}',
    '.ltv-barrow .switch{min-height:40px}',
    '.ltv-x{top:calc(var(--nav-h) + .7rem + env(safe-area-inset-top,0px));width:44px;height:44px}',
    '@media (max-width:640px){',
    '  .ltv .hero{height:auto;min-height:0;margin-bottom:-36px}',
    '  .ltv .hero-body{width:100%;padding:calc(var(--nav-h) * .35) var(--gutter) 64px}',
    '  .ltv .hero-title{font-size:clamp(1.55rem,7.4vw,2.1rem);-webkit-line-clamp:2}',
    '  .ltv .hero-overview{font-size:.88rem;-webkit-line-clamp:2;margin-bottom:.9rem}',
    '  .ltv-hero-meta{font-size:.78rem;margin:-.2rem 0 .9rem;max-width:none;flex-direction:column;align-items:stretch;gap:.4rem}',
    '  .ltv .hero-actions{flex-wrap:nowrap;gap:.55rem}',
    '  .ltv .hero-actions button{flex:1 1 0;min-width:0;min-height:44px;padding:0 .5rem;font-size:.88rem;white-space:nowrap;gap:.35rem}',
    '  .ltv .hero-actions svg{width:1.15em;height:1.15em;flex:0 0 auto}',
    '  .ltv .hero-genres{padding-right:3.2rem}',
    '  .ltv .hero-actions button span{overflow:hidden;text-overflow:ellipsis}',
    '  .ltv-barrow{flex-wrap:wrap;gap:.4rem .7rem;margin-bottom:.4rem}',
    '  .ltv-chips{flex:1 0 100%;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;margin:0 calc(-1 * var(--gutter));padding:0 var(--gutter) .2rem;',
    '    -webkit-overflow-scrolling:touch;scrollbar-width:none;scroll-snap-type:x proximity;scroll-padding-inline:var(--gutter);overscroll-behavior-x:contain}',
    '  .ltv-chips::-webkit-scrollbar{display:none}',
    '  .ltv-chips::after{content:"";flex:0 0 1px}',
    '  .ltv-chip{flex:0 0 auto;white-space:nowrap;scroll-snap-align:start}',
    '  .ltv-barrow .switch{margin-left:0}',
    '  .ltv-barrow .ltv-sub{margin-left:auto;width:auto;font-size:.78rem;text-align:right}',
    '  .ltv .row-title{font-size:1.05rem}',
    '  .ltv-note{font-size:.76rem}',
    '}',
    '@media (max-width:430px){.ltv .hero-list svg{display:none}}',
    '@media (min-width:641px) and (max-width:979px){',
    '  .ltv .hero{height:clamp(380px,44svh,480px)}',
    '  .ltv-chips{flex:1 0 100%}',
    '  .ltv-barrow .switch{margin-left:0}.ltv-barrow .ltv-sub{margin-left:auto}',
    '}',
    '/* modal do canal em tela cheia (a estrutura vem do modal de filmes): lista de outros canais vira carrossel de cartões */',
    '@media (max-width:699px), (max-width:979px) and (min-height:561px){',
    '  .ltv-modal .rec-item{grid-template-columns:1fr;flex:0 0 150px}',
    '  .ltv-modal .rec-item .rec-title,.ltv-modal .rec-item .rec-meta,.ltv-modal .rec-item small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;display:block}',
    '  .ltv-modal .rec-ov{display:none}',
    '  .ltv-modal .ltv-msg{padding:.6rem .8rem;gap:.35rem;font-size:.8rem;line-height:1.35}',
    '  .ltv-modal .ltv-msg .spinner{transform:scale(.6);margin:-.5rem 0}',
    '  .ltv-modal .ltv-msg .ghost{padding:.35rem .8rem;font-size:.8rem}',
    '  .ltv-unmute{top:.5rem;padding:.4rem .8rem;font-size:.78rem}',
    '  .ltv-tap svg{width:52px;height:52px;padding:13px 11px 13px 15px}',
    '  .ltv-sched{max-height:min(46vh,300px)}',
    '  .ltv-srow{grid-template-columns:3rem 1fr auto;padding:.55rem .8rem}',
    '  .ltv-nowbox{padding:.7rem .8rem}',
    '  .ltv-title-row h2{font-size:1.2rem}',
    '  .ltv-actions{width:100%}.ltv-actions .ghost{flex:1 1 0;min-height:42px}',
    '}',
    '/* celular deitado: vídeo e lista lado a lado; a lista usa cartões compactos */',
    '@media (max-height:560px){',
    '  .ltv .hero{height:auto}.ltv .hero-body{padding:calc(var(--nav-h) * .4) var(--gutter) 56px}',
    '  .ltv-modal .rec-item{grid-template-columns:86px minmax(0,1fr)}',
    '  .ltv-modal .modal-main,.ltv-modal .modal-side{padding-left:max(.6rem,env(safe-area-inset-left,0px))}',
    '  .ltv-modal .modal-side{padding-right:max(.6rem,env(safe-area-inset-right,0px))}',
    '  .ltv-modal .ltv-msg{padding:.5rem;font-size:.78rem}',
    '  .ltv-modal .ltv-msg .spinner{transform:scale(.55);margin:-.7rem 0}',
    '}',
    '/* ---- sintonizando: TV animada enquanto os canais são testados ---- */',
    '.ltv-tv{--s:1;--r:-24deg;position:relative;width:calc(64px*var(--s));height:calc(50px*var(--s));flex:0 0 auto;margin-top:calc(16px*var(--s))}',
    '.ltv-tv::before,.ltv-tv::after{content:"";position:absolute;bottom:calc(100% - 2px);width:calc(2px*var(--s));height:calc(17px*var(--s));background:#c9c9d6;border-radius:2px;transform-origin:50% 100%;',
    '  transform:rotate(var(--r));animation:ltvAnt 1.7s ease-in-out infinite}',
    '.ltv-tv::before{left:36%}.ltv-tv::after{left:60%;--r:22deg;animation-delay:.6s;animation-direction:reverse}',
    '@keyframes ltvAnt{50%{transform:rotate(calc(var(--r)*.3))}}',
    '.ltv-tv i{position:absolute;inset:0;border-radius:calc(10px*var(--s));background:#2a2a3a;box-shadow:inset 0 0 0 calc(3px*var(--s)) #41415a,0 6px 18px rgba(0,0,0,.35)}',
    '.ltv-tv i::after{content:"";position:absolute;right:7%;top:20%;width:9%;aspect-ratio:1;border-radius:50%;background:#c9c9d6;box-shadow:0 calc(11px*var(--s)) 0 #8a8aa0}',
    '.ltv-tv b{position:absolute;left:8%;top:11%;right:24%;bottom:11%;border-radius:calc(5px*var(--s));overflow:hidden;animation:ltvBars .9s steps(2,end) infinite;',
    '  background:linear-gradient(90deg,#f2f2f2 0 14.3%,#ffd54a 0 28.6%,#35d0d0 0 42.9%,#46d36b 0 57.2%,#e04ad0 0 71.5%,#e5091a 0 85.8%,#3a5bd9 0)}',
    '.ltv-tv b::after{content:"";position:absolute;inset:-100% 0 0;background:repeating-linear-gradient(0deg,rgba(0,0,0,.2) 0 2px,transparent 2px 4px);animation:ltvRoll 1.1s linear infinite}',
    '@keyframes ltvBars{50%{filter:saturate(.45) brightness(1.3)}}',
    '@keyframes ltvRoll{to{transform:translateY(50%)}}',
    '.ltv-scan{display:flex;align-items:center;gap:1.1rem;margin:.2rem var(--gutter) 1rem;padding:.7rem 1.1rem .7rem .9rem;border-radius:var(--radius);',
    '  background:var(--panel-2);border:1px solid var(--line);position:relative;z-index:3}',
    '.ltv-scan[hidden]{display:none}',
    '.ltv-scan-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:.35rem}',
    '.ltv-scan-t,.ltv-msg-sub{font-weight:800;line-height:1.3;min-height:1.3em}',
    '.ltv-scan-t.in,.ltv-msg-sub.in{animation:ltvIn .5s var(--ease) both}',
    '@keyframes ltvIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '.ltv-scan-s{color:var(--muted);font-size:.82rem}',
    '.ltv-scan .ltv-prog{background:rgba(255,255,255,.14)}',
    '.ltv-scan.done .ltv-tv b,.ltv-scan.done .ltv-tv b::after,.ltv-scan.done .ltv-tv::before,.ltv-scan.done .ltv-tv::after{animation:none}',
    '.ltv-scan.done .ltv-tv b{filter:none}',
    '.ltv-msg .ltv-tv{--s:.75}.ltv-msg .ltv-tv[hidden],.ltv-msg .spinner[hidden],.ltv-msg-sub[hidden]{display:none}',
    '.ltv-msg-sub{color:var(--muted);font-size:.85rem;font-weight:600;min-height:0}',
    '.ltv-skelrow .row-title span{display:block;width:9rem;height:1.1rem;border-radius:6px;background:linear-gradient(100deg,#1b1b27 30%,#262636 50%,#1b1b27 70%);background-size:220% 100%;animation:shimmerPoster 1.3s linear infinite}',
    '@media (max-width:640px){.ltv-scan{gap:.8rem;padding:.6rem .8rem .6rem .7rem}.ltv-tv{--s:.8}.ltv-scan-t{font-size:.92rem}}',
    '@media (prefers-reduced-motion:reduce){.ltv-tv::before,.ltv-tv::after,.ltv-tv b,.ltv-tv b::after,.ltv-skelrow .row-title span{animation:none}.ltv-scan-t.in,.ltv-msg-sub.in{animation:none}}',
    '.ltv-modal .modal-dialog{overscroll-behavior:contain}'
  ].join('\n');

  var css = [
    '.ltv{position:fixed;inset:0;z-index:25;background:var(--bg);overflow-y:auto;overscroll-behavior:contain;',
    '  padding:var(--nav-h) 0 calc(2rem + env(safe-area-inset-bottom,0px));}',
    '.ltv[hidden]{display:none}',
    '/* com a TV aberta a barra do topo fica sólida, senão o conteúdo rola por baixo do logo */',
    'html.ltv-open .topbar{background:rgba(11,11,16,.94);-webkit-backdrop-filter:saturate(1.4) blur(18px);backdrop-filter:saturate(1.4) blur(18px);',
    '  box-shadow:0 1px 0 rgba(255,255,255,.06)}',
    '.ltv-wrap{display:flex;flex-direction:column}',
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
    '@media (max-width:640px){.ltv-sub{margin-left:0;width:100%}}'
  ].join('\n') + '\n' + UI_CSS;
  document.head.appendChild(el('style', { text: css }));

  /* ---------------------------------- DOM ----------------------------------- */

  function build() {
    els.root = el('section', { id: 'liveTv', class: 'ltv no-hero', role: 'region', 'aria-label': 'TV ao vivo', hidden: '' });
    els.sub = el('span', { class: 'ltv-sub', text: '' });
    els.close = el('button', { class: 'modal-x ltv-x', type: 'button', 'aria-label': 'Fechar a TV ao vivo (Esc)', title: 'Fechar a TV ao vivo (Esc)', text: '✕' });

    /* herói: o mesmo da home dos filmes */
    els.heroGenres = el('div', { class: 'hero-genres' });
    els.heroTitle = el('h2', { class: 'hero-title', text: '' });
    els.heroOverview = el('p', { class: 'hero-overview', text: '' });
    els.heroBar = el('i');
    els.heroTime = el('span', { text: '' });
    els.heroPlay = el('button', { class: 'hero-play', type: 'button' });
    els.heroPlay.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><span>Assistir agora</span>';
    els.heroSched = el('button', { class: 'hero-list', type: 'button' });
    els.heroSched.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zm12 8v10H5V10z"/></svg><span>Ver programação</span>';
    els.heroArt = el('div', { class: 'ltv-heroart', 'aria-hidden': 'true' });
    els.hero = el('section', { class: 'hero', hidden: '', 'aria-label': 'Em destaque na TV' }, [
      el('div', { class: 'hero-slides' }, [el('div', { class: 'hero-slide on' })]),
      el('div', { class: 'hero-fade' }),
      els.heroArt,
      el('div', { class: 'hero-body' }, [
        els.heroGenres, els.heroTitle, els.heroOverview,
        el('div', { class: 'ltv-hero-meta' }, [els.heroTime, el('div', { class: 'ltv-prog' }, [els.heroBar])]),
        el('div', { class: 'hero-actions' }, [els.heroPlay, els.heroSched])
      ])
    ]);

    els.chips = el('div', { class: 'ltv-bar ltv-barrow', role: 'group', 'aria-label': 'Filtrar por categoria' });
    els.chipRow = el('div', { class: 'ltv-chips' });
    els.chips.appendChild(els.chipRow);
    els.onlyLive = el('input', { id: 'ltvOnlyLive', type: 'checkbox' });
    els.chips.appendChild(el('label', { class: 'switch', title: 'Mostra só os canais que têm uma fonte funcionando agora' }, [
      els.onlyLive, el('span', { class: 'slider' }), el('span', { text: 'Só os que estão no ar' })
    ]));
    els.chips.appendChild(els.sub);
    els.list = el('div', { class: 'ltv-groups' });
    els.note = el('p', { class: 'ltv-note ltv-pad', text: 'Os canais são testados de verdade antes de abrir. O vídeo não passa pelo servidor do fdsFlix; ' +
      'fontes que são páginas de player abrem pelo AdShield, que tira os anúncios.' });

    /* modal do canal: o mesmo esqueleto do modal de filmes */
    els.video = el('video', { controls: '', playsinline: '', preload: 'none', 'aria-label': 'Transmissão ao vivo' });
    els.frame = el('iframe', {
      hidden: '', title: 'Transmissão ao vivo (player sem anúncios)', allowfullscreen: '',
      allow: 'autoplay; fullscreen; encrypted-media; picture-in-picture', referrerpolicy: 'origin'
    });
    els.tap = el('button', { class: 'ltv-tap', type: 'button', hidden: '', 'aria-label': 'Tocar o canal' });
    els.tap.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><span>Toque para assistir</span>';
    els.unmute = el('button', { class: 'ltv-unmute', type: 'button', hidden: '', text: '🔇 Ativar o som' });
    els.msgText = el('div', { text: '' });
    els.spin = el('div', { class: 'spinner', hidden: '' });
    els.mtv = tvEl(); els.mtv.hidden = true;
    els.msgSub = el('div', { class: 'ltv-msg-sub', hidden: '', 'aria-hidden': 'true', text: '' });
    els.retry = el('button', { class: 'ghost', type: 'button', hidden: '', text: 'Tentar outra fonte' });
    els.msg = el('div', { class: 'ltv-msg', role: 'status', 'aria-live': 'polite', hidden: '' }, [els.mtv, els.spin, els.msgText, els.msgSub, els.retry]);

    els.name = el('h2', { text: '' });
    els.via = el('div', { class: 'ltv-meta', text: '' });
    els.next = el('button', { class: 'ghost', type: 'button', text: '⏭ Outra fonte' });
    els.reload = el('button', { class: 'ghost', type: 'button', text: '↻ Recarregar' });
    els.nowTitle = el('span', { class: 'ltv-nowtitle', text: '' });
    els.nowMeta = el('span', { class: 'ltv-nowmeta', text: '' });
    els.nowAge = el('span', { class: 'ltv-age', hidden: '' });
    els.nowDesc = el('p', { class: 'ltv-nowdesc', text: '' });
    els.nowBar = el('i');
    els.nowNext = el('span', { text: '' });
    els.nowBox = el('div', { class: 'ltv-nowbox', hidden: '' }, [
      el('div', { class: 'ltv-nowrow' }, [el('span', { class: 'tag', text: 'No ar' }), els.nowTitle, els.nowAge, els.nowMeta]),
      els.nowDesc,
      el('div', { class: 'ltv-prog' }, [els.nowBar]),
      el('div', { class: 'ltv-nowfoot' }, [els.nowNext])
    ]);
    els.sched = el('div', { class: 'ltv-sched', role: 'region', 'aria-label': 'Programação do canal' });
    els.schedTitle = el('h3', { class: 'ltv-sched-title', text: 'Programação' });
    els.side = el('div', { class: 'rec-list' });
    buildNerd();

    els.mClose = el('button', { class: 'modal-x', type: 'button', 'aria-label': 'Fechar o canal (Esc)', title: 'Fechar (Esc)', text: '✕' });
    els.mBg = el('div', { class: 'modal-bg on', 'aria-hidden': 'true' });
    els.mScroll = el('div', { class: 'modal-scroll' }, [
      el('div', { class: 'modal-grid' }, [
        el('div', { class: 'modal-main' }, [
          el('div', { class: 'video-wrap' }, [els.video, els.frame, els.msg, els.tap, els.unmute]),
          el('div', { class: 'main-pad' }, [
            el('div', { class: 'player-header' }, [
              el('div', { class: 'ph-title' }, [el('div', { class: 'ltv-title-row' }, [els.name, el('span', { class: 'ltv-live', text: 'Ao vivo' })]), els.via]),
              el('div', { class: 'ltv-actions' }, [els.next, els.reload])
            ]),
            els.nowBox, els.schedTitle, els.sched, els.nerd
          ])
        ]),
        el('div', { class: 'modal-side' }, [el('h3', { class: 'ltv-side-title', text: 'Outros canais' }), els.side])
      ])
    ]);
    els.mDialog = el('div', { class: 'modal-dialog', tabindex: '-1' }, [els.mBg, els.mClose, els.mScroll]);
    els.mBackdrop = el('div', { class: 'modal-backdrop' });
    els.modal = el('section', { class: 'modal ltv-modal', hidden: '', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Canal ao vivo' }, [els.mBackdrop, els.mDialog]);

    els.scanT = el('div', { class: 'ltv-scan-t', text: '' });
    els.scanS = el('div', { class: 'ltv-scan-s', text: '' });
    els.scanBar = el('i');
    els.scan = el('div', { class: 'ltv-scan', hidden: '', role: 'status', 'aria-label': 'Procurando os canais que estão no ar' }, [
      tvEl(),
      el('div', { class: 'ltv-scan-body' }, [els.scanT, els.scanS, el('div', { class: 'ltv-prog' }, [els.scanBar])])
    ]);
    els.root.appendChild(el('div', { class: 'ltv-wrap' }, [els.hero, els.chips, els.scan, els.list, els.note]));
    els.root.appendChild(els.close);
    document.body.appendChild(els.root);
    document.body.appendChild(els.modal);

    els.close.addEventListener('click', close);
    els.mClose.addEventListener('click', closeModal);
    els.mBackdrop.addEventListener('click', closeModal);
    els.next.addEventListener('click', function () { if (state.cur) failSource('troca manual'); });
    els.reload.addEventListener('click', function () { if (state.cur) play(state.cur.id, true); });
    els.retry.addEventListener('click', function () { if (state.cur) { state.cur.attempt = 0; request(); } });
    els.onlyLive.addEventListener('change', function () { state.onlyLive = els.onlyLive.checked; save({ onlyLive: state.onlyLive }); renderList(); });
    els.heroPlay.addEventListener('click', function () { if (state.hero) play(state.hero); });
    els.heroSched.addEventListener('click', function () { if (state.hero) play(state.hero); });
    els.video.addEventListener('playing', onPlaying);
    els.tap.addEventListener('click', function () { els.tap.hidden = true; if (state.cur) state.cur.needTap = false; try { var p = els.video.play(); if (p && p.catch) p.catch(function () { els.tap.hidden = false; }); } catch (e) { /* ignora */ } });
    els.unmute.addEventListener('click', function () { els.video.muted = false; els.unmute.hidden = true; });
    els.video.addEventListener('volumechange', function () { if (!els.video.muted) els.unmute.hidden = true; });
    els.video.addEventListener('timeupdate', function () { if (els.video.currentTime > 0 && !els.video.paused) onPlaying(); });
  }

  /** Fecha o modal do canal (a TV continua aberta atrás). */
  function closeModal() {
    if (!els.modal || els.modal.hidden) return;
    stopPlayer();
    state.cur = null;
    state.seq += 1;
    els.modal.hidden = true;
    renderList();
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
  var LABEL = { ok: 'no ar', unknown: 'sintonizando', raw: 'só TS cru (sem suporte)', down: 'fora do ar agora' };

  function renderChips() {
    var data = state.data;
    Array.prototype.slice.call(els.chipRow.querySelectorAll('.ltv-chip')).forEach(function (n) { n.remove(); });
    var names = [''].concat(data ? data.groups : []);
    names.forEach(function (name, i) {
      var chip = el('button', { class: 'ltv-chip', type: 'button', 'aria-pressed': String(state.group === name), text: name || 'Todos' });
      chip.addEventListener('click', function () { state.group = name; save({ group: name }); renderChips(); renderList(); });
      els.chipRow.appendChild(chip);
    });
  }

  var BADGE = { ok: 'Ao vivo', unknown: 'Sintonizando…', raw: 'TS cru', down: 'Fora do ar' };

  /* --------------------------- programação (EPG) --------------------------- */

  function hhmm(ms) { return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
  function hueOf(id) { var h = 7; for (var i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h % 360; }
  function chOf(id) { var l = state.data && state.data.channels; if (!l) return null; for (var i = 0; i < l.length; i += 1) if (l[i].id === id) return l[i]; return null; }
  /** Fundo ESCURO (destaque e modal): toque da cor da marca, ou um cinza discreto quando o canal não tem logo. */
  function gradFor(id) {
    var c = chOf(id), h = hueOf(id);
    return c && c.logo ? 'linear-gradient(135deg,' + c.logo.d + ',#0b0b10 88%)' : 'linear-gradient(135deg,hsl(' + h + ' 16% 17%),#0b0b10 88%)';
  }
  /** Fundo do CARTÃO: claro quando a logo é escura e escuro quando é clara (sempre legível); sem logo, cinza sóbrio. */
  function tileFor(id) {
    var c = chOf(id), h = hueOf(id);
    return c && c.logo ? 'linear-gradient(145deg,' + c.logo.a[0] + ',' + c.logo.a[1] + ')' : 'linear-gradient(145deg,hsl(' + h + ' 14% 24%),hsl(' + h + ' 16% 12%))';
  }
  /** Logo do canal; se a imagem não carregar (host fora do ar), some e o nome do canal assume. */
  function logoEl(c, cls, nameEl) {
    if (!c || !c.logo) return null;
    var img = el('img', { class: cls, src: c.logo.u, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' });
    img.addEventListener('error', function () { img.remove(); if (nameEl) nameEl.hidden = false; });
    if (nameEl) nameEl.hidden = true;
    return img;
  }
  function pctOf(p) { return Math.max(0, Math.min(100, (Date.now() - p.st) / Math.max(1, p.en - p.st) * 100)); }

  /** O que passa agora no canal, mesmo se a resposta do servidor ficou velha por alguns minutos. */
  function progOf(id) {
    var e = state.epg && state.epg.map[id];
    if (!e) return null;
    var t = Date.now();
    if (e.now && e.now.en > t && e.now.st <= t) return { now: e.now, next: e.next };
    if (e.next && e.next.st <= t && e.next.en > t) return { now: { t: e.next.t, s: '', d: '', st: e.next.st, en: e.next.en, a: '' }, next: null };
    return null;
  }

  function ageClass(a) { return a && a !== 'L' ? ' a' + a : ''; }
  function setAge(node, a) {
    node.hidden = !a;
    node.textContent = a || '';
    node.className = 'ltv-age' + ageClass(a);
    node.title = a ? (a === 'L' ? 'Livre para todos os públicos' : 'Não recomendado para menores de ' + a + ' anos') : '';
  }

  function loadEpg() {
    return api('/api/live/epg').then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) return;
      state.epg = { map: j.channels || {}, at: Date.now(), info: j };
      paintEpg();
      var empty = !Object.keys(state.epg.map).length;
      clearTimeout(state.epgRetry);
      if (empty && state.open && (state.epgTries = (state.epgTries || 0) + 1) < 6) state.epgRetry = setTimeout(loadEpg, 7000);
    }).catch(function () { /* sem programação a TV continua igual */ });
  }

  /** Atualiza títulos, horários e barras sem refazer a lista (nem perder a rolagem). */
  function paintEpg() {
    if (!els.list) return;
    Array.prototype.slice.call(els.list.querySelectorAll('.card')).forEach(function (card) {
      var id = card.getAttribute('data-id');
      var p = progOf(id);
      var cap = card.querySelector('.ltv-cap');
      var age = card.querySelector('.ltv-age');
      if (!p) { cap.hidden = true; setAge(age, ''); return; }
      cap.hidden = false;
      cap.querySelector('.ltv-cap-t').textContent = p.now.t;
      cap.querySelector('.ltv-cap-m').textContent = hhmm(p.now.st) + '–' + hhmm(p.now.en) + (p.next ? ' · A seguir: ' + p.next.t : '');
      cap.querySelector('.ltv-prog i').style.width = pctOf(p.now) + '%';
      setAge(age, p.now.a);
    });
    paintStage();
    renderHero();
    if (state.cur) renderSide();
  }

  function paintStage() {
    if (!els.nowBox) return;
    var cur = state.cur, p = cur && progOf(cur.id);
    els.nowBox.hidden = !p;
    if (!p) return;
    els.nowTitle.textContent = p.now.t + (p.now.s ? ' · ' + p.now.s : '');
    els.nowMeta.textContent = hhmm(p.now.st) + '–' + hhmm(p.now.en);
    setAge(els.nowAge, p.now.a);
    els.nowDesc.textContent = p.now.d || '';
    els.nowDesc.hidden = !p.now.d;
    els.nowBar.style.width = pctOf(p.now) + '%';
    els.nowNext.textContent = p.next ? 'A seguir às ' + hhmm(p.next.st) + ': ' + p.next.t : '';
  }

  /** Grade do canal no modal: carregada ao abrir o canal. */
  function loadSched() {
    if (!state.cur) return;
    var id = state.cur.id;
    els.sched.textContent = '';
    els.sched.appendChild(el('div', { class: 'ltv-srow', text: 'Carregando a programação…' }));
    api('/api/live/epg?ch=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (j) {
      if (!state.cur || state.cur.id !== id) return;
      els.sched.textContent = '';
      var items = (j && j.items) || [];
      if (!items.length) { els.sched.appendChild(el('div', { class: 'ltv-srow', text: 'Sem programação disponível para este canal agora.' })); return; }
      var t = Date.now();
      items.forEach(function (it) {
        var age = el('span', { class: 'ltv-age', hidden: '' });
        setAge(age, it.a);
        els.sched.appendChild(el('div', { class: 'ltv-srow' + (it.st <= t && it.en > t ? ' now' : '') }, [
          el('time', { text: hhmm(it.st) }),
          el('div', {}, [el('b', { text: it.t }), it.s || it.d ? el('small', { text: it.s || it.d.slice(0, 140) }) : null]),
          age
        ]));
      });
      els.sched.appendChild(el('div', { class: 'ltv-srow' }, [el('span'), el('span', { class: 'ltv-credit', text: 'Horários no fuso do seu aparelho · guia mantido pela comunidade (pode haver atrasos ou mudanças).' }), el('span')]));
    }).catch(function () { els.sched.textContent = ''; els.sched.appendChild(el('div', { class: 'ltv-srow', text: 'Não consegui carregar a programação.' })); });
  }

  /** Destaque: o último canal assistido (se estiver no ar), senão o primeiro canal no ar com programação, esportes primeiro. */
  function renderHero() {
    if (!els.hero) return;
    var data = state.data, pick = null;
    if (data) {
      var live = data.channels.filter(function (c) { return c.status === 'ok'; });
      var withEpg = live.filter(function (c) { return progOf(c.id); });
      var last = load().last;
      pick = withEpg.filter(function (c) { return c.id === last; })[0] ||
        withEpg.filter(function (c) { return c.group === 'Esportes'; })[0] || withEpg[0] || null;
    }
    els.hero.hidden = !pick;
    els.root.classList.toggle('no-hero', !pick);
    state.hero = pick ? pick.id : '';
    if (!pick) return;
    var p = progOf(pick.id);
    els.hero.style.setProperty('--hb', gradFor(pick.id));
    els.heroArt.textContent = '';
    els.heroArt.style.setProperty('--g', tileFor(pick.id));
    var heroLogo = logoEl(pick, 'ltv-logo', null);
    els.heroArt.hidden = !heroLogo;
    if (heroLogo) els.heroArt.appendChild(heroLogo);
    els.heroGenres.textContent = '';
    els.heroGenres.appendChild(el('span', { class: 'live', text: 'Ao vivo' }));
    els.heroGenres.appendChild(el('span', { text: pick.name }));
    els.heroGenres.appendChild(el('span', { text: pick.group }));
    els.heroTitle.textContent = p.now.t;
    els.heroOverview.textContent = [p.now.s, p.now.d].filter(Boolean).join(' · ');
    els.heroOverview.hidden = !els.heroOverview.textContent;
    els.heroBar.style.width = pctOf(p.now) + '%';
    els.heroTime.textContent = hhmm(p.now.st) + '–' + hhmm(p.now.en) + (p.next ? ' · depois: ' + p.next.t : '');
  }

  /** Lista lateral do modal: os outros canais (no ar primeiro), para trocar sem fechar. */
  function renderSide() {
    if (!els.side || !state.data || !els.modal || els.modal.hidden) return;
    var cur = state.cur && state.cur.id;
    var items = state.data.channels.map(function (c, i) { return { c: c, i: i }; })
      .sort(function (a, b) { return (ORDER[a.c.status] - ORDER[b.c.status]) || (a.i - b.i); })
      .map(function (x) { return x.c; });
    els.side.textContent = '';
    items.forEach(function (c) {
      var p = progOf(c.id);
      var sName = el('span', { class: 'rec-chname', text: c.name });
      var poster = el('div', { class: 'rec-poster' }, [el('span', { class: 'rec-dot ' + c.status }), sName, logoEl(c, 'ltv-logo', sName)]);
      poster.style.setProperty('--g', tileFor(c.id));
      var item = el('div', { class: 'rec-item' + (c.id === cur ? ' on' : '') + (c.status === 'down' ? ' down' : ''), role: 'button', tabindex: '0', 'data-id': c.id, 'aria-label': c.name + ', ' + LABEL[c.status] }, [
        poster,
        el('div', { class: 'rec-body' }, [
          el('div', { class: 'rec-title', text: c.name }),
          el('div', { class: 'rec-meta', text: p ? p.now.t + ' · ' + hhmm(p.now.st) + '–' + hhmm(p.now.en) : LABEL[c.status] })
        ])
      ]);
      var go = function () { if (c.id !== cur) play(c.id); };
      item.addEventListener('click', go);
      item.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      els.side.appendChild(item);
    });
  }

  /* ------------------------------- fileiras ------------------------------- */

  function cardEl(c, i) {
    var card = el('div', { class: 'card' + (c.status === 'down' ? ' down' : '') + (state.cur && state.cur.id === c.id ? ' active' : ''), role: 'button', tabindex: '0', 'data-id': c.id, 'aria-label': c.name + ', ' + LABEL[c.status] });
    card.style.animationDelay = Math.min(i, 8) * 0.04 + 's';
    var cName = el('span', { class: 'ltv-chname', text: c.name });
    var poster = el('div', { class: 'poster-wrap' }, [
      el('span', { class: 'ltv-badge ' + c.status, text: BADGE[c.status] || '' }),
      el('span', { class: 'ltv-age', hidden: '' }),
      cName,
      logoEl(c, 'ltv-logo', cName),
      el('span', { class: 'ltv-cap', hidden: '' }, [el('span', { class: 'ltv-cap-t' }), el('span', { class: 'ltv-cap-m' }), el('span', { class: 'ltv-prog', style: 'display:block' }, [el('i')])])
    ]);
    poster.style.setProperty('--g', tileFor(c.id));
    card.appendChild(poster);
    var go = function () { play(c.id); };
    card.addEventListener('click', go);
    card.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    return card;
  }

  function rowEl(title, items, note) {
    var track = el('div', { class: 'track' });
    items.forEach(function (c, i) { track.appendChild(cardEl(c, i)); });
    var prev = el('button', { class: 'rail-btn prev', type: 'button', 'aria-label': 'Anteriores' }, [el('span', { text: '‹', 'aria-hidden': 'true' })]);
    var next = el('button', { class: 'rail-btn next', type: 'button', 'aria-label': 'Próximos' }, [el('span', { text: '›', 'aria-hidden': 'true' })]);
    prev.addEventListener('click', function () { track.scrollBy({ left: -track.clientWidth * 0.85, behavior: 'smooth' }); });
    next.addEventListener('click', function () { track.scrollBy({ left: track.clientWidth * 0.85, behavior: 'smooth' }); });
    return el('section', { class: 'row' }, [
      el('h3', { class: 'row-title' }, [el('span', { text: title }), note ? el('small', { text: note }) : null]),
      el('div', { class: 'rail' }, [prev, track, next])
    ]);
  }

  /** Fileiras de cartões "fantasma" (o mesmo brilho dos filmes) enquanto a lista não chega. */
  function skeletonRows() {
    return [0, 1].map(function () {
      var track = el('div', { class: 'track' });
      for (var i = 0; i < 6; i += 1) track.appendChild(el('div', { class: 'card skel', 'aria-hidden': 'true' }, [el('div', { class: 'poster-wrap' }), el('div', { class: 'info' })]));
      return el('section', { class: 'row ltv-skelrow', 'aria-hidden': 'true' }, [el('h3', { class: 'row-title' }, [el('span')]), el('div', { class: 'rail' }, [track])]);
    });
  }

  function renderList() {
    var data = state.data;
    // A lista é refeita a cada atualização do servidor: guarda a rolagem de cada fileira e só anima na primeira vez.
    var scrolls = {};
    Array.prototype.slice.call(els.list.querySelectorAll('.row')).forEach(function (row) {
      var t = row.querySelector('.row-title span');
      if (t) scrolls[t.textContent] = row.querySelector('.track').scrollLeft;
    });
    els.list.classList.toggle('settled', !!state.rendered);
    els.list.textContent = '';
    if (!data) { skeletonRows().forEach(function (row) { els.list.appendChild(row); }); paintScan(null); return; }
    var shown = 0;
    var sorted = function (items) {
      return items.map(function (c, i) { return { c: c, i: i }; })
        .sort(function (a, b) { return (ORDER[a.c.status] - ORDER[b.c.status]) || (a.i - b.i); })
        .map(function (x) { return x.c; });
    };
    // Primeira fileira: o que está no ar com programação conhecida (só no "Todos").
    if (!state.group) {
      var hot = data.channels.filter(function (c) { return c.status === 'ok' && progOf(c.id); }).slice(0, 12);
      if (hot.length) els.list.appendChild(rowEl('No ar agora', hot, 'o que está passando'));
    }
    data.groups.forEach(function (group) {
      if (state.group && state.group !== group) return;
      var items = data.channels.filter(function (c) { return c.group === group && (!state.onlyLive || c.status === 'ok'); });
      if (!items.length) return;
      var okN = items.filter(function (c) { return c.status === 'ok'; }).length;
      els.list.appendChild(rowEl(group, sorted(items), okN + ' no ar'));
      shown += items.length;
    });
    if (!shown) {
      els.list.appendChild(el('p', { class: 'ltv-empty', text: state.onlyLive
        ? 'Nenhum canal está no ar agora. Aguarde alguns segundos (os testes ainda rodam) ou desligue o filtro.'
        : 'Nenhum canal nesta categoria.' }));
    }
    var live = data.channels.filter(function (c) { return c.status === 'ok'; }).length;
    var unknown = data.channels.filter(function (c) { return c.status === 'unknown'; }).length;
    els.sub.textContent = live + ' no ar de ' + data.channels.length;
    paintScan(data);
    Array.prototype.slice.call(els.list.querySelectorAll('.row')).forEach(function (row) {
      var t = row.querySelector('.row-title span');
      if (t && scrolls[t.textContent]) row.querySelector('.track').scrollLeft = scrolls[t.textContent];
    });
    if (data.channels.length) state.rendered = true;
    renderSide();
    paintEpg();
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

  /* ------------------ sintonizando: TV animada e frases simpáticas ------------------ */

  var SCAN_PHRASES = [
    'Ajeitando a antena… 📡', 'Dando um tapinha na TV pra pegar o sinal', 'Esquentando a pipoca 🍿',
    'Procurando o controle remoto no sofá…', 'Acordando os canais, um por um 😴', 'Perguntando pro vizinho se tá passando',
    'Trocando a pilha do controle 🔋', 'Chamando o técnico da TV… ele já vem', 'Sintonizando bem devagarinho…',
    'Soprando o sinal pra ele pegar 😅'
  ];
  var MSG_PHRASES = ['Ajeitando a antena… 📡', 'Dando um tapinha no sinal 👋', 'Procurando o melhor sinal…', 'Já já pega, segura aí 🤞', 'Esquentando a transmissão…'];
  var scan = { timer: 0, i: 0, done: 0 };
  var msgAnim = { timer: 0, i: 0, t0: 0, last: '' };

  function tvEl(scale) {
    var t = el('div', { class: 'ltv-tv', 'aria-hidden': 'true' }, [el('i'), el('b')]);
    if (scale) t.style.setProperty('--s', String(scale));
    return t;
  }

  function setPhrase(node, text) {
    node.classList.remove('in');
    void node.offsetWidth; // reinicia a animação de entrada
    node.textContent = text;
    node.classList.add('in');
  }

  function stopScan() { clearInterval(scan.timer); scan.timer = 0; }

  function startScan() {
    if (scan.timer) return;
    scan.i = Math.floor(Math.random() * SCAN_PHRASES.length);
    setPhrase(els.scanT, SCAN_PHRASES[scan.i]);
    scan.timer = setInterval(function () {
      if (!els.scan || els.scan.hidden || !state.open) { stopScan(); return; }
      scan.i = (scan.i + 1) % SCAN_PHRASES.length;
      setPhrase(els.scanT, SCAN_PHRASES[scan.i]);
    }, 2800);
  }

  function hideScan() {
    stopScan();
    clearTimeout(scan.done);
    if (els.scan) { els.scan.hidden = true; els.scan.classList.remove('done'); }
    state.scanShown = false;
  }

  /** Faixa "sintonizando": aparece enquanto há canal sendo testado e some com um "tudo pronto" curtinho. */
  function paintScan(data) {
    if (!els.scan) return;
    var total = data ? data.channels.length : 0;
    var unknown = data ? data.channels.filter(function (c) { return c.status === 'unknown'; }).length : 0;
    var live = data ? data.channels.filter(function (c) { return c.status === 'ok'; }).length : 0;
    if (!data || (total && unknown)) {
      clearTimeout(scan.done);
      els.scan.classList.remove('done');
      els.scan.hidden = false;
      state.scanShown = true;
      startScan();
      var tested = total - unknown;
      els.scanS.textContent = data ? tested + ' de ' + total + ' canais testados · ' + live + ' já no ar' : 'Ligando a TV…';
      els.scanBar.style.width = data ? Math.max(6, Math.round(tested / total * 100)) + '%' : '6%';
    } else if (state.scanShown && !els.scan.classList.contains('done')) {
      stopScan();
      els.scan.classList.add('done');
      els.scan.hidden = false;
      setPhrase(els.scanT, live ? 'Tudo pronto! Bom divertimento 🎉' : 'Terminei de procurar 🤷');
      els.scanS.textContent = live + ' de ' + total + ' canais no ar';
      els.scanBar.style.width = '100%';
      scan.done = setTimeout(hideScan, 3000);
    }
  }

  function stopMsgAnim() { clearInterval(msgAnim.timer); msgAnim.timer = 0; }

  function paintMsgSub() {
    var slow = Date.now() - msgAnim.t0 > 12000;
    setPhrase(els.msgSub, slow ? 'Tá demorando mais que o normal, mas continuo tentando…' : MSG_PHRASES[msgAnim.i % MSG_PHRASES.length]);
  }

  function startMsgAnim(text) {
    if (text !== msgAnim.last) { msgAnim.last = text; msgAnim.t0 = Date.now(); }
    if (msgAnim.timer) return;
    msgAnim.t0 = Date.now();
    msgAnim.i = Math.floor(Math.random() * MSG_PHRASES.length);
    paintMsgSub();
    msgAnim.timer = setInterval(function () {
      if (els.msg.hidden || !state.cur) { stopMsgAnim(); return; }
      msgAnim.i += 1;
      paintMsgSub();
    }, 2600);
  }

  function setMsg(text, kind, retry) {
    if (!text) { els.msg.hidden = true; stopMsgAnim(); return; }
    els.msg.hidden = false;
    els.msgText.textContent = text;
    els.spin.hidden = true;
    var working = kind === 'work';
    els.mtv.hidden = !working;
    els.msgSub.hidden = !working;
    if (working) startMsgAnim(text); else stopMsgAnim();
    els.retry.hidden = !retry;
  }

  function stopPlayer() {
    clearTimeout(state.watch);
    if (!els.video) return; // a TV ainda não foi aberta (o pagehide chama isto em qualquer recarga)
    els.video.onerror = null;
    els.tap.hidden = true; els.unmute.hidden = true; els.video.muted = false;
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
    els.modal.hidden = false;
    els.mDialog.style.setProperty('--g', gradFor(id));
    els.mScroll.scrollTop = 0;
    els.name.textContent = state.cur.name;
    els.via.textContent = '';
    els.video.hidden = false;
    els.frame.hidden = true;
    save({ last: id });
    renderList();
    renderSide();
    paintStage();
    loadSched();
    try { els.mDialog.focus({ preventScroll: true }); } catch (e) { /* ignora */ }
    nlog('abrir', cur0log());
    request();
  }

  function request() {
    var cur = state.cur;
    if (!cur) return;
    var token = cur.token;
    setMsg('Procurando a melhor fonte para ' + cur.name + '…', 'work');
    var q = '/api/live/stream?ch=' + encodeURIComponent(cur.id) +
      (cur.skip.length ? '&skip=' + cur.skip.join(',') : '') + (NO_TS ? '&nots=1' : '') + (cur.bad.length ? '&bad=' + cur.bad.join(',') + (cur.badWhy ? '&why=' + cur.badWhy : '') : '');
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
      if (state.cur && state.cur.sid === sid && state.cur.needTap && els.video.paused) return; // o navegador exigiu um toque: espera, a fonte não é culpada
      if (state.cur && state.cur.sid === sid && !(els.video.currentTime > 0 && !els.video.paused)) failSource('não começou a tocar');
    }, START_TIMEOUT_MS);
  }

  /**
   * play() do Safari/iOS é recusado com som quando vem depois de uma resposta de rede (perde o gesto do toque), e no modo de economia
   * de bateria até mudo. Tenta com som; se recusar, toca mudo com um botão para ligar o som; se ainda recusar, mostra "Toque para assistir".
   */
  function startPlayback() {
    var v = els.video, cur = state.cur;
    function needTap() { if (state.cur === cur) { cur.needTap = true; els.tap.hidden = false; } }
    var p = null;
    try { p = v.play(); } catch (e) { p = null; }
    if (!p || !p.catch) return;
    p.catch(function () {
      if (state.cur !== cur) return;
      v.muted = true;
      var q = null;
      try { q = v.play(); } catch (e) { q = null; }
      if (q && q.then) q.then(function () { if (state.cur === cur) els.unmute.hidden = false; }).catch(needTap); else needTap();
    });
  }

  /** HLS pelo próprio navegador (Safari/iOS): sem MSE, sem hls.js; o iOS também ignora CORS aqui. */
  function attachNative(url) {
    var video = els.video, sid = state.cur.sid;
    nlog('player', 'HLS nativo do navegador');
    video.preload = 'auto';
    video.onerror = function () {
      var c = state.cur;
      if (!c || c.sid !== sid) return;
      var code = video.error && video.error.code;
      failSource('erro do player nativo' + (code ? ' (' + code + ')' : ''), c.mode === 'direct' && !c.played ? 'direct' : '');
    };
    video.src = url;
    // O HLS nativo não informa bytes: a banda da Vercel/nó é estimada pelo tempo assistido (mesma contagem das outras).
    try { if (window.FdsUsage && window.FdsUsage.native) window.FdsUsage.native(video, url, function () { return Boolean(state.cur && state.cur.sid === sid); }); } catch (e) { /* estatística nunca derruba a TV */ }
    startPlayback();
  }

  function attach(url) {
    var video = els.video;
    var nativeOk = !!video.canPlayType('application/vnd.apple.mpegurl');
    if (IS_IOS && nativeOk) { attachNative(url); return; } // iPhone: o HLS nativo é o caminho confiável
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
      hls.on(Hls.Events.MANIFEST_PARSED, startPlayback);
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
    } else if (nativeOk) {
      attachNative(url);
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
      if (started && started.catch) started.catch(function () { var c = state.cur; if (c) { c.needTap = true; els.tap.hidden = false; } });
    });
  }

  function onPlaying() {
    if (state.cur && !state.cur.played) { state.cur.played = true; nlog('tocando', state.cur.name + ' fonte ' + state.cur.sid + ' · ' + els.video.videoWidth + 'x' + els.video.videoHeight); }
    els.tap.hidden = true;
    if (state.cur) state.cur.needTap = false;
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
    state.epgTries = 0;
    loadEpg();
    clearInterval(state.epgTimer);
    state.epgTimer = setInterval(function () { if (state.open) loadEpg(); }, 60000);
    clearInterval(state.paintTimer);
    state.paintTimer = setInterval(function () { if (state.open) paintEpg(); }, 20000);
    refresh().then(schedulePoll);
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    clearTimeout(state.poll);
    clearInterval(state.diagTimer);
    clearInterval(state.netTimer);
    clearInterval(state.epgTimer);
    clearInterval(state.paintTimer);
    clearTimeout(state.epgRetry);
    hideScan();
    stopMsgAnim();
    if (els.nerdAuto) els.nerdAuto.checked = false;
    stopPlayer();
    state.cur = null;
    state.seq += 1;
    els.modal.hidden = true;
    els.root.hidden = true;
    document.documentElement.classList.remove('ltv-open');
    document.documentElement.style.overflow = '';
    openBtn.setAttribute('aria-pressed', 'false');
    try { if (location.hash === '#tv') history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignora */ }
  }

  openBtn.addEventListener('click', function () { if (state.open) close(); else open(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !state.open || document.fullscreenElement) return;
    if (els.modal && !els.modal.hidden) closeModal(); else close();
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
