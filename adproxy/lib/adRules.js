'use strict';

const AD_HOST_SUFFIXES = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagservices.com',
  'adservice.google.com',
  'amazon-adsystem.com',
  'adnxs.com',
  'adsrvr.org',
  'adform.net',
  'adroll.com',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'revcontent.com',
  'mgid.com',
  'zergnet.com',
  'zedo.com',
  'openx.net',
  'pubmatic.com',
  'rubiconproject.com',
  'casalemedia.com',
  'contextweb.com',
  'indexexchange.com',
  'bidswitch.net',
  'emxdgt.com',
  '33across.com',
  'gumgum.com',
  'loopme.me',
  'smaato.net',
  'yieldmo.com',
  'sharethrough.com',
  'teads.tv',
  'triplelift.com',
  'smartadserver.com',
  'adkernel.com',
  'adition.com',
  'adtech.de',
  'adtechus.com',
  'adbutler.com',
  'adplugg.com',
  'adspirit.de',
  'plista.com',
  'nativo.com',
  'emetriq.de',
  'yieldlab.net',
  'serving-sys.com',
  'sizmek.com',
  'flashtalking.com',
  'innovid.com',
  'springserve.com',
  'tremorhub.com',
  'undertone.com',
  'moatads.com',
  'adcolony.com',
  'applovin.com',
  'unityads.unity3d.com',
  'vungle.com',
  'chartboost.com',
  'tapjoy.com',
  'ironsrc.com',
  'supersonicads.com',
  'inmobi.com',
  'startapp.com',
  'mopub.com',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'propellerpops.com',
  'adsterra.com',
  'hilltopads.net',
  'juicyads.com',
  'exoclick.com',
  'exosrv.com',
  'trafficjunky.net',
  'trafficfactory.biz',
  'trafficstars.com',
  'clickadu.com',
  'adcash.com',
  'popmyads.com',
  'advertising.com',
  'ad-balancer.net',
  'bannerflow.com'
];

const AD_HOST_SUBSTRINGS = [
  'doubleclick',
  'googlesyndication',
  'googleadservices',
  'amazon-adsystem',
  'adnxs',
  'adsrvr',
  'adform',
  'adroll',
  'criteo',
  'taboola',
  'outbrain',
  'revcontent',
  'zedo',
  'popads',
  'popcash',
  'propellerads',
  'adsterra',
  'hilltopads',
  'juicyads',
  'exoclick',
  'trafficjunky',
  'trafficfactory',
  'adcolony',
  'applovin',
  'unityads',
  'vungle',
  'chartboost',
  'tapjoy',
  'ironsrc',
  'supersonicads',
  'smartadserver',
  'adkernel',
  'adbutler',
  'serving-sys',
  'sizmek',
  'flashtalking',
  'springserve',
  'tremorhub',
  'moatads'
];

const AD_LABELS = new Set([
  'ad',
  'ads',
  'adv',
  'adserver',
  'adservers',
  'adservice',
  'adservices',
  'advert',
  'adverts',
  'advertising',
  'adsystem',
  'adzone',
  'popunder',
  'popads',
  'sponsor',
  'sponsors'
]);

const EXACT_AD_MARKERS = new Set([
  'ad',
  'ads',
  'advert',
  'adverts',
  'advertisement',
  'advertisements',
  'advertising',
  'advertiser',
  'sponsor',
  'sponsors',
  'sponsored',
  'popunder',
  'popunders',
  'adsense',
  'adsbygoogle',
  'adslot',
  'adunit',
  'adzone',
  'adserver',
  'adservice',
  'adwrapper',
  'adcontainer',
  'adbanner',
  'adframe',
  'adlabel',
  'adspace',
  'adplaceholder'
]);

const AD_COMPONENT_PREFIXES = [
  'slot',
  'unit',
  'zone',
  'wrapper',
  'wrap',
  'container',
  'banner',
  'box',
  'frame',
  'label',
  'space',
  'placeholder',
  'server',
  'service',
  'sense',
  'area',
  'overlay',
  'holder',
  'placement',
  'leaderboard',
  'sidebar',
  'inline',
  'top',
  'bottom',
  'mobile',
  'desktop',
  'sticky',
  'interstitial'
];

const PLAYER_MARKERS = new Set([
  'player',
  'players',
  'videoplayer',
  'video-player',
  'jwplayer',
  'plyr',
  'video',
  'embed',
  'stream',
  'streaming',
  'watch',
  'movie',
  'movies',
  'tv',
  'episode',
  'anime',
  'media',
  'play',
  'iframe-player'
]);

const AD_SIZES = new Set([
  '300x250',
  '250x250',
  '200x200',
  '728x90',
  '970x90',
  '970x250',
  '468x60',
  '234x60',
  '120x600',
  '160x600',
  '300x600',
  '320x50',
  '320x100',
  '336x280',
  '300x100',
  '300x50',
  '480x60',
  '640x100',
  '550x480',
  '300x1050'
]);

const AD_PATH_RE =
  /(?:^|[/._-])(?:ads?|adserver|adservice|advert(?:isement|ising|iser)?|sponsor(?:ed)?|popunder|popups?|prebid|adsbygoogle|pagead|adslot|adunit|adzone|adframe|adiframe|ad-wrapper|ad-container|ad-overlay|banner-ad|gpt)(?:[/._-]|$)/i;

const AD_QUERY_RE =
  /(?:^|[?&])(?:ad|ads|adid|adunit|adzone|ad_type|ad_slot|adclient|adformat|clicktag|gclid|client=ca-pub|pubid)=/i;

const AD_CODE_HINT_RE =
  /doubleclick|googlesyndication|googleadservices|amazon-adsystem|popads|popcash|propellerads|adsterra|exoclick|juicyads|trafficjunky|taboola|outbrain|revcontent|mgid\.com/i;

function hostMatchesSuffix(host, suffix) {
  return host === suffix || host.endsWith('.' + suffix);
}

function normalizeHost(host) {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '')
    .replace(/:\d+$/, '');
}

function isPlayerHost(host, config) {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  return (config.playerHosts || []).some((suffix) => hostMatchesSuffix(normalized, suffix));
}

function isAdHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return false;

  if (AD_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(normalized, suffix))) {
    return true;
  }
  if (AD_HOST_SUBSTRINGS.some((part) => normalized.includes(part))) {
    return true;
  }

  const labels = normalized.split('.');
  return labels.some((label) => AD_LABELS.has(label));
}

function safeUrl(raw, base) {
  try {
    return new URL(raw, base);
  } catch (error) {
    return null;
  }
}

function isAdUrl(raw, base) {
  if (!raw) return false;
  const url = safeUrl(raw, base);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;
  if (isAdHost(url.hostname)) return true;
  if (AD_PATH_RE.test(url.pathname)) return true;
  if (AD_QUERY_RE.test(url.search)) return true;
  return false;
}

function hasAdMarker(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;

  for (const part of text.split(/\s+/)) {
    if (EXACT_AD_MARKERS.has(part)) return true;

    if (/^ad[-_](?:slot|unit|zone|wrapper|wrap|container|banner|box|frame|label|space|placeholder|server|service|sense|area|overlay|holder|placement|leaderboard|sidebar|inline|top|bottom|mobile|desktop|sticky|interstitial)(?:$|[-_])/.test(part)) {
      return true;
    }
    if (/^(?:ads|advert|advertisement|sponsor|sponsored)[-_](?:slot|unit|zone|wrapper|container|banner|box|label|area|holder|placement|block|link|text|image|video)(?:$|[-_])/.test(part)) {
      return true;
    }
    if (/(?:^|[-_])(?:gpt|dfp|google)[-_]ad(?:[-_]|$)/.test(part)) return true;
    if (/(?:^|[-_])banner[-_]ad(?:[-_]|$)/.test(part)) return true;
    if (/^(?:adsbygoogle|adsense|doubleclick)/.test(part)) return true;
    if (/^(?:google_ads|aswift_|google_ads_iframe)/.test(part)) return true;
    if (/^ad[-_]\d{2,4}x\d{2,4}(?:$|[-_])/.test(part)) return true;
    if (/^(?:popunder|popup)[-_]/.test(part)) return true;
    if (/(?:^|[-_])(?:header|footer|sidebar|content|inline|video|player|top|bottom|nav|page)[-_]ad(?:$|[-_])/.test(part)) {
      return true;
    }
  }

  return false;
}

function hasPlayerMarker(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  for (const part of text.split(/\s+/)) {
    if (PLAYER_MARKERS.has(part)) return true;
    if (/^(?:video|media|embed|stream)[-_](?:player|container|wrapper|box)$/.test(part)) {
      return true;
    }
    if (/player$/.test(part) && part.length <= 32) return true;
  }
  return false;
}

function dimensionFrom(value) {
  const match = String(value || '').match(/^\s*(\d{1,5})(?:px)?\s*$/i);
  return match ? Number(match[1]) : null;
}

function styleDimensions(style) {
  const width = String(style || '').match(/(?:^|;)\s*width\s*:\s*(\d{1,5})px/i);
  const height = String(style || '').match(/(?:^|;)\s*height\s*:\s*(\d{1,5})px/i);
  return {
    width: width ? Number(width[1]) : null,
    height: height ? Number(height[1]) : null
  };
}

function isHiddenElement(attrs) {
  if ('hidden' in attrs) return true;
  const style = String(attrs.style || '').toLowerCase();
  if (/display\s*:\s*none/.test(style)) return true;
  if (/visibility\s*:\s*hidden/.test(style)) return true;
  if (/opacity\s*:\s*0(?:[;\s]|$)/.test(style)) return true;
  return false;
}

function iframeScores(attrs, src, config, parentText) {
  const width = dimensionFrom(attrs.width) ?? styleDimensions(attrs.style).width;
  const height = dimensionFrom(attrs.height) ?? styleDimensions(attrs.style).height;
  const ownMarkerText = [attrs.id, attrs.class, attrs.name, attrs.title, attrs['aria-label']]
    .filter(Boolean)
    .join(' ');
  const markerText = `${ownMarkerText} ${parentText || ''}`.trim();
  const allow = String(attrs.allow || '').toLowerCase();
  const sandbox = String(attrs.sandbox || '').toLowerCase();

  let player = 0;
  let ad = 0;

  if (src) {
    const url = safeUrl(src, config.targetOrigin || undefined);
    if (url) {
      if (isPlayerHost(url.hostname, config)) player += 8;
      if (/\/(?:embed|player|watch|video|stream|movie|movies|tv|episode|anime|e|v|playlist)\b/i.test(url.pathname)) {
        player += 3;
      }
      if (/\.(?:m3u8|mpd)(?:$|\?)/i.test(url.pathname + url.search)) player += 3;
      if (isAdUrl(url.toString(), undefined)) ad += 20;
    }
  }

  if ('allowfullscreen' in attrs || 'webkitallowfullscreen' in attrs || 'mozallowfullscreen' in attrs) {
    player += 2;
  }
  if (/(?:autoplay|fullscreen|encrypted-media|picture-in-picture|accelerometer|gyroscope)/i.test(allow)) {
    player += 2;
  }
  if (hasPlayerMarker(ownMarkerText)) player += 4;
  if (hasPlayerMarker(parentText)) player += 1;
  if (sandbox && !/allow-scripts/.test(sandbox)) player -= 1;

  if (width && height) {
    if (width >= 480 && height >= 270) player += 2;
    if (width / height >= 1.3 && width / height <= 2.1) player += 1;
    if (AD_SIZES.has(`${width}x${height}`)) ad += 8;
  }

  if (hasAdMarker(markerText)) ad += 10;
  if (isHiddenElement(attrs)) ad += 20;
  if (width !== null && height !== null && (width <= 2 || height <= 2)) ad += 20;
  if (width !== null && height !== null && width < 200 && height < 100) ad += 6;
  if (!src || /^(?:about:blank|javascript:)/i.test(src)) ad += 5;

  return { width, height, player, ad, markerText };
}

/**
 * Decide o que fazer com um <iframe>.
 * A lista negra sempre vence; depois, sinais fortes de player preservam o iframe.
 */
function classifyIframe(attrs, config, parentText = '') {
  const rawSrc = attrs.src || attrs['data-src'] || attrs['data-lazy-src'] || '';
  const src = String(rawSrc || '').trim();

  if (!src) {
    if (hasPlayerMarker([attrs.id, attrs.class, attrs.name, attrs.title, parentText].join(' '))) {
      return { action: 'keep', reason: 'player sem src (lazy)', src: '', player: 4, ad: 0 };
    }
    if (attrs.srcdoc) {
      return { action: 'keep', reason: 'iframe srcdoc (conteúdo será sanitizado)', src: '', player: 0, ad: 0 };
    }
    return { action: 'remove', reason: 'iframe sem src', src: '', player: 0, ad: 5 };
  }

  if (/^(?:data|javascript):/i.test(src)) {
    return { action: 'remove', reason: 'iframe com URL insegura', src, player: 0, ad: 20 };
  }

  if (attrs.srcdoc) {
    return { action: 'keep', reason: 'iframe srcdoc (conteúdo será sanitizado)', src, player: 0, ad: 0 };
  }

  if (/^about:blank/i.test(src)) {
    if (hasPlayerMarker([attrs.id, attrs.class, attrs.name, attrs.title, parentText].join(' '))) {
      return { action: 'keep', reason: 'player about:blank', src, player: 4, ad: 0 };
    }
    return { action: 'remove', reason: 'iframe about:blank sem player', src, player: 0, ad: 10 };
  }

  if (isAdHost(safeUrl(src, config.targetOrigin || undefined)?.hostname)) {
    return { action: 'remove', reason: 'iframe de domínio de anúncio', src, player: 0, ad: 30 };
  }

  const scores = iframeScores(attrs, src, config, parentText);

  if (scores.ad >= 20) {
    return { action: 'remove', reason: 'iframe oculto/minúsculo', src, ...scores };
  }
  if (scores.player >= 8) {
    return { action: 'keep', reason: 'sinais fortes de player de vídeo', src, ...scores };
  }
  if (scores.ad >= 8) {
    return { action: 'remove', reason: 'iframe com dimensões/marcas de anúncio', src, ...scores };
  }
  if (scores.player >= 4) {
    return { action: 'keep', reason: 'sinais de player de vídeo', src, ...scores };
  }
  if (scores.width !== null && scores.height !== null && scores.width < 120 && scores.height < 60) {
    return { action: 'remove', reason: 'iframe minúsculo', src, ...scores };
  }

  return { action: 'keep', reason: 'iframe neutro (preservado)', src, ...scores };
}

function isAdScriptCode(code) {
  const text = String(code || '');
  if (!text.trim()) return { remove: false, reason: null };

  if (/\bpop\s*under\b/i.test(text)) return { remove: true, reason: 'popunder' };
  if (/\b(?:blockAdBlock|FuckAdBlock|detectAdBlock|adblockDetect|adBlockDetect|AdBlockDetector)\b/i.test(text)) {
    return { remove: true, reason: 'detector de adblock' };
  }
  if (/\b(?:canRunAds|adBlockDetected|isAdBlockActive)\b/i.test(text)) {
    return { remove: true, reason: 'detecção de adblock' };
  }
  if (/\b(?:disable|desative|desligue)\s+(?:o\s+|seu\s+|your\s+)?adblock/i.test(text)) {
    return { remove: true, reason: 'aviso de adblock' };
  }
  if (AD_CODE_HINT_RE.test(text) && /\b(?:document\.write|createElement\s*\(\s*['"]script|appendChild|insertBefore|eval\s*\(|atob\s*\()/i.test(text)) {
    return { remove: true, reason: 'injeção de anúncio inline' };
  }

  const usesWindowOpen = /\bwindow\.open\s*\(/i.test(text);
  if (!usesWindowOpen) return { remove: false, reason: null };

  const playerish = /\b(?:jwplayer|hls\.js|dash\.js|videojs|plyr|player|playlist|m3u8|mediaSource|sourceBuffer|shaka)\b/i.test(text);
  const adHint = /\b(?:popup|popunder|sponsor|advert|banner|redirect|click)\b/i.test(text);

  if (playerish && text.length > 3000) return { remove: false, reason: null };
  if (text.length < 12000 || adHint) {
    return { remove: true, reason: 'window.open em script inline' };
  }
  return { remove: false, reason: null };
}

module.exports = {
  AD_HOST_SUFFIXES,
  AD_SIZES,
  classifyIframe,
  hasAdMarker,
  hasPlayerMarker,
  hostMatchesSuffix,
  isAdHost,
  isAdScriptCode,
  isAdUrl,
  isPlayerHost,
  normalizeHost
};
