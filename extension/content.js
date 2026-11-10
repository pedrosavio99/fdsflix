(() => {
  'use strict';

  const FDS_HOSTS = new Set([
    'fdsflix-80ya.onrender.com',
    'fdsflix.onrender.com',
    'localhost'
  ]);
  const PLAYER_HOSTS = [
    'vidlink.pro',
    'vidsrc.net',
    'vidsrc.cc',
    'vidsrc.xyz',
    'vidsrc.to',
    'vidfast.pro',
    '2embed.cc',
    'autoembed.co',
    'embed.su',
    'youtube.com',
    'youtube-nocookie.com',
    'player.vimeo.com'
  ];
  const AD_HOSTS = [
    'doubleclick.net',
    'googlesyndication.com',
    'googleadservices.com',
    'adservice.google.com',
    'amazon-adsystem.com',
    'adnxs.com',
    'adsrvr.org',
    'criteo.com',
    'criteo.net',
    'taboola.com',
    'outbrain.com',
    'revcontent.com',
    'mgid.com',
    'zedo.com',
    'popads.net',
    'popcash.net',
    'propellerads.com',
    'adsterra.com',
    'hilltopads.net',
    'juicyads.com',
    'exoclick.com',
    'trafficjunky.net',
    'trafficfactory.biz',
    'openx.net',
    'pubmatic.com',
    'rubiconproject.com'
  ];
  const AD_SIZES = new Set([
    '300x250', '250x250', '200x200', '728x90', '970x90', '970x250', '468x60',
    '234x60', '120x600', '160x600', '300x600', '320x50', '320x100', '336x280',
    '300x100', '300x50', '480x60', '640x100', '550x480', '300x1050'
  ]);
  const AD_PATH_RE = /(?:^|[/._-])(?:ads?|adserver|adservice|advert(?:isement|ising)?|sponsor(?:ed)?|popunder|popups?|prebid|adsbygoogle|pagead|adslot|adunit|adzone|adframe|adiframe|gpt)(?:[/._-]|$)/i;

  const host = location.hostname.toLowerCase();
  const isFds = FDS_HOSTS.has(host);
  const isPlayer = PLAYER_HOSTS.some((item) => host === item || host.endsWith('.' + item));
  if (!isFds && !isPlayer) return;

  if (isFds) {
    try { document.documentElement.setAttribute('data-fdsflix-extension', '1'); } catch (err) { /* ignore */ }
  }

  function isAdHost(value) {
    const normalized = String(value || '').toLowerCase();
    return AD_HOSTS.some((item) => normalized === item || normalized.endsWith('.' + item));
  }

  function isPlayerHost(value) {
    const normalized = String(value || '').toLowerCase();
    return PLAYER_HOSTS.some((item) => normalized === item || normalized.endsWith('.' + item));
  }

  function hasAdMarker(value) {
    const text = String(value || '').toLowerCase();
    for (const part of text.split(/\s+/)) {
      if (/^(?:ad|ads|advert|adverts|advertisement|advertisements|advertising|advertiser|sponsor|sponsors|sponsored|popunder|popunders|adsense|adsbygoogle|adslot|adunit|adzone|adserver|adservice|adwrapper|adcontainer|adbanner|adframe|adlabel|adspace|adplaceholder)$/.test(part)) {
        return true;
      }
      if (/^ad[-_](?:slot|unit|zone|wrapper|wrap|container|banner|box|frame|label|space|placeholder|server|service|sense|area|overlay|holder|placement|sticky|interstitial)(?:$|[-_])/.test(part)) return true;
      if (/(?:^|[-_])(?:gpt|dfp|google)[-_]ad(?:[-_]|$)/.test(part)) return true;
      if (/(?:^|[-_])banner[-_]ad(?:[-_]|$)/.test(part)) return true;
      if (/^(?:google_ads|aswift_|google_ads_iframe|div-gpt-ad)/.test(part)) return true;
    }
    return false;
  }

  function hasPlayerMarker(value) {
    const text = String(value || '').toLowerCase();
    return /(?:^|[\s_-])(player|jwplayer|plyr|video-player|video|embed|stream|watch|movie|episode|anime)(?:$|[\s_-])/.test(text);
  }

  function containsPlayer(el) {
    try {
      return Boolean(el.querySelector('video, iframe[allowfullscreen], iframe[webkitallowfullscreen], .player, [class*="player"]'));
    } catch (err) {
      return false;
    }
  }

  function remove(el) {
    try { el.remove(); } catch (err) { /* ignore */ }
  }

  function iframeAd(el) {
    const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
    const ownMarker = [el.className, el.id, el.name, el.title, el.getAttribute('aria-label')].join(' ');
    if (!src) return !hasPlayerMarker(ownMarker);
    if (/^(?:data|javascript|about):/i.test(src)) return !hasPlayerMarker(ownMarker);
    let url;
    try { url = new URL(src, location.href); } catch (err) { return false; }
    if (isAdHost(url.hostname) && !isPlayerHost(url.hostname)) return true;
    if (AD_PATH_RE.test(url.pathname) && !isPlayerHost(url.hostname)) return true;

    const width = Number.parseInt(el.getAttribute('width') || '', 10);
    const height = Number.parseInt(el.getAttribute('height') || '', 10);
    const size = Number.isFinite(width) && Number.isFinite(height) ? width + 'x' + height : '';
    const allow = String(el.getAttribute('allow') || '');
    const own = ownMarker;
    const player =
      hasPlayerMarker(own) ||
      isPlayerHost(url.hostname) ||
      /(?:^|[/._-])(?:embed|player|watch|video|stream)(?:[/._-]|$)/i.test(url.pathname) ||
      el.hasAttribute('allowfullscreen') ||
      el.hasAttribute('webkitallowfullscreen') ||
      /autoplay|fullscreen|encrypted-media|picture-in-picture/i.test(allow) ||
      (width >= 480 && height >= 270);

    if (size && AD_SIZES.has(size)) return !player;
    if (Number.isFinite(width) && Number.isFinite(height) && (width <= 2 || height <= 2)) return true;
    if (el.hidden || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute('style') || '')) return true;
    return false;
  }

  const HIDE_CSS = `
    ins.adsbygoogle,.adsbygoogle,[id^="div-gpt-ad"],[id^="google_ads"],[id^="aswift_"],
    [data-ad-slot],[data-ad-client],[data-ad-format],[data-google-query-id],
    [class~="ad"],[class~="ads"],[class~="advert"],[class~="advertisement"],[class~="sponsor"],[class~="sponsored"],[class~="popunder"],
    [class*="ad-slot"],[class*="ad-unit"],[class*="ad-container"],[class*="ad-wrapper"],[class*="ad-banner"],[class*="ad-zone"],
    [class*="advert"],[class*="sponsor"],[class*="popunder"],[id*="advert"],[id*="popunder"],
    [class*="gpt-ad"],[class*="dfp-ad"],[class$="-ad"],[class*="-ad-"],[id$="-ad"],[id*="-ad-"] {
      display:none!important; visibility:hidden!important; pointer-events:none!important;
      width:0!important; height:0!important; overflow:hidden!important;
    }
  `;

  function injectCss() {
    if (document.getElementById('fdsflix-adshield-css')) return;
    const style = document.createElement('style');
    style.id = 'fdsflix-adshield-css';
    style.textContent = HIDE_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function clean(root) {
    if (!root || root.nodeType !== 1) return;
    injectCss();

    root.querySelectorAll('script[src]').forEach((el) => {
      const src = el.getAttribute('src') || '';
      if (!src) return;
      if (isAdHost((() => { try { return new URL(src, location.href).hostname; } catch (e) { return ''; } })()) ||
          AD_PATH_RE.test((() => { try { return new URL(src, location.href).pathname; } catch (e) { return ''; } })())) {
        remove(el);
      }
    });

    root.querySelectorAll('ins.adsbygoogle,[data-ad-slot],[data-ad-client],[data-google-query-id],[id^="div-gpt-ad"],[id^="google_ads"],[id^="aswift_"]').forEach(remove);

    root.querySelectorAll('iframe').forEach((el) => {
      if (iframeAd(el)) remove(el);
    });

    root.querySelectorAll('[class],[id]').forEach((el) => {
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'html' || tag === 'head' || tag === 'body') return;
      const marker = (el.className || '') + ' ' + (el.id || '');
      if (!hasAdMarker(marker)) return;
      if (containsPlayer(el)) return;
      remove(el);
    });
  }

  function boot() {
    if (isFds) {
      try { document.documentElement.setAttribute('data-fdsflix-extension', '1'); } catch (err) { /* ignore */ }
    }
    injectCss();
    clean(document.documentElement);
    try {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              clean(node);
              if (node.matches && node.matches('iframe,script[src],ins.adsbygoogle,[class],[id]')) clean(node.parentElement || document.documentElement);
            }
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (err) { /* ignore */ }
  }

  if (document.documentElement) boot();
  else setTimeout(boot, 0);
})();
