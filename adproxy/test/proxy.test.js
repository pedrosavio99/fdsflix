'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { after, before, test } = require('node:test');

const { createApp } = require('../lib/app');
const { loadConfig } = require('../lib/config');
const { rewriteCss } = require('../lib/cssRewrite');
const { sanitizeHtml } = require('../lib/htmlRewrite');
const { assertSafeDestination, rewriteUrl, signUrl } = require('../lib/urls');

let targetServer;
let cdnServer;
let proxyServer;
let proxyServerProxiedIframes;
let proxyBase;
let proxyProxiedBase;
let targetBase;
let cdnBase;
let config;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function htmlPage() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Fixture</title>
  <script src="https://ads.doubleclick.net/ad.js"></script>
  <script src="${cdnBase}/lib.js"></script>
  <script src="/legit.js"></script>
  <script>window.open('https://ad.example/popup')</script>
  <script>if (window.canRunAds !== true) { document.body.innerHTML = 'disable adblock'; }</script>
  <script>var playerConfig = { file: '/movie.m3u8', autoplay: true };</script>
  <link rel="stylesheet" href="/site.css">
  <link rel="preload" as="script" href="https://ads.doubleclick.net/preload.js">
  <meta http-equiv="refresh" content="30;url=/next">
  <style>.hero{background:url('/img/hero.png')}</style>
</head>
<body class="ad-free">
  <div class="ad-slot">AD_SLOT_TEXT</div>
  <div id="div-gpt-ad-1">GPT_TEXT</div>
  <ins class="adsbygoogle">ADSENSE_TEXT</ins>
  <div class="ad-free">KEEP_TEXT</div>
  <div class="ad-player">PLAYER_WRAP_TEXT</div>
  <iframe width="300" height="250" src="https://ads.doubleclick.net/frame"></iframe>
  <iframe width="728" height="90" src="/banner-frame"></iframe>
  <iframe width="640" height="360" allowfullscreen src="/player-frame"></iframe>
  <iframe width="640" height="360" allowfullscreen src="${cdnBase}/embed/1"></iframe>
  <img src="/poster.jpg" alt="poster">
  <img src="${cdnBase}/img.png" alt="cdn">
  <img src="https://ads.doubleclick.net/pixel.gif" width="1" height="1" alt="">
  <img srcset="/small.jpg 480w, ${cdnBase}/img.png 800w" alt="srcset">
  <a href="/movie/2">Próximo</a>
  <a href="https://example.org/externo">Externo</a>
  <form action="/search" method="get"><input name="q"></form>
</body>
</html>`;
}

before(async () => {
  targetServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Set-Cookie', 'sess=abc; Domain=127.0.0.1; Path=/; HttpOnly');
      return res.end(htmlPage());
    }

    if (url.pathname === '/site.css') {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      return res.end(`@import "https://ads.doubleclick.net/ad.css";
.hero { background: url("../img/bg.png"); }
.font { src: url("${cdnBase}/font.woff2"); }
`);
    }

    if (url.pathname === '/legit.js') {
      res.setHeader('Content-Type', 'application/javascript');
      return res.end('window.__legit = true;');
    }

    if (url.pathname === '/poster.jpg') {
      res.setHeader('Content-Type', 'image/jpeg');
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }

    if (url.pathname === '/small.jpg') {
      res.setHeader('Content-Type', 'image/jpeg');
      return res.end(Buffer.from([1, 2, 3]));
    }

    if (url.pathname === '/img/hero.png' || url.pathname === '/img/bg.png') {
      res.setHeader('Content-Type', 'image/png');
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }

    if (url.pathname === '/video.bin') {
      const data = Buffer.from('0123456789');
      const range = String(req.headers.range || '');
      const match = range.match(/bytes=(\d+)-(\d+)?/);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : data.length - 1;
        res.statusCode = 206;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`);
        return res.end(data.subarray(start, end + 1));
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      return res.end(data);
    }

    if (url.pathname === '/playlist.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXT-X-MAP:URI="init.mp4"
seg0.ts
${cdnBase}/seg1.ts
`);
    }

    if (url.pathname === '/banner-frame') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><html><body>BANNER AD</body></html>');
    }

    if (url.pathname === '/player-frame') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><html><head><script src="https://ads.doubleclick.net/frame-ad.js"></script></head><body><div class="player">PLAYER_FRAME</div></body></html>`);
    }

    if (url.pathname === '/go') {
      res.statusCode = 302;
      res.setHeader('Location', '/final');
      return res.end();
    }

    if (url.pathname === '/go-cdn') {
      res.statusCode = 302;
      res.setHeader('Location', `${cdnBase}/embed/1`);
      return res.end();
    }

    if (url.pathname === '/final') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><html><body>FINAL_PAGE</body></html>');
    }

    if (url.pathname === '/cookie') {
      res.setHeader('Set-Cookie', 'sess=abc; Domain=127.0.0.1; Path=/; HttpOnly');
      res.setHeader('Content-Type', 'text/plain');
      return res.end('cookie');
    }

    if (url.pathname === '/echo') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        );
      });
      return;
    }

    if (url.pathname === '/gzip') {
      const body = zlib.gzipSync('<!doctype html><html><body><script src="https://ads.doubleclick.net/gz.js"></script>GZIP_OK</body></html>');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', body.length);
      return res.end(body);
    }

    if (url.pathname === '/latin') {
      const body = Buffer.from('<!doctype html><html><head><meta charset="iso-8859-1"></head><body>ol\xe1</body></html>', 'latin1');
      res.setHeader('Content-Type', 'text/html; charset=iso-8859-1');
      return res.end(body);
    }

    if (url.pathname === '/base') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><html><head><base href="/sub/"></head><body><img src="pic.png"></body></html>');
    }

    if (url.pathname === '/adframe') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><html><body>AD</body></html>');
    }

    if (url.pathname === '/advanced') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<script src="/app.js" integrity="sha384-script"></script>
<link rel="stylesheet" href="/site.css" integrity="sha384-style">
</head><body>
<iframe class="player" srcdoc="<script src='https://ads.doubleclick.net/srcdoc.js'></script><div class='ad'>SRCDOC_AD</div>SRCDOC_OK"></iframe>
<div background="${cdnBase}/img.png">BG</div>
</body></html>`);
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('not found');
  });

  cdnServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/lib.js') {
      res.setHeader('Content-Type', 'application/javascript');
      return res.end('window.__cdn = true;');
    }
    if (url.pathname === '/img.png') {
      res.setHeader('Content-Type', 'image/png');
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    }
    if (url.pathname === '/font.woff2') {
      res.setHeader('Content-Type', 'font/woff2');
      return res.end(Buffer.from([4, 5, 6]));
    }
    if (url.pathname === '/api') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ cookie: req.headers.cookie || null, referer: req.headers.referer || null }));
    }
    if (url.pathname === '/embed/1') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      return res.end(`<!doctype html><html><head><script src="https://ads.doubleclick.net/player-ad.js"></script></head><body><div id="player">PLAYER_CDN</div><script>var playerOk = true;</script></body></html>`);
    }
    res.statusCode = 404;
    res.end('cdn not found');
  });

  targetBase = await listen(targetServer);
  cdnBase = await listen(cdnServer);

  config = loadConfig({
    TARGET_ORIGIN: targetBase,
    PROXY_SECRET: 'test-secret-'.padEnd(64, 'x'),
    ALLOW_PRIVATE_UPSTREAMS: 'true',
    DEBUG: '0',
    EXTRA_PLAYER_HOSTS: '127.0.0.1'
  });

  const app = createApp(config);
  proxyServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => proxyServer.once('listening', resolve));
  proxyBase = `http://127.0.0.1:${proxyServer.address().port}`;

  const configProxied = {
    ...config,
    proxyPlayerIframes: true,
    secret: 'test-secret-proxied'.padEnd(64, 'y')
  };
  const appProxied = createApp(configProxied);
  proxyServerProxiedIframes = appProxied.listen(0, '127.0.0.1');
  await new Promise((resolve) => proxyServerProxiedIframes.once('listening', resolve));
  proxyProxiedBase = `http://127.0.0.1:${proxyServerProxiedIframes.address().port}`;
});

after(async () => {
  await Promise.all([
    close(proxyServer),
    close(proxyServerProxiedIframes),
    close(targetServer),
    close(cdnServer)
  ]);
});

test('health responde e informa o alvo', async () => {
  const response = await fetch(`${proxyBase}/_adshield/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.target, targetBase);
});

test('sem TARGET_ORIGIN o health falha e mostra a página de configuração', async () => {
  const appNoTarget = createApp({ ...config, target: null, targetOrigin: null });
  const server = appNoTarget.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/_adshield/health`);
    assert.equal(health.status, 503);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 503);
    assert.match(await page.text(), /TARGET_ORIGIN/);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test('página é sanitizada, recursos são reescritos e headers perigosos somem', async () => {
  const response = await fetch(`${proxyBase}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), null);
  assert.equal(response.headers.get('content-security-policy'), null);
  assert.equal(response.headers.get('cross-origin-opener-policy'), null);
  assert.match(response.headers.get('content-type'), /text\/html; charset=utf-8/);
  assert.match(response.headers.get('x-adshield-removed'), /scripts=/);

  const html = await response.text();
  assert.doesNotMatch(html, /ads\.doubleclick\.net\/ad\.js/);
  assert.doesNotMatch(html, /preload\.js/);
  assert.doesNotMatch(html, /window\.open\('https:\/\/ad\.example\/popup'\)/);
  assert.doesNotMatch(html, /canRunAds !== true/);
  assert.doesNotMatch(html, /AD_SLOT_TEXT/);
  assert.doesNotMatch(html, /GPT_TEXT/);
  assert.doesNotMatch(html, /ADSENSE_TEXT/);
  assert.doesNotMatch(html, /pixel\.gif/);
  assert.match(html, /KEEP_TEXT/);
  assert.match(html, /PLAYER_WRAP_TEXT/);
  assert.match(html, /adshield-runtime/);
  assert.ok(html.toLowerCase().indexOf('charset') < 1024, 'meta charset deve ficar nos primeiros 1024 bytes');
  assert.match(html, /var playerConfig/);
  assert.match(html, /src="\/player-frame"/);
  assert.match(html, new RegExp(`src="${cdnBase.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/embed/1"`.replace(/\\\\/g, '\\')));
  assert.match(html, /src="\/poster\.jpg"/);
  assert.match(html, /href="\/movie\/2"/);
  assert.match(html, /href="https:\/\/example\.org\/externo"/);
  assert.match(html, /href="\/site\.css"/);
  assert.match(html, /content="30;url=\/next"/);
  assert.match(html, /\/_adshield\/r\//);

  const cookie = response.headers.getSetCookie().find((item) => item.startsWith('sess='));
  assert.ok(cookie);
  assert.doesNotMatch(cookie, /Domain=/i);
});

test('CSS reescreve url() e remove import de anúncio', async () => {
  const response = await fetch(`${proxyBase}/site.css`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/css; charset=utf-8/);
  const css = await response.text();
  assert.match(css, /url\("\/img\/bg\.png"\)/);
  assert.doesNotMatch(css, /ads\.doubleclick\.net/);
  assert.match(css, /\/_adshield\/r\//);
});

test('recurso cross-origin é servido pelo token assinado', async () => {
  const html = await (await fetch(`${proxyBase}/`)).text();
  const tokens = [...html.matchAll(/\/_adshield\/r\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  assert.ok(tokens.length >= 2);

  const image = await fetch(`${proxyBase}/_adshield/r/${tokens.find((token) => token.length > 100)}`);
  assert.equal(image.status, 200);
  assert.ok((await image.arrayBuffer()).byteLength > 0);

  const token = tokens[0];
  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  const denied = await fetch(`${proxyBase}/_adshield/r/${tampered}`);
  assert.equal(denied.status, 403);
});

test('token de domínio de anúncio retorna 204 sem buscar', async () => {
  const token = signUrl('https://ads.doubleclick.net/banner.js', targetBase, config);
  const response = await fetch(`${proxyBase}/_adshield/r/${token}`);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('x-adshield-blocked'), 'ad-domain');
});

test('SSRF: IP privado fora do alvo é rejeitado', async () => {
  await assert.rejects(
    () => assertSafeDestination('http://127.0.0.1:9/private', { ...config, allowPrivateUpstreams: false, targetOrigin: 'https://example.com' }),
    /privado|IP privado/
  );
  await assert.rejects(
    () => assertSafeDestination('http://localhost:9/private', { ...config, allowPrivateUpstreams: false, targetOrigin: 'https://example.com' }),
    /privado|IP privado/
  );
});

test('iframe de player de terceiro fica direto por padrão', async () => {
  const html = await (await fetch(`${proxyBase}/`)).text();
  assert.match(html, new RegExp(`${cdnBase.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/embed/1`));
});

test('com PROXY_PLAYER_IFRAMES=1, o player é proxiado e sanitizado', async () => {
  const html = await (await fetch(`${proxyProxiedBase}/`)).text();
  const iframe = html.match(/<iframe[^>]+src="(\/_adshield\/r\/[^"]+)"[^>]*>/);
  assert.ok(iframe);
  const player = await fetch(`${proxyProxiedBase}${iframe[1]}`);
  assert.equal(player.status, 200);
  const playerHtml = await player.text();
  assert.match(playerHtml, /PLAYER_CDN/);
  assert.doesNotMatch(playerHtml, /player-ad\.js/);
  assert.equal(player.headers.get('x-frame-options'), null);
});

test('Range e streaming binário passam pelo proxy', async () => {
  const response = await fetch(`${proxyBase}/video.bin`, {
    headers: { Range: 'bytes=2-5' }
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), '2345');
});

test('playlist HLS tem segmentos, chave e init reescritos', async () => {
  const response = await fetch(`${proxyBase}/playlist.m3u8`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /mpegurl/);
  const text = await response.text();
  assert.match(text, /URI="\/_adshield\/r\//);
  const lines = text.split('\n').filter((line) => line && !line.startsWith('#'));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.startsWith('/_adshield/r/')));
});

test('redirecionamento é local e o HTML final é sanitizado', async () => {
  const redirect = await fetch(`${proxyBase}/go`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/final');

  const response = await fetch(`${proxyBase}/go`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /FINAL_PAGE/);
});

test('redirecionamento cross-origin vira token e o player é sanitizado', async () => {
  const redirect = await fetch(`${proxyBase}/go-cdn`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.get('location'), /^\/_adshield\/r\//);

  const final = await fetch(`${proxyBase}/go-cdn`);
  assert.equal(final.status, 200);
  const html = await final.text();
  assert.match(html, /PLAYER_CDN/);
  assert.doesNotMatch(html, /player-ad\.js/);
});

test('gzip do upstream é descomprimido e sanitizado', async () => {
  const response = await fetch(`${proxyBase}/gzip`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /GZIP_OK/);
  assert.doesNotMatch(html, /gz\.js/);
});

test('charset latin1 vira UTF-8 na saída', async () => {
  const response = await fetch(`${proxyBase}/latin`);
  const html = await response.text();
  assert.match(html, /olá/);
  assert.match(html, /charset="utf-8"/i);
  assert.doesNotMatch(html, /iso-8859-1/i);
});

test('meta CSP, SRI e srcdoc de anúncio são neutralizados', async () => {
  const html = await (await fetch(`${proxyBase}/advanced`)).text();
  assert.doesNotMatch(html, /Content-Security-Policy/i);
  assert.doesNotMatch(html, /integrity=/i);
  assert.doesNotMatch(html, /srcdoc\.js/);
  assert.doesNotMatch(html, /SRCDOC_AD/);
  assert.match(html, /SRCDOC_OK/);
  assert.match(html, /background="\/_adshield\/r\//);
});

test('@import cross-origin não recebe token duplicado', () => {
  const css = rewriteCss(
    '@import "https://cdn.example/a.css" screen; .x{background:url(https://cdn.example/b.png)}',
    `${targetBase}/site.css`,
    (raw, base) => rewriteUrl(raw, base, { config, mode: 'target', pageUrl: `${targetBase}/` }),
    {}
  );
  assert.equal((css.match(/_adshield\/r\//g) || []).length, 2);
  assert.doesNotMatch(css, /r\/[^")]+\/r\//);
});

test('srcset de anúncio não derruba a imagem com src válido', () => {
  const result = sanitizeHtml('<html><body><img src="/ok.png" srcset="https://ads.doubleclick.net/x.png 1x"></body></html>', {
    url: `${targetBase}/`,
    config,
    mode: 'target'
  });
  assert.match(result.html, /src="\/ok\.png"/);
  assert.doesNotMatch(result.html, /doubleclick/);
});

test('base do site é reescrita para continuar no proxy', async () => {
  const html = await (await fetch(`${proxyBase}/base`)).text();
  assert.match(html, /<base href="\/sub\/">/);
  assert.match(html, /src="\/sub\/pic\.png"/);
});

test('headers do navegador e cookies são encaminhados ao alvo', async () => {
  const response = await fetch(`${proxyBase}/echo`, {
    headers: { Cookie: 'foo=bar', Accept: 'application/json' }
  });
  const body = await response.json();
  assert.equal(body.headers.cookie, 'foo=bar');
  assert.ok([targetBase, `${targetBase}/`].includes(body.headers.referer));
  assert.match(body.headers['user-agent'], /Mozilla\/5\.0/);
});

test('POST é encaminhado com corpo e Origin do alvo', async () => {
  const response = await fetch(`${proxyBase}/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' })
  });
  const body = await response.json();
  assert.equal(body.method, 'POST');
  assert.equal(body.body, '{"hello":"world"}');
  assert.equal(body.headers.origin, targetBase);
});

test('cookie não vaza para recurso cross-origin', async () => {
  const token = signUrl(`${cdnBase}/api`, targetBase, config);
  const response = await fetch(`${proxyBase}/_adshield/r/${token}`, {
    headers: { Cookie: 'foo=bar' }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.cookie, null);
  assert.ok([targetBase, `${targetBase}/`].includes(body.referer));
});
