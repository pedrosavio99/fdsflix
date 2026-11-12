'use strict';

/**
 * fdsFlix - Catálogo de TV ao vivo.
 *
 * Cada canal tem uma lista ORDENADA de fontes candidatas (a cascata de TV ao vivo,
 * independente da cascata de filmes). O servidor testa as fontes, usa a primeira que
 * responde e guarda o resultado por alguns minutos (lib/liveTv.js).
 *
 * Fontes de IPTV morrem e mudam o tempo todo: este arquivo é só a semente. Para
 * somar fontes sem mexer no código:
 *   - LIVE_SOURCES_JSON  JSON {"sportv": ["url", ...], "espn": ["url"]} (entra ANTES da semente)
 *   - LIVE_CATALOG_URLS  listas .m3u para varrer (separadas por vírgula; padrão: iptv-org/br)
 *   - LIVE_SCAN_CATALOGS=0 desliga a varredura de listas.
 *
 * `aliases` ajuda a achar o canal dentro das listas .m3u (nomes normalizados).
 */

const BR = 'Brasil';

const CHANNELS = [
  /* ------------------------------- Esportes ------------------------------- */
  {
    id: 'sportv', name: 'SporTV', group: 'Esportes', aliases: ['sportv', 'sportv hd', 'sportv 1'],
    sources: [
      'http://31.204.128.117:8081/live/sportv/playlist.m3u8',
      'http://tv.iptv5region.com:25461/live/leonardo123/leonardo123/15730.m3u8',
      'http://tv.iptv5region.com:25461/live/leonardo123/leonardo123/15731.m3u8',
      'http://tv.iptv5region.com:25461/live/leonardo123/leonardo123/15732.m3u8',
      'http://177.52.24.163/SPORTV-1-HD/index.m3u8',
      'https://12.supraisemotherfuckembedoffthenet.club/live/stream_name/chunks.m3u8',
      'https://12.supraisemotherfuckembedoffthenet.club/live2/stream_name/chunks.m3u8',
      'https://15.supraisemotherfuckembedoffthenet.club/live3/stream_name/chunks.m3u8',
      'https://live.futemax.tv/dvr/4fbf088a3e5f72e5d76b92168a976550/chunks.m3u8',
      'http://painel.ebanonet.com.br:25461/254126/254126/11006',
      'http://painel.ebanonet.com.br:25461/254126/254126/11008',
      'http://painel.ebanonet.com.br:25461/254126/254126/11007'
    ]
  },
  {
    id: 'espn', name: 'ESPN Brasil', group: 'Esportes', aliases: ['espn', 'espn brasil', 'espn hd', 'espn 1'],
    sources: [
      'http://31.204.128.117:8081/live/espnbr/playlist.m3u8',
      'http://edge.aovivo.club/hls/s:95.216.15.44:81/espnbrasil_2a459380_e97ff9064bdb4647780675d2107f3af4178865bd/playlist.m3u8',
      'http://190.102.43.113:80/Formigatv/offilinetv2806/1542273.m3u8',
      'https://cdn-3.nxplay.com.br/ESPN/tracks-v2a1/mono.m3u8',
      'https://cdn-4.nxplay.com.br/ESPN/tracks-v2a1/mono.m3u8',
      'http://46.151.196.223:14432/Espn',
      'http://s2.micineovs.com/ESPN1/index.m3u8?token=16FOTt9Ae2m8',
      'https://origin-fast.b-cdn.net/ESPN/tracks-v1a1/mono.ts.m3u8',
      'https://cdn-3.nxplay.com.br/ESPN/index.m3u8',
      'http://streamer.sattvacabo.com.br/ESPN_HD/index.m3u8?token=TLGacFXd0gIXIuo2u8Zj7f4FE5J2vtgf',
      'http://138.255.2.6:8084/ESPN/index.m3u8',
      'http://45.162.231.38:7779/ESPN/mpegts',
      'http://179.0.44.23:22080/ESPN/tracks-v2a1/mono.m3u8',
      'http://167.249.161.78:80/ESPN_BRASIL/index.m3u8',
      'http://138.204.86.4:8080/ESPN_HD/index.m3u8',
      'http://168.197.104.22/ESPN_BRASIL/tracks-v1a1/mono.ts.m3u8',
      'http://45.162.64.114:80/ESPN_BRASIL/index.m3u8',
      'http://212.5.144.156:8080/espn/index.m3u8',
      'https://tvsen5.aynaott.com/espn/index.m3u8',
      'http://iptv.wtf:8080/live/qkxocqmp/3XY9j7i4xf/16979.m3u8',
      'http://iptv.wtf:8080/live/qkxocqmp/3XY9j7i4xf/16972.m3u8',
      'http://iptv.wtf:8080/live/qkxocqmp/3XY9j7i4xf/16978.m3u8'
    ]
  },
  {
    id: 'espn2', name: 'ESPN 2', group: 'Esportes', aliases: ['espn 2', 'espn2', 'espn 2 hd'],
    sources: [
      'http://190.102.43.113:80/Formigatv/offilinetv2806/1542277.m3u8',
      'http://190.102.43.113:80/Formigatv/offilinetv2806/1542278.m3u8',
      'https://cdn-3.nxplay.com.br/ESPN_2/tracks-v2a1/mono.m3u8',
      'https://cdn-4.nxplay.com.br/ESPN_2/tracks-v2a1/mono.m3u8',
      'http://79.127.243.211:14506/Espn2',
      'http://46.151.196.223:14438/m3u8',
      'http://45.162.231.38:7779/ESPN_2/mpegts'
    ]
  },
  {
    id: 'espn3', name: 'ESPN 3', group: 'Esportes', aliases: ['espn 3', 'espn3'],
    sources: [
      'http://190.102.43.113/Formigatv/offilinetv2806/1542283.m3u8',
      'http://79.127.243.211:14510/Espn3'
    ]
  },
  {
    id: 'espn4', name: 'ESPN 4', group: 'Esportes', aliases: ['espn 4', 'espn4'],
    sources: [
      'http://190.102.43.113:80/Formigatv/offilinetv2806/1542281.m3u8',
      'http://190.102.43.113:80/Formigatv/offilinetv2806/1542282.m3u8',
      'http://79.127.243.211:14514/Espn4'
    ]
  },
  {
    id: 'sportv3', name: 'SporTV 3', group: 'Esportes', aliases: ['sportv 3', 'sportv3'],
    sources: [
      'https://02.arlivre.online/sportv3/index.m3u8',
      'https://sinalpublico.com/player3/ch.php?canal=SPORTV3'
    ]
  },
  {
    id: 'premiere', name: 'Premiere', group: 'Esportes', aliases: ['premiere', 'premiere clubes', 'premiere fc'],
    sources: [
      'http://31.204.128.117:8081/live/pfc/playlist.m3u8',
      'http://edge.aovivo.club/hls/s:95.216.15.44:81/premiereclubes_3f1522d0_bd2f4ec773c6341609182d5eedecb6317fdba8c9/playlist.m3u8',
      'http://painel.ebanonet.com.br:25461/254126/254126/11201',
      'http://painel.ebanonet.com.br:25461/254126/254126/11012',
      'http://painel.ebanonet.com.br:25461/254126/254126/11206',
      'http://177.52.24.163/PREMIERE-1-HD/index.m3u8',
      'http://f.lpstreen.shop/live/184486/357456/38.m3u8',
      'https://02.arlivre.online/pre1/index.m3u8',
      'http://egecalu.online/live/861970655/687908312/bbce09d9-4cb5-4f4e-911e-5b0ebf869683.ts'
    ]
  },
  {
    // A lista original traz só "http://31.204.128.117:8081/live"; o nome do caminho é inferido
    // pelo padrão das outras (sportv, espnbr, pfc...). O teste de saúde descarta se não existir.
    id: 'combate', name: 'Combate', group: 'Esportes', aliases: ['combate'],
    sources: [
      'http://31.204.128.117:8081/live/combate/playlist.m3u8',
      'https://sinalpublico.com/player3/ch.php?canal=COMBATE'
    ]
  },
  {
    id: 'foxsports', name: 'Fox Sports', group: 'Esportes', aliases: ['fox sports', 'foxsports'],
    sources: [
      'https://origin.futebolplay.net/privado/foxsports/playlist.m3u8',
      'https://ul.cdn574.net:8443/hls/lqrxwxkt9r6.m3u8'
    ]
  },
  {
    id: 'bandsports', name: 'Band Sports', group: 'Esportes', aliases: ['band sports', 'bandsports'],
    sources: [
      'http://ev.mm.uol.com.br:1935/geobband/operadoras/playlist.m3u8',
      'https://cdn-5.nxplay.com.br/BAND_SPORTS/index.m3u8',
      'https://sinalpublico.com/player3/ch.php?canal=BANDSPORTS'
    ]
  },

  /* --------------------------- Filmes e séries ---------------------------- */
  {
    // Na lista original este grupo ("Telecine") aponta para .../live/fox/...; o rótulo pode estar
    // trocado. Confira na tela qual canal abriu.
    id: 'telecine', name: 'Telecine', group: 'Filmes e séries', aliases: ['telecine', 'telecine premium', 'telecine pipoca', 'telecine action'],
    sources: [
      'http://31.204.128.117:8081/live/fox/playlist.m3u8',
      'http://painel.ebanonet.com.br:25461/254126/254126/11002',
      'http://painel.ebanonet.com.br:25461/254126/254126/11001',
      'http://177.52.24.163/TELECINE-PREMIUM-HD/index.m3u8',
      'http://190.102.43.113:80/Formigatv/offilinetv2806/320584.m3u8'
    ]
  },
  {
    id: 'axn', name: 'AXN', group: 'Filmes e séries', aliases: ['axn', 'axn hd'],
    sources: ['http://187.120.222.12:8000/play/AXNLEG/index.m3u8']
  },
  {
    id: 'studiouniversal', name: 'Studio Universal', group: 'Filmes e séries', aliases: ['studio universal'],
    sources: ['http://tv.iptv5region.com:25461/live/leonardo123/leonardo123/15714.m3u8']
  },
  {
    id: 'tbs', name: 'TBS', group: 'Filmes e séries', aliases: ['tbs'],
    sources: ['http://tv.iptv5region.com:25461/live/leonardo123/leonardo123/1758.m3u8']
  },
  {
    id: 'space', name: 'Space', group: 'Filmes e séries', aliases: ['space'],
    sources: ['http://painel.ebanonet.com.br:25461/254126/254126/11009']
  },
  {
    id: 'syfy', name: 'Syfy', group: 'Filmes e séries', aliases: ['syfy'],
    sources: ['http://painel.ebanonet.com.br:25461/254126/254126/11186']
  },

  /* ------------------------ Infantil e documentários ----------------------- */
  {
    id: 'discoverykids', name: 'Discovery Kids', group: 'Infantil e docs', aliases: ['discovery kids'],
    sources: ['http://31.204.128.117:8081/live/discoverykids/playlist.m3u8']
  },
  {
    id: 'cartoon', name: 'Cartoon Network', group: 'Infantil e docs', aliases: ['cartoon network', 'cartoon'],
    sources: ['http://31.204.128.117:8081/live/cartoon/playlist.m3u8']
  },
  {
    id: 'discovery', name: 'Discovery Channel', group: 'Infantil e docs', aliases: ['discovery channel', 'discovery'],
    sources: [
      'http://208.86.19.13:8080/live/31.stream/index.m3u8',
      'http://206.1.95.14:8001/play/discoverychannel'
    ]
  },

  /* ------------------------------- Abertos -------------------------------- */
  {
    id: 'globo', name: 'Globo (SP)', group: 'Canais abertos', aliases: ['globo', 'globo sp', 'tv globo'],
    sources: ['http://edge.aovivo.club/hls/s:95.216.15.44:81/globosp_cfe21c68_ae77192b764c4016210c95ee3850cfb220560fb1/playlist.m3u8']
  },
  {
    id: 'sbt', name: 'SBT (SP)', group: 'Canais abertos', aliases: ['sbt', 'sbt sp'],
    sources: ['http://edge.aovivo.club/hls/s:155.138.226.22/sbtsp_2a5ac580_cfcd585df429abb7530363e49db0a7218c392749/410p/chunklist.m3u8']
  },
  {
    id: 'record', name: 'Record (SP)', group: 'Canais abertos', aliases: ['record', 'record tv', 'record sp'],
    sources: ['http://edge.aovivo.club/hls/s:155.138.226.22/record_3554dce5_cb5601335808352af65e2c46f20938d4a651dfca/410p/chunklist.m3u8']
  },
  {
    id: 'band', name: 'Band', group: 'Canais abertos', aliases: ['band', 'tv band', 'band sp'],
    sources: ['http://edge.aovivo.club/hls/s:95.216.15.44:81/band_49e3d046_013ef6d0dbd6edf5c873c76a8bb1811da6e230a8/playlist.m3u8']
  },
  {
    id: 'redetv', name: 'RedeTV!', group: 'Canais abertos', aliases: ['redetv', 'rede tv'],
    sources: ['https://evpp.mm.uol.com.br/redetv1/redetv1/chunklist_w948294382.m3u8']
  },
  {
    id: 'cultura', name: 'TV Cultura', group: 'Canais abertos', aliases: ['cultura', 'tv cultura'],
    sources: ['https://5b33b873179a2.streamlock.net:1443/live/livestream/chunklist_w573518626.m3u8']
  }
];

/** Listas completas para varredura (catálogos .m3u). Só as que aparecem aqui são lidas. */
const CATALOG_URLS = [
  'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/br.m3u',
  'https://gistpad.com/raw/tv-85132-8',
  'https://gistpad.com/raw/tv-53024-5',
  'https://pastebin.com/raw/jyi3Fw29',
  'https://pastebin.com/raw/2Y5DVu9G',
  'https://pastebin.com/raw/wMbiS13F',
  'https://pastebin.com/raw/ajjCqZdd',
  'https://pastebin.com/raw/0bNsquXr',
  'https://pastebin.com/raw/XwErKabT'
];

module.exports = { CHANNELS, CATALOG_URLS, REGION: BR };
