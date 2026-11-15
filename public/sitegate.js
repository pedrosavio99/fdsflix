/*
 * fdsFlix · portão do site. Pergunta à API se o site está "em manutenção" ou "mudou de URL" e, se estiver, cobre a
 * página com uma tela animada. O administrador (senha guardada neste navegador) nunca é bloqueado: vê o site normal
 * e só um selinho avisando o que os visitantes estão vendo. Tudo é texto (textContent), nada de HTML vindo da API.
 *
 *   window.FdsSiteGate.preview('maintenance' | 'moved', { message, url })   prévia para o admin (botão "Fechar prévia")
 *   window.FdsSiteGate.refresh()                                            consulta de novo agora
 */
(function () {
  'use strict';

  var CONFIG = window.__FDSFLIX_CONFIG__ || {};
  var API_BASE = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  var POLL_MS = 45000;
  var REDIRECT_S = 10;
  var PHRASES = [
    'Trocando as pilhas do controle remoto…',
    'Estourando uma pipoca nova…',
    'Dando banho no servidor…',
    'Apertando uns parafusos aqui…',
    'Servindo café para o ffmpeg…',
    'Ensinando o hamster da roda a correr mais rápido…',
    'Procurando a outra meia do cabo HDMI…',
    'Passando pano nos frames…'
  ];

  var NS = 'http://www.w3.org/2000/svg';
  var gate = null;       // elemento da tela
  var mode = '';         // '' | 'maintenance' | 'moved'
  var previewing = false;
  var phraseTimer = 0;
  var countdownTimer = 0;
  var pollTimer = 0;
  var inerted = [];
  var lastData = null;

  function isAdmin() { try { return Boolean(localStorage.getItem('fdsflix.adminKey')); } catch (e) { return false; } }

  /* ------------------------------- visual ------------------------------- */

  var CSS = [
    '#siteGate{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:1.2rem;overflow:auto;',
    'background:radial-gradient(1200px 700px at 50% -10%,#2a1530 0%,#14101f 55%,#0a0a10 100%);color:#f2f3f8;',
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;animation:sgFade .5s ease both}',
    '@keyframes sgFade{from{opacity:0}to{opacity:1}}',
    '#siteGate .sg-card{width:min(520px,100%);text-align:center;padding:1.6rem 1.3rem 1.4rem;border-radius:22px;',
    'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);box-shadow:0 30px 80px rgba(0,0,0,.55);',
    'animation:sgPop .6s cubic-bezier(.2,1.2,.3,1) both}',
    '@keyframes sgPop{from{opacity:0;transform:translateY(18px) scale(.96)}to{opacity:1;transform:none}}',
    '#siteGate .sg-scene{width:min(260px,70vw);height:auto;display:block;margin:0 auto .4rem;overflow:visible}',
    '#siteGate h1{margin:.2rem 0 .4rem;font-size:clamp(1.35rem,5vw,1.8rem);line-height:1.15;letter-spacing:-.01em}',
    '#siteGate p{margin:.35rem 0;color:#c4c7d6;line-height:1.5;font-size:.98rem}',
    '#siteGate .sg-phrase{min-height:1.6em;color:#ffd27a;font-weight:600;font-size:.92rem;animation:sgPhrase 3.6s ease-in-out infinite}',
    '@keyframes sgPhrase{0%{opacity:0;transform:translateY(6px)}12%,82%{opacity:1;transform:none}100%{opacity:0;transform:translateY(-6px)}}',
    '#siteGate .sg-bar{position:relative;height:10px;border-radius:99px;margin:1rem auto .3rem;width:min(300px,86%);background:rgba(255,255,255,.1);overflow:hidden}',
    '#siteGate .sg-bar i{position:absolute;top:0;bottom:0;width:38%;border-radius:99px;',
    'background:repeating-linear-gradient(115deg,#ffb43a 0 10px,#ff7a2f 10px 20px);animation:sgBar 1.7s ease-in-out infinite alternate}',
    '@keyframes sgBar{from{left:-4%}to{left:66%}}',
    '#siteGate .sg-small{font-size:.8rem;color:#8c90a6}',
    '#siteGate .sg-url{display:block;margin:.8rem auto;padding:.7rem 1rem;border-radius:14px;background:rgba(0,0,0,.35);',
    'border:1px dashed rgba(255,255,255,.28);color:#fff;font-weight:800;font-size:1.02rem;word-break:break-all;text-decoration:none;',
    'animation:sgGlow 2.2s ease-in-out infinite}',
    '@keyframes sgGlow{0%,100%{box-shadow:0 0 0 0 rgba(255,122,47,0)}50%{box-shadow:0 0 22px 2px rgba(255,122,47,.45)}}',
    '#siteGate .sg-btn{display:inline-block;margin:.3rem .25rem 0;padding:.75rem 1.3rem;border:0;border-radius:999px;cursor:pointer;',
    'font:inherit;font-weight:800;font-size:.95rem;color:#fff;background:var(--brand,#e50914);text-decoration:none}',
    '#siteGate .sg-btn.ghost{background:transparent;border:1px solid rgba(255,255,255,.25);color:#e8e9f1}',
    '#siteGate .sg-btn:hover{filter:brightness(1.12)}',
    /* engrenagens, chave inglesa e pipoca */
    '#siteGate .sg-gear{transform-box:fill-box;transform-origin:center;animation:sgSpin 4s linear infinite}',
    '#siteGate .sg-gear.b{animation-direction:reverse;animation-duration:2.6s}',
    '@keyframes sgSpin{to{transform:rotate(360deg)}}',
    '#siteGate .sg-wrench{transform-box:fill-box;transform-origin:20% 80%;animation:sgWrench 1.3s ease-in-out infinite}',
    '@keyframes sgWrench{0%,100%{transform:rotate(-18deg)}50%{transform:rotate(22deg)}}',
    '#siteGate .sg-pop{transform-box:fill-box;transform-origin:center;opacity:0;animation:sgPopcorn 2.4s ease-out infinite}',
    '@keyframes sgPopcorn{0%{opacity:0;transform:translate(0,0) scale(.4)}12%{opacity:1}100%{opacity:0;transform:translate(var(--dx),-70px) rotate(var(--r)) scale(1)}}',
    '#siteGate .sg-bob{animation:sgBob 2.2s ease-in-out infinite}',
    '@keyframes sgBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}',
    /* mudança de casa */
    '#siteGate .sg-box{animation:sgMove 3.2s cubic-bezier(.5,0,.4,1) infinite}',
    '@keyframes sgMove{0%{transform:translate(0,0)}10%{transform:translate(0,-10px)}55%{transform:translate(118px,-26px)}70%{transform:translate(122px,0)}100%{transform:translate(122px,0);opacity:0}}',
    '#siteGate .sg-arrow{animation:sgArrow 1s ease-in-out infinite}',
    '@keyframes sgArrow{0%,100%{transform:translateX(0)}50%{transform:translateX(8px)}}',
    '#siteGate .sg-dot{animation:sgBlink 1.4s ease-in-out infinite}',
    '@keyframes sgBlink{0%,100%{opacity:.25}50%{opacity:1}}',
    /* selinho do admin */
    '#siteGateAdmin{position:fixed;left:12px;bottom:12px;z-index:2147482000;max-width:calc(100vw - 24px);padding:.5rem .8rem;border-radius:999px;',
    'background:#3a2d0a;color:#ffd27a;border:1px solid rgba(255,210,122,.4);font:600 .78rem/1.2 system-ui,sans-serif;cursor:pointer}',
    '@media (prefers-reduced-motion:reduce){#siteGate *,#siteGate{animation:none !important}#siteGate .sg-pop{opacity:0}}'
  ].join('');

  function svg(tag, attrs, kids) {
    var n = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  function html(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  function gearShape(cx, cy, r, color, cls) {
    // dentes = uma circunferência grossa tracejada; miolo e furo por cima
    var g = svg('g', { 'class': 'sg-gear ' + (cls || '') });
    g.appendChild(svg('circle', { cx: cx, cy: cy, r: r + 4, fill: 'none', stroke: color, 'stroke-width': 9,
      'stroke-dasharray': ((2 * Math.PI * (r + 4)) / 14 / 2).toFixed(2) + ' ' + ((2 * Math.PI * (r + 4)) / 14 / 2).toFixed(2) }));
    g.appendChild(svg('circle', { cx: cx, cy: cy, r: r, fill: color }));
    g.appendChild(svg('circle', { cx: cx, cy: cy, r: r * 0.38, fill: '#14101f' }));
    return g;
  }

  function maintenanceScene() {
    var s = svg('svg', { 'class': 'sg-scene', viewBox: '0 0 260 170', role: 'img', 'aria-label': 'Engrenagens girando e pipoca estourando' });
    // balde de pipoca
    var bucket = svg('g', { 'class': 'sg-bob' });
    bucket.appendChild(svg('path', { d: 'M92 84h76l-9 70a6 6 0 0 1-6 5H107a6 6 0 0 1-6-5z', fill: '#f2f3f8' }));
    [108, 124, 140, 156].forEach(function (x, i) {
      bucket.appendChild(svg('path', { d: 'M' + x + ' 86l-2 70', stroke: i % 2 ? '#e50914' : '#ffffff', 'stroke-width': 11, opacity: i % 2 ? 1 : 0, fill: 'none' }));
    });
    [100, 116, 132, 148].forEach(function (x) {
      bucket.appendChild(svg('path', { d: 'M' + x + ' 86l-3 70', stroke: '#e50914', 'stroke-width': 9, fill: 'none', opacity: 0.9 }));
    });
    [[104, 78], [120, 70], [136, 74], [152, 80], [128, 82], [112, 84]].forEach(function (p, i) {
      bucket.appendChild(svg('circle', { cx: p[0], cy: p[1], r: 10 - (i % 2), fill: i % 2 ? '#fff3c4' : '#ffe58a' }));
    });
    s.appendChild(bucket);
    // pipocas voando
    [[112, 74, -26, -40], [130, 66, 4, 25], [148, 74, 30, 70], [122, 70, -12, -90], [140, 70, 18, 120]].forEach(function (p, i) {
      var c = svg('circle', { 'class': 'sg-pop', cx: p[0], cy: p[1], r: 6, fill: '#fff3c4' });
      c.setAttribute('style', '--dx:' + p[2] + 'px;--r:' + p[3] + 'deg;animation-delay:' + (i * 0.45).toFixed(2) + 's');
      s.appendChild(c);
    });
    s.appendChild(gearShape(46, 58, 22, '#ff9b3d', 'a'));
    s.appendChild(gearShape(212, 52, 16, '#6aa0ff', 'b'));
    s.appendChild(gearShape(196, 118, 13, '#7ee2a8', 'a'));
    // chave inglesa balançando
    var w = svg('g', { 'class': 'sg-wrench' });
    w.appendChild(svg('rect', { x: 40, y: 104, width: 9, height: 46, rx: 4, fill: '#d9dbe6', transform: 'rotate(-30 44 127)' }));
    w.appendChild(svg('circle', { cx: 30, cy: 98, r: 11, fill: 'none', stroke: '#d9dbe6', 'stroke-width': 7, 'stroke-dasharray': '56 14' }));
    s.appendChild(w);
    return s;
  }

  function house(x, color, label) {
    var g = svg('g', {});
    g.appendChild(svg('path', { d: 'M' + (x - 30) + ' 90l30-30 30 30v44H' + (x - 30) + 'z', fill: color }));
    g.appendChild(svg('rect', { x: x - 7, y: 106, width: 14, height: 28, rx: 3, fill: '#14101f' }));
    g.appendChild(svg('text', { x: x, y: 154, 'text-anchor': 'middle', fill: '#9a9eb4', 'font-size': 11, 'font-family': 'system-ui,sans-serif' }, [document.createTextNode(label)]));
    return g;
  }

  function movedScene() {
    var s = svg('svg', { 'class': 'sg-scene', viewBox: '0 0 260 170', role: 'img', 'aria-label': 'Uma caixa se mudando da casa antiga para a nova' });
    s.appendChild(house(48, '#4a4d63', 'antiga'));
    s.appendChild(house(212, '#e50914', 'nova'));
    s.appendChild(svg('path', { d: 'M86 120H170', stroke: '#8c90a6', 'stroke-width': 2, 'stroke-dasharray': '4 6', fill: 'none' }));
    var arrow = svg('g', { 'class': 'sg-arrow' });
    arrow.appendChild(svg('path', { d: 'M104 62l12 8-12 8', fill: 'none', stroke: '#ffd27a', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    arrow.appendChild(svg('path', { d: 'M126 62l12 8-12 8', fill: 'none', stroke: '#ffd27a', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.6 }));
    s.appendChild(arrow);
    var box = svg('g', { 'class': 'sg-box' });
    box.appendChild(svg('rect', { x: 62, y: 100, width: 26, height: 22, rx: 3, fill: '#d99b52' }));
    box.appendChild(svg('path', { d: 'M62 108h26M75 100v8', stroke: '#9a6a2e', 'stroke-width': 2, fill: 'none' }));
    s.appendChild(box);
    [0, 1, 2].forEach(function (i) {
      var d = svg('circle', { 'class': 'sg-dot', cx: 112 + i * 18, cy: 146, r: 3, fill: '#ffd27a' });
      d.setAttribute('style', 'animation-delay:' + (i * 0.25) + 's');
      s.appendChild(d);
    });
    return s;
  }

  /* ------------------------------- montagem ------------------------------- */

  function ensureCss() {
    if (document.getElementById('siteGateCss')) return;
    var st = html('style', { id: 'siteGateCss' }, CSS);
    document.head.appendChild(st);
  }

  function lock(on) {
    if (on) {
      document.documentElement.style.overflow = 'hidden';
      Array.prototype.slice.call(document.body.children).forEach(function (n) {
        if (n === gate || n.tagName === 'SCRIPT' || n.id === 'siteGateAdmin' || n.inert) return;
        n.inert = true; inerted.push(n);
      });
      Array.prototype.slice.call(document.querySelectorAll('video,audio')).forEach(function (m) { try { m.pause(); } catch (e) { /* nada */ } });
    } else {
      document.documentElement.style.overflow = '';
      inerted.forEach(function (n) { n.inert = false; });
      inerted = [];
    }
  }

  function clearTimers() { clearInterval(phraseTimer); clearInterval(countdownTimer); phraseTimer = 0; countdownTimer = 0; }

  function hide() {
    clearTimers();
    if (gate) { lock(false); gate.remove(); gate = null; }
    mode = ''; previewing = false;
  }

  function safeUrl(u) {
    try { var p = new URL(String(u)); return /^https?:$/.test(p.protocol) && !p.username && !p.password ? p.href : ''; } catch (e) { return ''; }
  }

  function show(which, data, isPreview) {
    ensureCss();
    hide();
    mode = which; previewing = Boolean(isPreview);
    gate = html('div', { id: 'siteGate', role: 'alertdialog', 'aria-live': 'polite', 'aria-label': which === 'moved' ? 'Mudamos de endereço' : 'Site em manutenção' });
    var card = html('div', { 'class': 'sg-card' });
    gate.appendChild(card);

    if (which === 'maintenance') {
      card.appendChild(maintenanceScene());
      card.appendChild(html('h1', {}, 'Sentimos muito, estamos em manutenção'));
      card.appendChild(html('p', {}, (data && data.message) || 'Estamos dando uma geral por aqui. Voltamos em breve!'));
      var phrase = html('p', { 'class': 'sg-phrase', 'aria-hidden': 'true' }, PHRASES[0]);
      card.appendChild(phrase);
      var bar = html('div', { 'class': 'sg-bar', 'aria-hidden': 'true' });
      bar.appendChild(html('i', {}));
      card.appendChild(bar);
      card.appendChild(html('p', { 'class': 'sg-small' }, 'Esta tela some sozinha quando voltarmos. Pode deixar a aba aberta.'));
      var idx = 0;
      phraseTimer = setInterval(function () { idx = (idx + 1) % PHRASES.length; phrase.textContent = PHRASES[idx]; }, 3600);
    } else {
      var url = safeUrl(data && data.url);
      card.appendChild(movedScene());
      card.appendChild(html('h1', {}, 'Mudamos de endereço!'));
      card.appendChild(html('p', {}, 'O fdsFlix agora mora em outro lugar. Atualize seus favoritos:'));
      var link = html('a', { 'class': 'sg-url', rel: 'noopener noreferrer' }, url.replace(/\/$/, ''));
      if (url) link.setAttribute('href', url);
      card.appendChild(link);
      var go = html('a', { 'class': 'sg-btn', rel: 'noopener noreferrer' }, 'Ir para o novo endereço');
      if (url) go.setAttribute('href', url);
      card.appendChild(go);
      var info = html('p', { 'class': 'sg-small' }, '');
      var cancel = html('button', { 'class': 'sg-btn ghost', type: 'button' }, 'Ficar aqui');
      if (url && !isPreview) {
        var left = REDIRECT_S;
        info.textContent = 'Levando você para lá em ' + left + ' s…';
        countdownTimer = setInterval(function () {
          left -= 1;
          if (left <= 0) { clearTimers(); location.assign(url); return; }
          info.textContent = 'Levando você para lá em ' + left + ' s…';
        }, 1000);
        cancel.addEventListener('click', function () { clearTimers(); info.textContent = 'Tudo bem! O botão acima leva para o endereço novo quando quiser.'; cancel.remove(); });
        card.appendChild(cancel);
      }
      card.appendChild(info);
    }

    if (isPreview) {
      var close = html('button', { 'class': 'sg-btn ghost', type: 'button' }, 'Fechar prévia');
      close.addEventListener('click', function () { hide(); apply(lastData); });
      card.appendChild(html('p', { 'class': 'sg-small' }, 'Prévia do administrador: os visitantes não estão vendo isto agora.'));
      card.appendChild(close);
    }
    document.body.appendChild(gate);
    lock(true);
  }

  /* ------------------------------- estado ------------------------------- */

  function adminBadge(text) {
    var b = document.getElementById('siteGateAdmin');
    if (!text) { if (b) b.remove(); return; }
    ensureCss();
    if (!b) {
      b = html('button', { id: 'siteGateAdmin', type: 'button', title: 'Abrir a tela Site' });
      b.addEventListener('click', function () { var o = document.getElementById('siteOpen'); if (o) o.click(); });
      document.body.appendChild(b);
    }
    b.textContent = text;
  }

  function apply(data) {
    lastData = data;
    if (previewing) return;
    var maint = data && data.maintenance && data.maintenance.on;
    var movedUrl = data && data.moved && data.moved.on ? safeUrl(data.moved.url) : '';
    try { if (movedUrl && new URL(movedUrl).host === location.host) movedUrl = ''; } catch (e) { movedUrl = ''; } // já estou lá
    var want = movedUrl ? 'moved' : (maint ? 'maintenance' : '');

    if (isAdmin()) {
      hide();
      adminBadge(want === 'moved' ? '↪ Aviso de nova URL LIGADO · visitantes são levados para o endereço novo'
        : (want === 'maintenance' ? '🛠 Manutenção LIGADA · visitantes veem a tela de aviso (você não)' : ''));
      return;
    }
    adminBadge('');
    if (!want) { if (mode) hide(); return; }
    if (mode === want && gate) {
      if (want === 'maintenance') { var p = gate.querySelector('.sg-card > p'); if (p && data.maintenance.message && p.textContent !== data.maintenance.message) p.textContent = data.maintenance.message; }
      return;
    }
    show(want, want === 'moved' ? { url: movedUrl } : data.maintenance, false);
  }

  function refresh() {
    var headers = {};
    if (CONFIG.apiKey) headers['x-api-key'] = CONFIG.apiKey;
    return fetch(API_BASE + '/api/site/status', { headers: headers, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) apply(d); return d; })
      .catch(function () { /* sem resposta: o site em si também não responderia; não faz nada */ return null; });
  }

  function start() {
    refresh();
    clearInterval(pollTimer);
    pollTimer = setInterval(function () { if (!document.hidden) refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  }

  window.FdsSiteGate = {
    refresh: refresh,
    preview: function (which, data) { show(which === 'moved' ? 'moved' : 'maintenance', data || {}, true); }
  };

  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
