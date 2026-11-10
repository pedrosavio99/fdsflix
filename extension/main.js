(() => {
  'use strict';

  const STRICT_HOSTS = [
    'fdsflix-80ya.onrender.com',
    'fdsflix.onrender.com',
    'localhost',
    'vidlink.pro',
    'vidsrc.net',
    'vidsrc.cc',
    'vidfast.pro',
    '2embed.cc',
    'autoembed.co',
    'embed.su'
  ];

  const host = location.hostname.toLowerCase();
  const active = STRICT_HOSTS.some((item) => host === item || host.endsWith('.' + item));
  if (!active) return;

  if (host === 'fdsflix-80ya.onrender.com' || host === 'fdsflix.onrender.com' || host === 'localhost') {
    try { window.__FDSFLIX_DIRECT__ = true; } catch (err) { /* ignore */ }
  }

  // Stubs leves para detectores de adblock — o fdsFlix não usa, mas alguns
  // players embutidos usam e bloqueiam o vídeo se detectarem bloqueio.
  try {
    window.canRunAds = true;
    window.adBlockDetected = false;
    window.adblock = false;
    window.isAdBlockActive = false;
    window.adsbygoogle = window.adsbygoogle || { push: function () { return 0; }, loaded: true };
  } catch (err) { /* ignore */ }

  function externalPopup(url) {
    try {
      const parsed = new URL(String(url), location.href);
      if (/(?:^|\/)(?:ads?|advert(?:isement|ising)?|sponsor(?:ed)?|popunder|popups?)(?:\/|$)/i.test(parsed.pathname)) {
        return true;
      }
      if (parsed.origin === location.origin) return false;
      if (/(^|\.)accounts\.google\.com$/i.test(parsed.hostname)) return false;
      return true;
    } catch (err) {
      return false;
    }
  }

  // Links/forms com target=_blank também abrem aba: bloqueia só os externos.
  try {
    document.addEventListener('click', function (event) {
      const target = event.target;
      if (!target || !target.closest) return;
      const el = target.closest('a[target="_blank"],area[target="_blank"],form[target="_blank"]');
      if (!el) return;
      const url = el.href || el.getAttribute('href') || el.action || el.getAttribute('action') || '';
      if (!externalPopup(url)) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    document.addEventListener('auxclick', function (event) {
      if (event.button !== 1) return;
      const target = event.target;
      if (!target || !target.closest) return;
      const el = target.closest('a[target="_blank"],area[target="_blank"]');
      if (!el) return;
      const url = el.href || el.getAttribute('href') || '';
      if (!externalPopup(url)) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  } catch (err) { /* ignore */ }

  // Popups externos: permite same-origin (navegação normal) e OAuth conhecido.
  try {
    const nativeOpen = window.open;
    if (typeof nativeOpen === 'function') {
      window.open = function (url) {
        try {
          if (!url) return null;
          const parsed = new URL(String(url), location.href);
          if (parsed.origin === location.origin) return nativeOpen.apply(window, arguments);
          if (/(^|\.)accounts\.google\.com$/i.test(parsed.hostname)) return nativeOpen.apply(window, arguments);
        } catch (err) { /* ignore */ }
        return null;
      };
    }
  } catch (err) { /* ignore */ }
})();
