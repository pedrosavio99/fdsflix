'use strict';

// Motor "Buscar na web": só as peças (parse das buscas e leitura da página). Sem rede.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const websearch = require('../lib/websearch');

test('consultas: "assistir <título> online grátis dublado" com o ano', () => {
  const q = websearch.buildQueries({ title: 'Vingadores: Ultimato', year: 2019, type: 'movie' });
  assert.ok(q.length >= 1);
  assert.match(q[0], /^assistir Vingadores\s+Ultimato 2019 online .*dublado/i);
});

test('consultas de série levam temporada e episódio', () => {
  const q = websearch.buildQueries({ title: 'Game of Thrones', type: 'tv', season: 2, episode: 5 });
  assert.ok(q.some((x) => /2 temporada 5 episodio/i.test(x)));
});

test('DuckDuckGo: lê o link real de dentro do ?uddg=', () => {
  const html = '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexemplo.com%2Ffilme%2F">Exemplo</a>';
  const out = websearch.parseDdg(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://exemplo.com/filme/');
});

test('Bing: abre o redirect ck/a (base64) e descarta o próprio bing', () => {
  const target = 'https://site.com/assistir-filme';
  const encoded = 'a1' + Buffer.from(target).toString('base64url');
  const html = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=${encoded}&amp;x=1">Site</a></h2></li>`;
  const out = websearch.parseBing(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, target);
});

test('página: pega data-tipo + data-url (dublado/legendado) e ignora miniatura', () => {
  const html = `
    <img data-url="https://cdn.site/thumb.jpg">
    <script data-src="https://cdn.site/app.js"></script>
    <button data-tipo="dublado" data-url="https://player.site/dub/299534">Dublado</button>
    <button data-tipo="legendado" data-url="https://player.site/leg/299534">Legendado</button>
    <iframe src="https://embed.site/e/299534"></iframe>
  `;
  const page = websearch.probeHtml(html, 'https://site.com/filme/x');
  assert.equal(page.options.length, 2);
  assert.equal(page.options[0].audio, 'dublado');
  assert.equal(page.options[1].audio, 'legendado');
  assert.deepEqual(page.iframes, ['https://embed.site/e/299534']);
});

test('página: acha arquivo de vídeo direto', () => {
  const page = websearch.probeHtml('<video src="https://cdn.site/filme.mp4?token=x"></video>', 'https://site.com/f');
  assert.equal(page.streams.length, 1);
  assert.match(page.streams[0], /\.mp4\?token=x$/);
});

test('site de crítica/loja não entra como fonte', () => {
  assert.ok(websearch.scoreResult({ url: 'https://www.adorocinema.com/filmes/filme-1/', title: 'x' }, 2019) < 0);
  assert.ok(websearch.scoreResult({ url: 'https://site.com/assistir-x-dublado', title: 'assistir x dublado' }, 2019) > 0);
});
