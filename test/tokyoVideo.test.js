'use strict';

// Fonte "TokyVideo": API falsa (HTTP local) + TMDB falso. Nenhuma requisição sai para a internet.
//
// O que estes testes garantem:
//   - a fonte é opcional e não atrapalha quem não a ligou;
//   - o casamento inteligente aceita o filme inteiro e RECUSA trailer/clipe com o mesmo nome;
//   - em série ela devolve null sem gastar requisição;
//   - o resultado vem marcado para tocar direto no navegador (0 byte no Render).

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');

const tokyo = require('../lib/tokyoVideo');
const cascade = require('../lib/fallbackCascade');

let server;
let base;
let hits = { search: 0, meta: 0, media: 0 };

const VIDEOS = {
  // filme inteiro, 1h34m — bate com o runtime de 95 min do TMDB
  101: { title: 'The Stranger (1946) Full Movie', duration: '01:34:04' },
  // trailer: mesmo nome, 2min15
  102: { title: 'The Stranger (1946) Official Trailer', duration: '00:02:15' },
  // clipe com o nome exato do filme (a duração é quem salva)
  103: { title: 'The Stranger', duration: '00:02:31' },
  // banido
  104: { title: 'The Stranger (1946) Full Movie', duration: '01:34:04', banned: 1 }
};

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const send = (code, body) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };

    // --- TMDB falso ---
    if (path === '/movie/1') {
      return send(200, {
        title: 'The Stranger',
        original_title: 'The Stranger',
        runtime: 95,
        release_date: '1946-07-02'
      });
    }
    if (path === '/movie/1/alternative_titles') {
      return send(200, { titles: [{ title: 'El extraño' }] });
    }

    // --- busca do site ---
    if (path === '/search-ajax') {
      hits.search += 1;
      return send(200, {
        results: [
          {
            text: 'Video results',
            children: [
              { type: 'serie', name: 'Serie qualquer', thumb: 'https://img.example/series/thumbs/x.jpg' },
              { type: 'video', title: 'The Stranger (1946) Official Trailer', thumb: 'https://img.example/videos/1/102/thumbs/a.jpg' },
              { type: 'video', title: 'The Stranger', thumb: 'https://img.example/videos/1/103/thumbs/b.jpg' },
              { type: 'video', title: 'The Stranger (1946) Full Movie', thumb: 'https://img.example/videos/1/101/thumbs/c.jpg' },
              { type: 'video', title: 'The Stranger (1946) Full Movie', thumb: 'https://img.example/videos/1/104/thumbs/d.jpg' }
            ]
          }
        ]
      });
    }

    // --- metadados do vídeo ---
    const meta = path.match(/^\/video\/(\d+)$/);
    if (meta) {
      hits.meta += 1;
      const video = VIDEOS[meta[1]];
      if (!video) return send(404, { message: '' });
      return send(200, {
        error: false,
        result: 'ok',
        video: {
          id: Number(meta[1]),
          title: video.title,
          duration: video.duration,
          banned: video.banned ? 1 : 0,
          private: 0,
          liveStream: 0,
          channelName: 'cinetel',
          thumb: 'https://img.example/t.jpg',
          url: `/video/teste-${meta[1]}`,
          videoFileUrl: `${base}/media/${meta[1]}.mp4?secure=abc`
        }
      });
    }

    // --- arquivo de vídeo (só o primeiro byte importa) ---
    if (/^\/media\/\d+\.mp4$/.test(path)) {
      hits.media += 1;
      res.statusCode = 206;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Range', 'bytes 0-0/1000');
      return res.end('x');
    }

    return send(404, { message: '' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.TOKYOVIDEO_API_BASE = base;
  process.env.TMDB_API_BASE = base;
  process.env.TMDB_API_KEY = 'chave-de-teste';
  delete process.env.TOKYOVIDEO_ENABLED;
});

after(() => new Promise((resolve) => server.close(resolve)));

/* ------------------------------------------------------------------ */
/* Peças soltas                                                        */
/* ------------------------------------------------------------------ */

test('duração: entende "H:MM:SS" e "MM:SS"', () => {
  assert.equal(tokyo.parseDuration('01:34:04'), 5644);
  assert.equal(tokyo.parseDuration('02:04'), 124);
  assert.equal(tokyo.parseDuration('00:00'), 0);
  assert.equal(tokyo.parseDuration(''), 0);
});

test('título: tira ruído e ano, mas mantém o nome', () => {
  assert.equal(tokyo.normTitle('The Stranger (1946) Full Movie'), 'the stranger');
  assert.equal(tokyo.normTitle('O Poderoso Chefão (1972) Dublado'), 'o poderoso chefao');
  assert.equal(tokyo.yearOf('The Stranger (1946) Full Movie'), 1946);
  assert.equal(tokyo.yearOf('The Stranger'), 0);
});

test('semelhança: exato > começa com > contém > nada', () => {
  assert.equal(tokyo.titleScore('The Stranger', 'The Stranger (1946) Full Movie'), 100);
  assert.equal(tokyo.titleScore('The Stranger', 'The Stranger 2'), 84);
  assert.ok(tokyo.titleScore('The Stranger', 'The Stranger - comentado') >= 62);
  assert.equal(tokyo.titleScore('The Stranger', 'Deadpool 2'), 0);
});

test('duração: filme passa, trailer e clipe não', () => {
  const runtime = 95 * 60;
  assert.equal(tokyo.durationFits(5644, runtime), true); // 94 min
  assert.equal(tokyo.durationFits(135, runtime), false); // trailer de 2 min
  assert.equal(tokyo.durationFits(0, runtime), false);
  assert.equal(tokyo.durationFits(50 * 60, 0), true); // sem runtime no TMDB: 40 min+ basta
});

test('material extra: trailer, clipe, entrevista', () => {
  assert.equal(tokyo.looksLikeExtra('The Stranger (1946) Official Trailer'), true);
  assert.equal(tokyo.looksLikeExtra('Entrevista com o diretor'), true);
  assert.equal(tokyo.looksLikeExtra('The Stranger (1946) Full Movie'), false);
});

test('id do vídeo sai da miniatura', () => {
  assert.equal(tokyo.videoIdFromThumb('https://img3.tokyvideo.com/videos/392/39234/thumbs/a.jpg'), '39234');
  assert.equal(tokyo.videoIdFromThumb('https://img.example/series/thumbs/a.jpg'), null);
});

/* ------------------------------------------------------------------ */
/* Cascata                                                             */
/* ------------------------------------------------------------------ */

test('a fonte aparece no fim da cascata, antes do "Dublado PT"', () => {
  process.env.TOKYOVIDEO_ENABLED = '1';
  process.env.PT_DUB_API_BASE = 'http://127.0.0.1:9';
  try {
    const list = cascade.getProviderList().map((p) => p.name);
    assert.ok(list.includes('TokyVideo'));
    assert.equal(list[list.length - 1], 'Dublado PT');
    // Fim da cascata: TokyVideo → Internet Archive → PeerTube → BitChute → Dublado PT.
    assert.deepEqual(list.slice(-5), ['TokyVideo', 'Internet Archive', 'PeerTube', 'BitChute', 'Dublado PT']);
  } finally {
    delete process.env.PT_DUB_API_BASE;
    delete process.env.TOKYOVIDEO_ENABLED;
  }
});

test('TOKYOVIDEO_ENABLED=0 tira a fonte da cascata', () => {
  process.env.TOKYOVIDEO_ENABLED = '0';
  try {
    assert.equal(tokyo.isEnabled(), false);
    assert.equal(cascade.getProviderList().some((p) => p.name === 'TokyVideo'), false);
  } finally {
    delete process.env.TOKYOVIDEO_ENABLED;
  }
});

test('série não gasta requisição (fora do escopo desta versão)', async () => {
  const before = { ...hits };
  const out = await tokyo.findMovieStream({ id: 1, type: 'tv', season: 1, episode: 1, title: 'The Stranger' });
  assert.equal(out, null);
  assert.deepEqual(hits, before);
});

/* ------------------------------------------------------------------ */
/* Casamento inteligente                                               */
/* ------------------------------------------------------------------ */

test('filme inteiro: devolve o MP4 marcado para tocar direto no navegador', async () => {
  const notes = [];
  const out = await tokyo.findMovieStream({
    id: 1,
    type: 'movie',
    title: 'The Stranger',
    note: (m) => notes.push(m)
  });

  assert.ok(out, 'deveria achar o filme');
  assert.equal(out.provider, 'TokyVideo');
  assert.equal(out.browserDirect, true);
  assert.equal(out.isHls, false);
  assert.match(out.url, /\/media\/101\.mp4\?secure=/);
  assert.deepEqual(out.captions, []);
  // O trailer (102) e o clipe de 2 min (103) ficam de fora; o banido (104) também.
  assert.ok(notes.some((n) => /material extra|duração .* não confere|indisponível/.test(n)), notes.join(' | '));
});

test('o relatório da última tentativa registra o escolhido (sem URLs)', async () => {
  await tokyo.findMovieStream({ id: 1, type: 'movie', title: 'The Stranger' });
  const report = tokyo.getReport();
  assert.ok(report);
  assert.equal(report.ok, true);
  assert.ok(!JSON.stringify(report.etapas).includes('http'), 'o relatório não deve expor URLs');
});

/* ------------------------------------------------------------------ */
/* Painel do admin: busca livre e abrir um vídeo do acervo              */
/* ------------------------------------------------------------------ */

test('busca do painel: lista com duração, canal e marca de filme', async () => {
  const data = await tokyo.searchVideos('the stranger');
  assert.equal(data.error, null);
  assert.ok(data.results.length >= 3);
  const filme = data.results.find((r) => r.id === '101');
  assert.ok(filme);
  assert.equal(filme.full, true);
  assert.equal(filme.minutes, 94);
  assert.equal(filme.playable, true);
  assert.equal(filme.channel, 'cinetel');
  assert.match(filme.page, /^https:\/\/www\.tokyvideo\.com\/video\/teste-101$/);
  // O trailer (2 min) não é marcado como filme.
  const trailer = data.results.find((r) => r.id === '102');
  assert.equal(trailer.full, false);
});

test('abrir um vídeo do acervo devolve o MP4 assinado', async () => {
  const out = await tokyo.streamById('101');
  assert.equal(out.error, undefined);
  assert.match(out.url, /\/media\/101\.mp4\?secure=/);
  assert.equal(out.codec, 'h264');
  assert.equal(out.duration, '01:34:04');
});

test('abrir um vídeo banido ou com id inválido não devolve URL', async () => {
  const banido = await tokyo.streamById('104');
  assert.ok(banido.error);
  assert.equal(banido.url, undefined);

  const invalido = await tokyo.streamById('../../etc/passwd');
  assert.ok(invalido.error);
});

test('busca vazia é recusada sem chamar a rede', async () => {
  const before = { ...hits };
  const data = await tokyo.searchVideos('   ');
  assert.ok(data.error);
  assert.deepEqual(hits, before);
});

test('busca a partir do filme aberto: usa a duração do TMDB e marca o que confere', async () => {
  const data = await tokyo.searchVideos('The Stranger', { id: 1, type: 'movie' });
  assert.equal(data.error, null);
  assert.equal(data.runtimeMinutes, 95);
  const filme = data.results.find((r) => r.id === '101');
  assert.equal(filme.matchesRuntime, true);
  const trailer = data.results.find((r) => r.id === '102');
  assert.equal(trailer.matchesRuntime, false);
  // O que confere com o filme vem primeiro.
  assert.equal(data.results[0].id, '101');
});

test('busca a partir de série não inventa duração de filme', async () => {
  const data = await tokyo.searchVideos('The Stranger', { id: 1, type: 'tv' });
  assert.equal(data.runtimeMinutes, 0);
  assert.ok(data.results.every((r) => r.matchesRuntime === null));
});

/* ------------------------------------------------------------------ */
/* Índice dos canais (o acervo): casa título + duração                  */
/* ------------------------------------------------------------------ */

const acervo = [
  { id: '905629', title: 'Um Sonho De Liberdade 1994', durationSec: 8553, duration: '02:22:33', minutes: 143, channel: 'ULTRA IMAX', thumb: '', page: '' },
  { id: '922130', title: 'Um Mundo Perfeito 1993', durationSec: 8294, duration: '02:18:14', minutes: 138, channel: 'ULTRA IMAX', thumb: '', page: '' },
  { id: '1', title: 'Um Sonho de Liberdade - Trailer', durationSec: 120, duration: '02:00', minutes: 2, channel: 'x', thumb: '', page: '' }
];

test('acervo: acha o filme pelo título em pt-BR e confirma pela duração', () => {
  const hits = tokyo.searchCatalog(acervo, ['Um Sonho de Liberdade'], 142 * 60, 1994);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, '905629');
});

test('acervo: sem a duração certa não devolve o trailer', () => {
  // O trailer só bateria se o runtime fosse de 2 min; com 142 min ele cai fora.
  const hits = tokyo.searchCatalog(acervo, ['Um Sonho de Liberdade'], 142 * 60, 1994);
  assert.ok(hits.every((h) => h.id !== '1'));
});

test('acervo: título que não existe não vira resultado', () => {
  const hits = tokyo.searchCatalog(acervo, ['O Poderoso Chefão'], 175 * 60, 1972);
  assert.equal(hits.length, 0);
});
