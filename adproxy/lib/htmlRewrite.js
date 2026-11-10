'use strict';

const cheerio = require('cheerio');

const { rewriteCss } = require('./cssRewrite');
const { classifyIframe, hasAdMarker, hasPlayerMarker, isAdScriptCode, isAdUrl } = require('./adRules');
const { isTargetUrl, rewriteUrl } = require('./urls');

const URL_ATTRS = [
  'src',
  'poster',
  'data-src',
  'data-lazy-src',
  'data-original',
  'data-url',
  'data-video',
  'data-video-src',
  'data-iframe',
  'data-poster',
  'data-thumb',
  'data-image',
  'data-bg',
  'data-background',
  'background',
  'longdesc'
];

const JS_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'text/ecmascript',
  'module',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5'
]);

function isJsType(type) {
  return JS_TYPES.has(String(type || '').trim().toLowerCase());
}

function getParentMarker($, el) {
  const parts = [];
  let current = $(el).parent();
  for (let depth = 0; depth < 3 && current.length; depth += 1) {
    const node = current.get(0);
    if (!node || !node.attribs) break;
    parts.push(node.attribs.class || '', node.attribs.id || '');
    current = current.parent();
  }
  return parts.filter(Boolean).join(' ');
}

function rewriteSrcset(value, baseUrl, map) {
  const text = String(value || '');
  if (!text) return { value: text, changed: false, blocked: false };
  if (text.includes('data:')) return { value: text, changed: false, blocked: false };

  const kept = [];
  let changed = false;
  let blocked = false;

  for (const part of text.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const space = trimmed.search(/\s/);
    const rawUrl = space === -1 ? trimmed : trimmed.slice(0, space);
    const descriptor = space === -1 ? '' : trimmed.slice(space).trim();
    const result = map(rawUrl, baseUrl);
    if (result.blocked) {
      blocked = true;
      continue;
    }
    if (result.changed) changed = true;
    kept.push(descriptor ? `${result.value} ${descriptor}` : result.value);
  }

  return { value: kept.join(', '), changed, blocked };
}

function buildRuntime(config) {
  const allowedHosts = JSON.stringify(config.popupAllowHosts || []);
  const blockPopups = config.blockPopups ? 'true' : 'false';

  return `(function(){
  "use strict";
  var allowHosts = ${allowedHosts};
  function hostAllowed(host) {
    host = String(host || "").toLowerCase();
    for (var i = 0; i < allowHosts.length; i++) {
      var suffix = allowHosts[i];
      if (host === suffix || host.slice(-suffix.length - 1) === "." + suffix) return true;
    }
    return false;
  }
  try {
    window.adsbygoogle = window.adsbygoogle || { push: function(){ return 0; }, loaded: true };
  } catch (e) {}
  try {
    var slot = {
      addService: function(){ return this; },
      setTargeting: function(){ return this; },
      defineSizeMapping: function(){ return this; },
      setCollapseEmptyDiv: function(){ return this; },
      setClickUrl: function(){ return this; },
      setCategoryExclusion: function(){ return this; }
    };
    var pubads = {
      addEventListener: function(){}, removeEventListener: function(){},
      refresh: function(){}, setTargeting: function(){ return this; },
      enableSingleRequest: function(){ return this; }, collapseEmptyDivs: function(){},
      getSlots: function(){ return []; }, getVersion: function(){ return "0"; }
    };
    window.googletag = window.googletag || {
      cmd: [],
      pubads: function(){ return pubads; },
      defineSlot: function(){ return slot; },
      defineOutOfPageSlot: function(){ return slot; },
      defineUnit: function(){ return slot; },
      enableServices: function(){},
      display: function(){},
      destroySlots: function(){},
      apiReady: true
    };
    window.googletag.cmd = window.googletag.cmd || [];
  } catch (e) {}
  try {
    function NoAdBlock(options) { this.options = options || {}; this._options = this.options; }
    NoAdBlock.prototype.check = function(){ return true; };
    NoAdBlock.prototype.on = function(flag, callback){
      if ((flag === false || flag === "notDetected") && typeof callback === "function") {
        try { callback(); } catch (e) {}
      }
      return this;
    };
    NoAdBlock.prototype.onDetected = function(){ return this; };
    NoAdBlock.prototype.onNotDetected = function(callback){
      if (typeof callback === "function") { try { callback(); } catch (e) {} }
      return this;
    };
    NoAdBlock.prototype.setOption = function(){ return this; };
    NoAdBlock.prototype.clearEvent = function(){ return this; };
    NoAdBlock.prototype._setOption = function(){ return this; };
    window.blockAdBlock = window.blockAdBlock || NoAdBlock;
    window.BlockAdBlock = window.BlockAdBlock || NoAdBlock;
    window.FuckAdBlock = window.FuckAdBlock || NoAdBlock;
    window.fuckAdBlock = window.fuckAdBlock || NoAdBlock;
    window.adblockDetector = window.adblockDetector || {
      detect: function(){ return false; }, check: function(){ return false; }, init: function(){ return this; }
    };
  } catch (e) {}
  try {
    window.canRunAds = true;
    window.adBlockDetected = false;
    window.adblock = false;
    window.isAdBlockActive = false;
    window.adblockEnabled = false;
  } catch (e) {}
  if (${blockPopups}) {
    try {
      var nativeOpen = window.open;
      if (typeof nativeOpen === "function") {
        window.open = function(url) {
          try {
            if (!url) return nativeOpen.apply(window, arguments);
            var parsed = new URL(String(url), location.href);
            if (parsed.origin === location.origin || hostAllowed(parsed.hostname)) {
              return nativeOpen.apply(window, arguments);
            }
          } catch (e) {}
          return null;
        };
      }
    } catch (e) {}
  }
})();`;
}

function buildHidingCss() {
  return `
ins.adsbygoogle,.adsbygoogle,[id^="div-gpt-ad"],[id^="google_ads"],[id^="aswift_"],[name^="google_ads"],
[data-ad-slot],[data-ad-client],[data-ad-format],[data-google-query-id],
[class~="ad"],[class~="ads"],[class~="advert"],[class~="advertisement"],[class~="sponsor"],[class~="sponsored"],[class~="popunder"],
[class*="ad-slot"],[class*="ad-unit"],[class*="ad-container"],[class*="ad-wrapper"],[class*="ad-banner"],[class*="ad-zone"],
[class*="advert"],[class*="sponsor"],[class*="popunder"],[id*="advert"],[id*="popunder"],
[class*="gpt-ad"],[class*="dfp-ad"],
[class$="-ad"],[class*="-ad-"],[id$="-ad"],[id*="-ad-"] {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
  width: 0 !important;
  height: 0 !important;
  overflow: hidden !important;
}
`.trim();
}

/**
 * Sanitiza e reescreve uma página HTML.
 * @param {string} html
 * @param {{url: string, config: object, mode: 'target'|'proxied', inject?: boolean}} options
 */
function sanitizeHtml(html, options) {
  const { url: pageUrl, config, mode = 'target' } = options;
  const inject = options.inject !== false;
  const depth = Number(options.depth) || 0;
  const $ = cheerio.load(html);
  const stats = {
    removedMetaCsp: 0,
    removedScripts: 0,
    removedIframes: 0,
    removedContainers: 0,
    removedInlineScripts: 0,
    blockedResources: 0,
    rewrittenCssUrls: 0,
    blockedCssUrls: 0
  };

  function drop(el) {
    const $el = $(el);
    if (!$el.length) return;
    $el.remove();
  }

  function map(raw, baseUrl, navigation = false) {
    return rewriteUrl(raw, baseUrl || pageUrl, {
      config,
      mode,
      pageUrl,
      navigation
    });
  }

  // <base> muda a resolução de TODAS as URLs relativas. Resolvemos contra ele,
  // mas o removemos/substituímos para que o navegador não fuja do proxy.
  let effectiveBase = pageUrl;
  const $base = $('base[href]').first();
  if ($base.length) {
    try {
      effectiveBase = new URL($base.attr('href'), pageUrl).toString();
    } catch (error) {
      effectiveBase = pageUrl;
    }
    const mappedBase = map(effectiveBase, pageUrl, false);
    if (
      !mappedBase.blocked &&
      !mappedBase.external &&
      mappedBase.value.startsWith('/') &&
      !mappedBase.value.startsWith('/_adshield/r/')
    ) {
      $base.attr('href', mappedBase.value);
    } else {
      $base.remove();
    }
  }

  // 1) Contêineres de anúncio por seletores conhecidos.
  const adSelectors = [
    'ins.adsbygoogle',
    '[data-ad-slot]',
    '[data-ad-client]',
    '[data-ad-format]',
    '[data-google-query-id]',
    '[id^="div-gpt-ad"]',
    '[id^="google_ads"]',
    '[id^="aswift_"]',
    '[name^="google_ads"]',
    '[class*="adsbygoogle"]'
  ];
  $(adSelectors.join(',')).each((index, el) => {
    stats.removedContainers += 1;
    drop(el);
  });

  // CSP via <meta> também bloquearia o runtime e os recursos reescritos.
  $('meta[http-equiv]').each((index, el) => {
    const $el = $(el);
    if (String($el.attr('http-equiv') || '').toLowerCase() !== 'content-security-policy') return;
    stats.removedMetaCsp += 1;
    drop(el);
  });

  // Fallback sem JavaScript: o navegador só interpreta <noscript> quando o JS
  // está desligado. Se houver anúncio lá dentro, removemos o bloco inteiro.
  $('noscript').each((index, el) => {
    const content = String($(el).html() || '');
    if (/<(?:iframe|script|img|ins)\b|adsbygoogle|doubleclick|advert|popunder|class=["'][^"']*\bad\b/i.test(content)) {
      stats.removedContainers += 1;
      drop(el);
    }
  });

  // 2) Contêineres por classe/id (com limites de token para não casar
  //    "header", "download", "ad-free", "ad-player" etc.).
  $('[class],[id]').each((index, el) => {
    const node = el;
    if (!node.attribs) return;
    const tag = String(node.tagName || '').toLowerCase();
    if (tag === 'html' || tag === 'head' || tag === 'body') return;
    const marker = `${node.attribs.class || ''} ${node.attribs.id || ''}`;
    if (hasAdMarker(marker)) {
      // Não deixe um wrapper com nome de anúncio levar o player junto. Os
      // anúncios internos continuam sendo removidos individualmente.
      const $el = $(el);
      const containsPlayer =
        hasPlayerMarker(marker) ||
        $el.find('iframe[allowfullscreen], iframe[webkitallowfullscreen], video, .player, [class*="player"]').length > 0;
      if (!containsPlayer) {
        stats.removedContainers += 1;
        drop(el);
      }
    }
  });

  // 3) Scripts: remove os de rede de anúncios e os inline de popunder/adblock.
  $('script').each((index, el) => {
    const $el = $(el);
    const src = $el.attr('src');
    if (src && !/^(?:data|blob):/i.test(src)) {
      if (isAdUrl(src, effectiveBase)) {
        stats.removedScripts += 1;
        drop(el);
        return;
      }
      const mapped = map(src, effectiveBase, false);
      if (mapped.blocked) {
        stats.removedScripts += 1;
        stats.blockedResources += 1;
        drop(el);
        return;
      }
      if (mapped.changed) {
        $el.attr('src', mapped.value);
        $el.removeAttr('crossorigin');
      }
      // O destino pode reescrever o JS ou o próprio arquivo pode ser proxiado;
      // manter SRI causaria bloqueio silencioso do script.
      $el.removeAttr('integrity');
      return;
    }

    const type = String($el.attr('type') || '').toLowerCase();
    if (!isJsType(type)) return;
    const verdict = isAdScriptCode($el.html() || '');
    if (verdict.remove) {
      stats.removedInlineScripts += 1;
      drop(el);
    }
  });

  // 4) iframes: remove anúncios e preserva players.
  $('iframe').each((index, el) => {
    const $el = $(el);
    const attrs = { ...(el.attribs || {}) };
    const verdict = classifyIframe(attrs, config, getParentMarker($, el));
    if (verdict.action === 'remove') {
      stats.removedIframes += 1;
      drop(el);
      return;
    }

    const shouldProxy = config.proxyPlayerIframes || mode === 'proxied';

    for (const attr of ['src', 'data-src', 'data-lazy-src']) {
      const raw = $el.attr(attr);
      if (!raw || /^(?:data|blob|about):/i.test(raw)) continue;
      if (isAdUrl(raw, effectiveBase)) {
        $el.removeAttr(attr);
        continue;
      }
      let sameTarget = false;
      try {
        sameTarget = isTargetUrl(new URL(raw, effectiveBase), config);
      } catch (error) {
        sameTarget = false;
      }

      if (!sameTarget && !shouldProxy) {
        // Jogador de terceiro fica direto: muitos players assinam sessão por
        // origem/domínio e quebrariam se o HTML fosse servido por nós.
        try {
          $el.attr(attr, new URL(raw, effectiveBase).toString());
        } catch (error) {
          // mantém como veio
        }
        continue;
      }

      const mapped = map(raw, effectiveBase, false);
      if (!mapped.blocked && mapped.changed) $el.attr(attr, mapped.value);
    }

    if (config.hardenPlayerIframes) {
      const current = String($el.attr('sandbox') || '')
        .split(/\s+/)
        .filter(Boolean)
        .filter((token) => !/^allow-(?:popups|top-navigation|top-navigation-by-user-activation|modals)$/i.test(token));
      if (!$el.attr('sandbox')) current.push('allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-presentation', 'allow-orientation-lock');
      $el.attr('sandbox', [...new Set(current)].join(' '));
    }

    const srcdoc = $el.attr('srcdoc');
    if (srcdoc) {
      if (depth >= 3) {
        // Evita recursão patológica; sem srcdoc não há anúncio escondido.
        $el.removeAttr('srcdoc');
      } else {
        const nested = sanitizeHtml(srcdoc, {
          url: effectiveBase,
          config,
          mode,
          inject: false,
          depth: depth + 1
        });
        $el.attr('srcdoc', nested.html);
        stats.removedScripts += nested.stats.removedScripts;
        stats.removedInlineScripts += nested.stats.removedInlineScripts;
        stats.removedContainers += nested.stats.removedContainers;
      }
    }
  });

  // 5) Links, formulários, imagens e demais recursos.
  $('a[href],area[href]').each((index, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    if (!href) return;
    if (/^javascript:/i.test(href) && /(?:window\.open|popunder|adblock)/i.test(href)) {
      $el.removeAttr('href');
      return;
    }
    const mapped = map(href, effectiveBase, true);
    if (mapped.changed) $el.attr('href', mapped.value);
    $el.removeAttr('ping');
    if (String($el.attr('target') || '').toLowerCase() === '_blank') {
      const rel = new Set(String($el.attr('rel') || '').split(/\s+/).filter(Boolean));
      rel.add('noopener');
      rel.add('noreferrer');
      $el.attr('rel', [...rel].join(' '));
    }
  });

  $('form[action]').each((index, el) => {
    const $el = $(el);
    const action = $el.attr('action');
    if (!action) return;
    const mapped = map(action, effectiveBase, true);
    if (mapped.changed) $el.attr('action', mapped.value);
  });

  $('button[formaction],input[formaction]').each((index, el) => {
    const $el = $(el);
    const action = $el.attr('formaction');
    if (!action) return;
    const mapped = map(action, effectiveBase, true);
    if (mapped.changed) $el.attr('formaction', mapped.value);
  });

  $('link[href]').each((index, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    const rel = String($el.attr('rel') || '').toLowerCase();
    const loadsResource = /(?:stylesheet|preload|modulepreload|preconnect|dns-prefetch|icon|manifest|alternate)/.test(rel);
    if (!href) return;
    if (loadsResource && isAdUrl(href, effectiveBase)) {
      drop(el);
      return;
    }
    if (/canonical/.test(rel)) return;
    // preconnect/dns-prefetch apontam para a origem do CDN, não para um recurso.
    // Deixamos o navegador aquecer a conexão real; o recurso em si é proxiado.
    if (/(?:preconnect|dns-prefetch)/.test(rel)) return;
    const mapped = map(href, effectiveBase, false);
    if (mapped.blocked) {
      if (loadsResource) drop(el);
      else $el.removeAttr('href');
      return;
    }
    if (mapped.changed) {
      $el.attr('href', mapped.value);
      $el.removeAttr('crossorigin');
    }
    if (loadsResource) $el.removeAttr('integrity');
  });

  $('link[imagesrcset]').each((index, el) => {
    const $el = $(el);
    const srcset = $el.attr('imagesrcset');
    if (!srcset) return;
    const result = rewriteSrcset(srcset, effectiveBase, map);
    if (result.value) {
      if (result.changed) $el.attr('imagesrcset', result.value);
    } else {
      $el.removeAttr('imagesrcset');
    }
  });

  $('meta[http-equiv]').each((index, el) => {
    const $el = $(el);
    if (String($el.attr('http-equiv') || '').toLowerCase() !== 'refresh') return;
    const content = String($el.attr('content') || '');
    const match = content.match(/^\s*(\d+)\s*;\s*url\s*=\s*(.+)$/i);
    if (!match) return;
    const delay = match[1];
    const raw = match[2].trim().replace(/^['"]|['"]$/g, '');
    const mapped = map(raw, effectiveBase, true);
    if (mapped.blocked) {
      drop(el);
      return;
    }
    if (mapped.external && !config.rewriteExternalLinks) {
      drop(el);
      return;
    }
    $el.attr('content', `${delay};url=${mapped.value}`);
  });

  $('meta[property],meta[name]').each((index, el) => {
    const $el = $(el);
    const key = String($el.attr('property') || $el.attr('name') || '').toLowerCase();
    if (!/^(?:og:(?:image|image:url|image:secure_url|video|video:url|video:secure_url)|twitter:(?:image|player|player:stream))$/.test(key)) return;
    const content = $el.attr('content');
    if (!content) return;
    const mapped = map(content, effectiveBase, false);
    if (mapped.blocked) {
      drop(el);
      return;
    }
    if (mapped.changed) $el.attr('content', mapped.value);
  });

  $('img').each((index, el) => {
    const $el = $(el);
    const src = $el.attr('src');
    if (src && isAdUrl(src, effectiveBase)) {
      drop(el);
      return;
    }
    for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original']) {
      const raw = $el.attr(attr);
      if (!raw || /^(?:data|blob):/i.test(raw)) continue;
      const mapped = map(raw, effectiveBase, false);
      if (mapped.blocked) {
        drop(el);
        return;
      }
      if (mapped.changed) $el.attr(attr, mapped.value);
    }
    for (const attr of ['srcset', 'data-srcset']) {
      const raw = $el.attr(attr);
      if (!raw) continue;
      const result = rewriteSrcset(raw, effectiveBase, map);
      if (result.value) {
        if (result.changed) $el.attr(attr, result.value);
      } else {
        // Só o srcset era composto de anúncios; o src principal ainda vale.
        $el.removeAttr(attr);
      }
    }
  });

  $('source').each((index, el) => {
    const $el = $(el);
    for (const attr of ['src', 'data-src']) {
      const raw = $el.attr(attr);
      if (!raw) continue;
      const mapped = map(raw, effectiveBase, false);
      if (mapped.blocked) {
        drop(el);
        return;
      }
      if (mapped.changed) $el.attr(attr, mapped.value);
    }
    const srcset = $el.attr('srcset');
    if (srcset) {
      const result = rewriteSrcset(srcset, effectiveBase, map);
      if (result.value) {
        if (result.changed) $el.attr('srcset', result.value);
      } else {
        $el.removeAttr('srcset');
        if (!$el.attr('src') && !$el.attr('data-src')) {
          drop(el);
          return;
        }
      }
    }
  });

  $('video,audio,track,embed,input[type="image"]').each((index, el) => {
    const $el = $(el);
    for (const attr of URL_ATTRS) {
      const raw = $el.attr(attr);
      if (!raw) continue;
      if (isAdUrl(raw, effectiveBase)) {
        $el.removeAttr(attr);
        continue;
      }
      const mapped = map(raw, effectiveBase, false);
      if (mapped.blocked) {
        $el.removeAttr(attr);
        continue;
      }
      if (mapped.changed) $el.attr(attr, mapped.value);
    }
  });

  $('object[data]').each((index, el) => {
    const $el = $(el);
    const raw = $el.attr('data');
    if (!raw) return;
    if (isAdUrl(raw, effectiveBase)) {
      drop(el);
      return;
    }
    const mapped = map(raw, effectiveBase, false);
    if (mapped.blocked) {
      drop(el);
      return;
    }
    if (mapped.changed) $el.attr('data', mapped.value);
  });

  $('[data-bg],[data-background]').each((index, el) => {
    const $el = $(el);
    for (const attr of ['data-bg', 'data-background']) {
      const raw = $el.attr(attr);
      if (!raw) continue;
      if (isAdUrl(raw, effectiveBase)) {
        $el.removeAttr(attr);
        continue;
      }
      const mapped = map(raw, effectiveBase, false);
      if (mapped.blocked) $el.removeAttr(attr);
      else if (mapped.changed) $el.attr(attr, mapped.value);
    }
  });

  $('[background]').each((index, el) => {
    const $el = $(el);
    const raw = $el.attr('background');
    if (!raw) return;
    if (isAdUrl(raw, effectiveBase)) {
      $el.removeAttr('background');
      return;
    }
    const mapped = map(raw, effectiveBase, false);
    if (mapped.blocked) $el.removeAttr('background');
    else if (mapped.changed) $el.attr('background', mapped.value);
  });

  $('use,image').each((index, el) => {
    const $el = $(el);
    for (const attr of ['href', 'xlink:href']) {
      const raw = $el.attr(attr);
      if (!raw || /^#/.test(raw)) continue;
      const mapped = map(raw, effectiveBase, false);
      if (mapped.blocked) $el.removeAttr(attr);
      else if (mapped.changed) $el.attr(attr, mapped.value);
    }
  });

  // 6) CSS inline e <style>.
  $('[style]').each((index, el) => {
    const $el = $(el);
    const style = $el.attr('style');
    if (!style) return;
    const rewritten = rewriteCss(style, effectiveBase, (raw, base) => map(raw, base, false), stats);
    if (rewritten !== style) $el.attr('style', rewritten);
  });

  $('style').each((index, el) => {
    const $el = $(el);
    const css = $el.html();
    if (!css) return;
    const rewritten = rewriteCss(css, effectiveBase, (raw, base) => map(raw, base, false), stats);
    if (rewritten !== css) $el.html(rewritten);
  });

  // 7) Handlers inline que abrem popups.
  $('*').each((index, el) => {
    const node = el;
    if (!node.attribs) return;
    for (const [attr, value] of Object.entries(node.attribs)) {
      if (!/^on/i.test(attr)) continue;
      if (/(?:window\.open|popunder|adblockDetect|blockAdBlock|FuckAdBlock)/i.test(String(value))) {
        $(el).removeAttr(attr);
      }
    }
  });

  // 8) Charset: a saída é sempre UTF-8.
  const $charset = $('meta[charset]').first();
  if ($charset.length) $charset.attr('charset', 'utf-8');
  $('meta[http-equiv]').each((index, el) => {
    const $el = $(el);
    if (String($el.attr('http-equiv') || '').toLowerCase() !== 'content-type') return;
    const content = String($el.attr('content') || '');
    if (/charset=/i.test(content)) $el.attr('content', content.replace(/charset=[^;]+/i, 'charset=utf-8'));
  });

  if (inject) {
    if (!$('head').length) {
      if ($('html').length) $('html').prepend('<head></head>');
      else $('body').before('<head></head>');
    }

    if (config.injectStubs) {
      $('head').prepend(`<script id="adshield-runtime">${buildRuntime(config)}</script>`);
    }

    // O <meta charset> precisa ficar nos primeiros 1024 bytes, antes do runtime.
    const $charsetMeta = $('meta[charset]').first();
    if ($charsetMeta.length) {
      $('head').prepend($charsetMeta);
    } else {
      $('head').prepend('<meta charset="utf-8">');
    }

    if (config.injectHidingCss) {
      const $style = $('<style id="adshield-hide"></style>');
      $style.text(buildHidingCss());
      if ($('body').length) $('body').append($style);
      else $('head').append($style);
    }
  }

  const output = $.html();
  return { html: output, stats };
}

function removedSummary(stats) {
  const parts = [];
  if (stats.removedMetaCsp) parts.push(`csp=${stats.removedMetaCsp}`);
  if (stats.removedScripts) parts.push(`scripts=${stats.removedScripts}`);
  if (stats.removedInlineScripts) parts.push(`inline=${stats.removedInlineScripts}`);
  if (stats.removedIframes) parts.push(`iframes=${stats.removedIframes}`);
  if (stats.removedContainers) parts.push(`containers=${stats.removedContainers}`);
  if (stats.blockedResources) parts.push(`resources=${stats.blockedResources}`);
  if (stats.blockedCssUrls) parts.push(`css=${stats.blockedCssUrls}`);
  return parts.length ? parts.join(';') : '0';
}

module.exports = { sanitizeHtml, removedSummary, buildRuntime, buildHidingCss };
