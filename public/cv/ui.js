/**
 * Interface do player canvas: controles, atalhos, tela cheia, menu de legendas e velocidade.
 * Tudo dentro do `.video-wrap`, para a tela cheia levar imagem + legendas + controles juntos.
 */

import { SubtitleOverlay } from './subs.js';

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>',
  volHi: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>',
  cc: '<svg viewBox="0 0 24 24"><path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/></svg>',
  fs: '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
  fsExit: '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>',
  replay: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>'
};

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SUB_SIZES = [['Pequena', 0.8], ['Média', 1], ['Grande', 1.3], ['Enorme', 1.7]];
const LS_VOL = 'fdsflix.cvp.volume';
const LS_MUTE = 'fdsflix.cvp.muted';
const LS_SUBSIZE = 'fdsflix.cvp.subsize';

const CSS = `
.video-wrap.cvp-on{aspect-ratio:16/9;user-select:none;-webkit-user-select:none}
.video-wrap.cvp-on:fullscreen{aspect-ratio:auto;border-radius:0;width:100%;height:100%}
.video-wrap.cvp-on>video{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0}
.cvp{position:absolute;inset:0;z-index:1;background:#000;outline:none;font-family:inherit;color:#fff;overflow:hidden;touch-action:manipulation}
.cvp *{box-sizing:border-box}
.cvp-canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;background:#000}
.cvp.cvp-idle{cursor:none}
.cvp-subs{position:absolute;left:4%;right:4%;bottom:6%;display:flex;flex-direction:column;align-items:center;gap:.15em;pointer-events:none;
  font-size:calc(var(--cvp-h,540px) * .043 * var(--cvp-sub-scale,1));line-height:1.28;transition:bottom .18s ease;z-index:2}
.cvp:not(.cvp-idle) .cvp-subs{bottom:calc(6% + var(--cvp-bar,70px))}
.cvp-cue{max-width:92%;text-align:center;white-space:pre-line;font-weight:600}
.cvp-cue span{display:inline;background:rgba(0,0,0,.55);padding:.04em .32em;border-radius:.2em;box-decoration-break:clone;-webkit-box-decoration-break:clone;
  text-shadow:0 0 .12em #000,0 .04em .12em #000}
.cvp-cue i{font-style:italic}
.cvp-bar{position:absolute;left:0;right:0;bottom:0;padding:2.4rem .9rem .55rem;z-index:3;
  background:linear-gradient(to top,rgba(0,0,0,.82),rgba(0,0,0,.55) 55%,transparent);transition:opacity .2s ease,transform .2s ease}
.cvp.cvp-idle .cvp-bar{opacity:0;transform:translateY(8px);pointer-events:none}
.cvp-seek{position:relative;height:18px;margin:0 .15rem .15rem;cursor:pointer;touch-action:none}
.cvp-track{position:absolute;left:0;right:0;top:50%;height:4px;margin-top:-2px;background:rgba(255,255,255,.25);border-radius:2px;transition:height .12s,margin-top .12s}
.cvp-seek:hover .cvp-track,.cvp-seek.cvp-drag .cvp-track{height:6px;margin-top:-3px}
.cvp-buf,.cvp-played{position:absolute;left:0;top:0;bottom:0;border-radius:2px}
.cvp-buf{background:rgba(255,255,255,.35)}
.cvp-played{background:var(--brand,#e50914)}
.cvp-thumb{position:absolute;top:50%;width:13px;height:13px;margin:-6.5px 0 0 -6.5px;border-radius:50%;background:var(--brand,#e50914);transform:scale(0);transition:transform .12s;box-shadow:0 0 4px rgba(0,0,0,.6)}
.cvp-seek:hover .cvp-thumb,.cvp-seek.cvp-drag .cvp-thumb{transform:scale(1)}
.cvp-tip{position:absolute;bottom:20px;transform:translateX(-50%);background:rgba(0,0,0,.85);padding:.15rem .45rem;border-radius:4px;font-size:.75rem;white-space:nowrap;pointer-events:none;opacity:0}
.cvp-seek:hover .cvp-tip,.cvp-seek.cvp-drag .cvp-tip{opacity:1}
.cvp-row{display:flex;align-items:center;gap:.15rem}
.cvp-btn{background:none;border:0;color:#fff;width:38px;height:38px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;position:relative;font:600 .82rem inherit}
.cvp-btn:hover,.cvp-btn:focus-visible{background:rgba(255,255,255,.16)}
.cvp-btn svg{width:26px;height:26px;fill:currentColor}
.cvp-btn.cvp-on-state{color:var(--brand,#e50914)}
.cvp-vol{display:flex;align-items:center}
.cvp-vol input{width:0;opacity:0;transition:width .18s,opacity .18s;accent-color:var(--brand,#e50914);height:4px;margin:0;cursor:pointer}
.cvp-vol:hover input,.cvp-vol:focus-within input{width:84px;opacity:1;margin:0 .45rem 0 .1rem}
.cvp-time{font-size:.82rem;font-variant-numeric:tabular-nums;margin:0 .6rem;white-space:nowrap;opacity:.95}
.cvp-sp{flex:1}
.cvp-chip{font-size:.7rem;opacity:.75;margin-right:.5rem;white-space:nowrap}
.cvp-menu{position:absolute;right:.9rem;bottom:calc(var(--cvp-bar,76px) + .3rem);min-width:220px;max-width:min(340px,90%);background:rgba(18,18,26,.96);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:.4rem;
  box-shadow:0 8px 28px rgba(0,0,0,.55);z-index:4;font-size:.85rem;max-height:calc(100% - var(--cvp-bar,76px) - 1.4rem);overflow:auto}
.cvp-menu{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.28) transparent}
.cvp-menu::-webkit-scrollbar{width:8px}.cvp-menu::-webkit-scrollbar-thumb{background:rgba(255,255,255,.28);border-radius:4px}
.cvp-menu[hidden]{display:none}
.cvp-menu h4{margin:.35rem .5rem .25rem;font-size:.7rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.6}
.cvp-menu button.cvp-item{display:flex;width:100%;align-items:center;gap:.5rem;text-align:left;background:none;border:0;color:#fff;padding:.5rem .6rem;border-radius:6px;cursor:pointer;font:inherit}
.cvp-menu button.cvp-item:hover,.cvp-menu button.cvp-item:focus-visible{background:rgba(255,255,255,.13)}
.cvp-menu button.cvp-item.cvp-sel::before{content:"✓";color:var(--brand,#e50914);width:1em}
.cvp-menu button.cvp-item:not(.cvp-sel)::before{content:"";width:1em}
.cvp-syncrow{display:flex;align-items:center;gap:.3rem;padding:.2rem .5rem .45rem}
.cvp-syncrow button{white-space:nowrap;background:rgba(255,255,255,.12);border:0;color:#fff;border-radius:6px;padding:.35rem .55rem;cursor:pointer;font:inherit}
.cvp-syncrow button:hover{background:rgba(255,255,255,.22)}
.cvp-syncrow output{flex:1;min-width:3.4rem;white-space:nowrap;text-align:center;font-variant-numeric:tabular-nums}
.cvp-center{position:absolute;left:50%;top:50%;width:84px;height:84px;margin:-42px 0 0 -42px;border-radius:50%;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;
  pointer-events:none;opacity:0;transform:scale(.8);z-index:3}
.cvp-center svg{width:46px;height:46px;fill:#fff}
.cvp-center.cvp-pop{animation:cvp-pop .5s ease-out}
@keyframes cvp-pop{0%{opacity:.95;transform:scale(.8)}100%{opacity:0;transform:scale(1.25)}}
.cvp-bigplay{position:absolute;left:50%;top:50%;width:92px;height:92px;margin:-46px 0 0 -46px;border-radius:50%;background:rgba(0,0,0,.6);border:2px solid rgba(255,255,255,.85);
  display:none;align-items:center;justify-content:center;cursor:pointer;z-index:3;padding:0}
.cvp-bigplay svg{width:52px;height:52px;fill:#fff}
.cvp.cvp-paused:not(.cvp-wait) .cvp-bigplay{display:flex}
.cvp-spin{position:absolute;left:50%;top:50%;width:54px;height:54px;margin:-27px 0 0 -27px;border:4px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;
  animation:cvp-rot .9s linear infinite;display:none;z-index:3;pointer-events:none}
.cvp.cvp-wait.cvp-paused .cvp-spin{display:block}
@keyframes cvp-rot{to{transform:rotate(360deg)}}
.cvp-toast{position:absolute;top:1rem;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.72);padding:.4rem .85rem;border-radius:8px;font-size:.85rem;z-index:5;pointer-events:none;opacity:0;transition:opacity .2s}
.cvp-toast.cvp-show{opacity:1}
@media (max-width:560px){.cvp-btn{width:34px;height:34px}.cvp-btn svg{width:23px;height:23px}.cvp-time{margin:0 .3rem;font-size:.74rem}.cvp-chip{display:none}}
@media (prefers-reduced-motion:reduce){.cvp-center.cvp-pop{animation:none}.cvp-bar,.cvp-subs{transition:none}}
`;

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* ignore */ } }

/**
 * @param {HTMLElement} wrap  o .video-wrap
 * @param {HTMLVideoElement} video
 * @param {{
 *   label?: string,
 *   subs?: { items: () => string[], active: () => number, select: (i: number) => void, offset: () => number, setOffset: (v: number) => void }
 * }} opts
 */
export function createUI(wrap, video, opts = {}) {
  if (!document.getElementById('cvp-style')) {
    const st = document.createElement('style');
    st.id = 'cvp-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const hadControls = video.hasAttribute('controls');
  video.removeAttribute('controls');
  wrap.classList.add('cvp-on');

  const root = el('div', 'cvp cvp-paused');
  root.tabIndex = 0;
  root.setAttribute('role', 'application');
  root.setAttribute('aria-label', 'Player de vídeo');
  const canvas = el('canvas', 'cvp-canvas');
  root.appendChild(canvas);
  const subs = new SubtitleOverlay(root, video);
  const center = el('div', 'cvp-center');
  const bigPlay = el('button', 'cvp-bigplay', ICON.play);
  bigPlay.type = 'button';
  bigPlay.setAttribute('aria-label', 'Reproduzir');
  const spin = el('div', 'cvp-spin');
  const toastEl = el('div', 'cvp-toast');
  root.append(center, bigPlay, spin, toastEl);

  const bar = el('div', 'cvp-bar');
  const seek = el('div', 'cvp-seek');
  seek.setAttribute('role', 'slider');
  seek.setAttribute('aria-label', 'Posição do vídeo');
  const track = el('div', 'cvp-track');
  const bufEl = el('div', 'cvp-buf');
  const playedEl = el('div', 'cvp-played');
  const thumb = el('div', 'cvp-thumb');
  const tip = el('div', 'cvp-tip', '0:00');
  track.append(bufEl, playedEl);
  seek.append(track, thumb, tip);

  const row = el('div', 'cvp-row');
  const btnPlay = el('button', 'cvp-btn', ICON.play);
  btnPlay.type = 'button';
  btnPlay.setAttribute('aria-label', 'Reproduzir/Pausar (espaço)');
  const volBox = el('div', 'cvp-vol');
  const btnMute = el('button', 'cvp-btn', ICON.volHi);
  btnMute.type = 'button';
  btnMute.setAttribute('aria-label', 'Silenciar (M)');
  const vol = el('input');
  vol.type = 'range'; vol.min = '0'; vol.max = '1'; vol.step = '0.02';
  vol.setAttribute('aria-label', 'Volume');
  volBox.append(btnMute, vol);
  const timeEl = el('span', 'cvp-time', '0:00 / 0:00');
  const sp = el('span', 'cvp-sp');
  const chip = el('span', 'cvp-chip', opts.label || '');
  const btnCC = el('button', 'cvp-btn', ICON.cc);
  btnCC.type = 'button';
  btnCC.setAttribute('aria-label', 'Legendas (C)');
  const btnRate = el('button', 'cvp-btn', '1×');
  btnRate.type = 'button';
  btnRate.setAttribute('aria-label', 'Velocidade');
  const btnFs = el('button', 'cvp-btn', ICON.fs);
  btnFs.type = 'button';
  btnFs.setAttribute('aria-label', 'Tela cheia (F)');
  row.append(btnPlay, volBox, timeEl, sp, chip, btnCC, btnRate, btnFs);

  const menuCC = el('div', 'cvp-menu');
  menuCC.hidden = true;
  const menuRate = el('div', 'cvp-menu');
  menuRate.hidden = true;
  bar.append(seek, row);
  root.append(menuCC, menuRate, bar);
  wrap.insertBefore(root, wrap.firstChild);

  let engine = null;
  let alive = true;
  let dragging = false;
  let dragT = 0;
  let idleTimer = null;
  let toastTimer = null;
  let lastTap = { t: 0, x: 0 };
  let clickTimer = null;
  const stopFns = [];
  const on = (target, type, fn, o) => { target.addEventListener(type, fn, o); stopFns.push(() => target.removeEventListener(type, fn, o)); };

  const duration = () => (engine ? engine.duration : (isFinite(video.duration) ? video.duration : 0));
  const playing = () => (engine ? engine.intent : !video.paused);

  /* ---------- estado visual ---------- */
  function syncState() {
    const p = playing();
    root.classList.toggle('cvp-paused', !p);
    root.classList.toggle('cvp-wait', Boolean(engine && engine.buffering));
    btnPlay.innerHTML = video.ended ? ICON.replay : (p ? ICON.pause : ICON.play);
    btnPlay.setAttribute('aria-label', p ? 'Pausar (espaço)' : 'Reproduzir (espaço)');
    const muted = video.muted || video.volume === 0;
    btnMute.innerHTML = muted ? ICON.mute : (video.volume < 0.5 ? ICON.vol : ICON.volHi);
    vol.value = video.muted ? '0' : String(video.volume);
    btnRate.textContent = (video.playbackRate === 1 ? '1' : String(video.playbackRate)) + '×';
    btnFs.innerHTML = document.fullscreenElement === wrap ? ICON.fsExit : ICON.fs;
    btnCC.classList.toggle('cvp-on-state', activeSub() >= 0);
    scheduleIdle();
  }

  function updateTime() {
    if (!alive) return;
    const d = duration();
    const t = dragging ? dragT : video.currentTime;
    const pct = d ? Math.max(0, Math.min(1, t / d)) : 0;
    playedEl.style.width = pct * 100 + '%';
    thumb.style.left = pct * 100 + '%';
    timeEl.textContent = `${fmt(t)} / ${fmt(d)}`;
    seek.setAttribute('aria-valuenow', String(Math.round(t)));
    seek.setAttribute('aria-valuemax', String(Math.round(d)));
    // buffer: a faixa que contém o instante atual (o áudio guarda a ponta; a imagem acompanha)
    let end = 0;
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.3 && b.end(i) >= end) end = b.end(i);
    bufEl.style.width = d ? Math.min(100, (end / d) * 100) + '%' : '0%';
  }

  function fitSize() {
    const r = root.getBoundingClientRect();
    root.style.setProperty('--cvp-h', Math.max(160, r.height) + 'px');
    root.style.setProperty('--cvp-bar', Math.round(bar.getBoundingClientRect().height) + 'px');
  }

  /* ---------- ações ---------- */
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('cvp-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('cvp-show'), 1400);
  }

  function pop(icon) {
    center.innerHTML = icon;
    center.classList.remove('cvp-pop');
    void center.offsetWidth;
    center.classList.add('cvp-pop');
  }

  function togglePlay() {
    if (playing() && !video.ended) { video.pause(); pop(ICON.pause); } else { video.play(); pop(ICON.play); }
    syncState();
  }

  function seekTo(t, label) {
    const d = duration();
    if (!d) return;
    const to = Math.max(0, Math.min(d - 0.05, t));
    video.currentTime = to;
    if (label) toast(label);
    updateTime();
  }

  function setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    video.volume = v;
    video.muted = v === 0;
    lsSet(LS_VOL, v);
    lsSet(LS_MUTE, video.muted ? '1' : '0');
    toast('Volume ' + Math.round(v * 100) + '%');
    syncState();
  }

  function toggleMute() {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.5;
    lsSet(LS_MUTE, video.muted ? '1' : '0');
    syncState();
  }

  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      const f = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
      if (f) f.call(wrap);
    } catch (e) { /* ignore */ }
  }

  function setRate(r) {
    video.playbackRate = r;
    video.defaultPlaybackRate = r;
    toast('Velocidade ' + r + '×');
    syncState();
  }

  const subApi = () => opts.subs || null;
  const activeSub = () => (subApi() ? subApi().active() : -1);

  function closeMenus() { menuCC.hidden = true; menuRate.hidden = true; }

  function buildCC() {
    const api = subApi();
    menuCC.textContent = '';
    if (!api) { menuCC.appendChild(el('h4', '', 'Sem legendas')); return; }
    const items = api.items();
    const active = api.active();
    menuCC.appendChild(el('h4', '', 'Legendas'));
    const mk = (label, i) => {
      const b = el('button', 'cvp-item' + (i === active ? ' cvp-sel' : ''));
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => { api.select(i); toast(i < 0 ? 'Legenda desligada' : label); closeMenus(); syncState(); });
      menuCC.appendChild(b);
    };
    mk('Desligada', -1);
    items.forEach((label, i) => mk(label, i));
    menuCC.appendChild(el('h4', '', 'Sincronia'));
    const rowS = el('div', 'cvp-syncrow');
    const minus = el('button', '', '−0,5 s');
    const out = el('output', '');
    const plus = el('button', '', '+0,5 s');
    const zero = el('button', '', '0');
    for (const b of [minus, plus, zero]) b.type = 'button';
    const show = () => { const o = api.offset(); out.textContent = (o > 0 ? '+' : '') + String(o).replace('.', ',') + ' s'; };
    minus.addEventListener('click', () => { api.setOffset(api.offset() - 0.5); show(); });
    plus.addEventListener('click', () => { api.setOffset(api.offset() + 0.5); show(); });
    zero.addEventListener('click', () => { api.setOffset(0); show(); });
    show();
    rowS.append(minus, out, plus, zero);
    menuCC.appendChild(rowS);
    menuCC.appendChild(el('h4', '', 'Tamanho'));
    const cur = Number(lsGet(LS_SUBSIZE, '1'));
    SUB_SIZES.forEach(([name, scale]) => {
      const b = el('button', 'cvp-item' + (scale === cur ? ' cvp-sel' : ''));
      b.type = 'button';
      b.textContent = name;
      b.addEventListener('click', () => { lsSet(LS_SUBSIZE, scale); subs.setScale(scale); closeMenus(); });
      menuCC.appendChild(b);
    });
  }

  function buildRate() {
    menuRate.textContent = '';
    menuRate.appendChild(el('h4', '', 'Velocidade'));
    RATES.forEach((r) => {
      const b = el('button', 'cvp-item' + (r === video.playbackRate ? ' cvp-sel' : ''));
      b.type = 'button';
      b.textContent = r === 1 ? 'Normal' : r + '×';
      b.addEventListener('click', () => { setRate(r); closeMenus(); });
      menuRate.appendChild(b);
    });
  }

  function toggleMenu(which) {
    const menu = which === 'cc' ? menuCC : menuRate;
    const other = which === 'cc' ? menuRate : menuCC;
    other.hidden = true;
    if (menu.hidden) { if (which === 'cc') buildCC(); else buildRate(); menu.hidden = false; } else menu.hidden = true;
    scheduleIdle();
  }

  function cycleSub() {
    const api = subApi();
    if (!api) return;
    const n = api.items().length;
    if (!n) { toast('Este título não tem legendas'); return; }
    const next = api.active() + 1 >= n ? -1 : api.active() + 1;
    api.select(next);
    toast(next < 0 ? 'Legenda desligada' : api.items()[next]);
    syncState();
  }

  /* ---------- controles somem sozinhos ---------- */
  function showControls() {
    root.classList.remove('cvp-idle');
    scheduleIdle();
  }
  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!playing() || dragging || !menuCC.hidden || !menuRate.hidden) return;
    idleTimer = setTimeout(() => { root.classList.add('cvp-idle'); }, 2800);
  }

  /* ---------- eventos ---------- */
  on(btnPlay, 'click', togglePlay);
  on(bigPlay, 'click', (e) => { e.stopPropagation(); video.play(); syncState(); });
  on(btnMute, 'click', toggleMute);
  on(vol, 'input', () => { const v = Number(vol.value); video.muted = v === 0; video.volume = v; lsSet(LS_VOL, v); lsSet(LS_MUTE, video.muted ? '1' : '0'); syncState(); });
  on(btnCC, 'click', () => toggleMenu('cc'));
  on(btnRate, 'click', () => toggleMenu('rate'));
  on(btnFs, 'click', toggleFullscreen);
  on(document, 'fullscreenchange', () => { syncState(); setTimeout(fitSize, 60); });
  on(video, 'volumechange', syncState);
  on(video, 'ratechange', syncState);
  on(video, 'play', syncState);
  on(video, 'pause', syncState);
  on(video, 'ended', syncState);
  on(video, 'loadedmetadata', updateTime);
  on(video, 'durationchange', updateTime);
  on(video, 'seeked', updateTime);

  // clique no vídeo: 1 toque = tocar/pausar (com atraso p/ distinguir o duplo clique = tela cheia)
  on(root, 'click', (e) => {
    if (e.target.closest('.cvp-bar') || e.target.closest('.cvp-bigplay')) return;
    if (!menuCC.hidden || !menuRate.hidden) { closeMenus(); return; }
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { togglePlay(); }, 230);
  });
  on(root, 'dblclick', (e) => {
    if (e.target.closest('.cvp-bar')) return;
    clearTimeout(clickTimer);
    toggleFullscreen();
  });
  // toque: duplo toque nas laterais pula 10 s
  on(root, 'pointerup', (e) => {
    if (e.pointerType !== 'touch' || e.target.closest('.cvp-bar')) return;
    const now = performance.now();
    const r = root.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (now - lastTap.t < 320 && (x < 0.33 || x > 0.67)) {
      clearTimeout(clickTimer);
      seekTo(video.currentTime + (x < 0.5 ? -10 : 10), x < 0.5 ? '−10 s' : '+10 s');
      lastTap.t = 0;
      return;
    }
    lastTap = { t: now, x };
    if (root.classList.contains('cvp-idle')) { e.preventDefault(); clearTimeout(clickTimer); showControls(); }
  });
  on(root, 'pointermove', () => showControls());
  on(root, 'pointerleave', () => { if (playing()) scheduleIdle(); });

  // barra de progresso (arrastar, clicar, passar o mouse)
  const timeAt = (clientX) => {
    const r = seek.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration();
  };
  on(seek, 'pointermove', (e) => {
    const r = seek.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    tip.style.left = x + 'px';
    tip.textContent = fmt(timeAt(e.clientX));
    if (dragging) { dragT = timeAt(e.clientX); updateTime(); }
  });
  on(seek, 'pointerdown', (e) => {
    e.stopPropagation();
    dragging = true;
    dragT = timeAt(e.clientX);
    seek.classList.add('cvp-drag');
    try { seek.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    updateTime();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    seek.classList.remove('cvp-drag');
    seekTo(timeAt(e.clientX));
    scheduleIdle();
  };
  on(seek, 'pointerup', endDrag);
  on(seek, 'pointercancel', () => { dragging = false; seek.classList.remove('cvp-drag'); });
  on(seek, 'click', (e) => e.stopPropagation());

  // atalhos
  on(document, 'keydown', (e) => {
    if (!alive || e.ctrlKey || e.metaKey || e.altKey) return;
    const tg = e.target;
    const tag = tg && tg.tagName;
    if (tag === 'INPUT' && tg !== vol && tg.type !== 'range') return;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || (tg && tg.isContentEditable)) return;
    const k = e.key;
    const own = root.contains(tg);
    if ((k === ' ' || k === 'Enter') && (tag === 'BUTTON' || tag === 'A') ) return;
    let handled = true;
    switch (k) {
      case ' ': case 'k': case 'K': togglePlay(); break;
      case 'ArrowLeft': seekTo(video.currentTime - 5, '−5 s'); break;
      case 'ArrowRight': seekTo(video.currentTime + 5, '+5 s'); break;
      case 'j': case 'J': seekTo(video.currentTime - 10, '−10 s'); break;
      case 'l': case 'L': seekTo(video.currentTime + 10, '+10 s'); break;
      case 'ArrowUp': if (own || document.fullscreenElement === wrap) setVolume(video.volume + 0.05); else handled = false; break;
      case 'ArrowDown': if (own || document.fullscreenElement === wrap) setVolume(video.volume - 0.05); else handled = false; break;
      case 'm': case 'M': toggleMute(); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'c': case 'C': cycleSub(); break;
      case '0': case 'Home': seekTo(0); break;
      case 'End': seekTo(duration() - 1); break;
      case 'Escape': if (!menuCC.hidden || !menuRate.hidden) closeMenus(); else handled = false; break;
      default:
        handled = false;
        if (/^[1-9]$/.test(k)) { seekTo(duration() * (Number(k) / 10)); handled = true; }
    }
    if (handled) { e.preventDefault(); showControls(); }
  });

  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(fitSize); ro.observe(root); }
  on(window, 'resize', fitSize);

  // volume salvo
  try {
    const v = Number(lsGet(LS_VOL, '1'));
    video.volume = isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    video.muted = lsGet(LS_MUTE, '0') === '1';
  } catch (e) { /* ignore */ }
  subs.setScale(Number(lsGet(LS_SUBSIZE, '1')) || 1);
  fitSize();
  syncState();
  updateTime();

  const timer = setInterval(() => { updateTime(); }, 250);
  const subTimer = setInterval(() => { if (alive) subs.update(video.currentTime); }, 80);

  return {
    root,
    canvas,
    subs,
    toast,
    setLabel(text) { chip.textContent = text; },
    bind(e) { engine = e; syncState(); updateTime(); },
    refresh: syncState,
    setSubOffset(v) { subs.setOffset(v); },
    destroy() {
      if (!alive) return;
      alive = false;
      clearInterval(timer);
      clearInterval(subTimer);
      clearTimeout(idleTimer);
      clearTimeout(toastTimer);
      clearTimeout(clickTimer);
      if (ro) ro.disconnect();
      for (const f of stopFns) f();
      if (document.fullscreenElement === wrap) { try { document.exitFullscreen(); } catch (e) { /* ignore */ } }
      subs.dispose();
      root.remove();
      wrap.classList.remove('cvp-on');
      if (hadControls) video.setAttribute('controls', '');
    }
  };
}
