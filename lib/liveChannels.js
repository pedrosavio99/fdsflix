'use strict';

/**
 * fdsFlix - Catálogo de TV ao vivo.
 *
 * Aqui ficam só os CANAIS (nome, grupo, apelidos para achar o canal dentro de listas .m3u). As FONTES de cada
 * canal (URLs, listas para varredura e hosts de páginas de player) vivem empacotadas em lib/liveSources.packed.js,
 * gerado por scripts/live-pack.js a partir de lib/live-sources.plain.json (que não vai para o Git).
 *
 * Para editar as fontes:  node scripts/live-pack.js --unpack   (gera o .plain.json)
 *                         edite o .plain.json
 *                         node scripts/live-pack.js            (gera o .packed.js de novo)
 *
 * Cada canal tem uma lista ORDENADA de fontes candidatas (a cascata de TV ao vivo, independente da cascata de
 * filmes). O servidor testa as fontes, usa a primeira que responde e guarda o resultado por alguns minutos
 * (lib/liveTv.js). Fontes de IPTV morrem e mudam o tempo todo: o arquivo é só a semente.
 */

const zlib = require('zlib');
const packed = require('./liveSources.packed');

const DATA = JSON.parse(zlib.inflateRawSync(Buffer.from(packed, 'base64')).toString('utf8'));

const META = [
  { id: 'sportv', name: 'SporTV', group: 'Esportes', aliases: ['sportv', 'sportv hd', 'sportv 1'] },
  { id: 'espn', name: 'ESPN Brasil', group: 'Esportes', aliases: ['espn', 'espn brasil', 'espn hd', 'espn 1'] },
  { id: 'espn2', name: 'ESPN 2', group: 'Esportes', aliases: ['espn 2', 'espn2', 'espn 2 hd'] },
  { id: 'espn3', name: 'ESPN 3', group: 'Esportes', aliases: ['espn 3', 'espn3'] },
  { id: 'espn4', name: 'ESPN 4', group: 'Esportes', aliases: ['espn 4', 'espn4'] },
  { id: 'sportv3', name: 'SporTV 3', group: 'Esportes', aliases: ['sportv 3', 'sportv3'] },
  { id: 'premiere', name: 'Premiere', group: 'Esportes', aliases: ['premiere', 'premiere clubes', 'premiere fc'] },
  { id: 'combate', name: 'Combate', group: 'Esportes', aliases: ['combate'] },
  { id: 'foxsports', name: 'Fox Sports', group: 'Esportes', aliases: ['fox sports', 'foxsports'] },
  { id: 'bandsports', name: 'Band Sports', group: 'Esportes', aliases: ['band sports', 'bandsports'] },
  { id: 'telecine', name: 'Telecine', group: 'Filmes e séries', aliases: ['telecine', 'telecine premium', 'telecine pipoca', 'telecine action'] },
  { id: 'axn', name: 'AXN', group: 'Filmes e séries', aliases: ['axn', 'axn hd'] },
  { id: 'studiouniversal', name: 'Studio Universal', group: 'Filmes e séries', aliases: ['studio universal'] },
  { id: 'tbs', name: 'TBS', group: 'Filmes e séries', aliases: ['tbs'] },
  { id: 'space', name: 'Space', group: 'Filmes e séries', aliases: ['space'] },
  { id: 'syfy', name: 'Syfy', group: 'Filmes e séries', aliases: ['syfy'] },
  { id: 'discoverykids', name: 'Discovery Kids', group: 'Infantil e docs', aliases: ['discovery kids'] },
  { id: 'cartoon', name: 'Cartoon Network', group: 'Infantil e docs', aliases: ['cartoon network', 'cartoon'] },
  { id: 'discovery', name: 'Discovery Channel', group: 'Infantil e docs', aliases: ['discovery channel', 'discovery'] },
  { id: 'globo', name: 'Globo (SP)', group: 'Canais abertos', aliases: ['globo', 'globo sp', 'tv globo'] },
  { id: 'sbt', name: 'SBT (SP)', group: 'Canais abertos', aliases: ['sbt', 'sbt sp'] },
  { id: 'record', name: 'Record (SP)', group: 'Canais abertos', aliases: ['record', 'record tv', 'record sp'] },
  { id: 'band', name: 'Band', group: 'Canais abertos', aliases: ['band', 'tv band', 'band sp'] },
  { id: 'redetv', name: 'RedeTV!', group: 'Canais abertos', aliases: ['redetv', 'rede tv'] },
  { id: 'cultura', name: 'TV Cultura', group: 'Canais abertos', aliases: ['cultura', 'tv cultura'] },
  { id: 'eimaxx2', name: 'EI Maxx 2', group: 'Filmes e séries', aliases: ['ei maxx 2', 'ei maxx2', 'eimaxx 2'] },
  { id: 'camara', name: 'TV Câmara', group: 'Educativos e variados', aliases: ['tv camara', 'camara dos deputados', 'camara tv'] },
  { id: 'paranaeducativa', name: 'TV Paraná Educativa', group: 'Educativos e variados', aliases: ['parana educativa', 'tv parana turismo', 'tv parana'] },
  { id: 'amazonsat', name: 'Amazon Sat', group: 'Educativos e variados', aliases: ['amazon sat', 'amazonsat'] },
  { id: 'cinemonde', name: 'CineMonde', group: 'Educativos e variados', aliases: ['cinemonde', 'cine monde'] },
  { id: 'darkflix', name: 'DarkFlix', group: 'Educativos e variados', aliases: ['darkflix', 'dark flix'] },
  { id: 'mil1noites', name: '1001 Noites', group: 'Educativos e variados', aliases: ['1001 noites'] },
  { id: 'adesso', name: 'Adesso TV', group: 'Educativos e variados', aliases: ['adesso tv', 'adesso'] },
  { id: 'telabrasil', name: 'Tela Brasil TV', group: 'Educativos e variados', aliases: ['tela brasil tv', 'tela brasil'] }
];

const CHANNELS = META.map((m) => ({ ...m, sources: (DATA.sources && DATA.sources[m.id]) || [] }));

/** Listas completas (.m3u) para varredura. */
const CATALOG_URLS = Array.isArray(DATA.catalogs) ? DATA.catalogs : [];

/** Hosts de PÁGINAS de player (HTML com o vídeo dentro) entregues pelo AdShield. */
const PAGE_HOSTS = Array.isArray(DATA.pageHosts) ? DATA.pageHosts : [];

module.exports = { CHANNELS, CATALOG_URLS, PAGE_HOSTS };
