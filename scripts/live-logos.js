#!/usr/bin/env node
'use strict';

/**
 * fdsFlix - gera lib/liveLogos.json (logo de cada canal da TV ao vivo).
 *
 * Roda NA SUA MÁQUINA, uma vez (ou quando entrar canal novo); o servidor só lê o JSON pronto, então não há custo no Render.
 *   node scripts/live-logos.js            baixa o catálogo do iptv-org (channels.json + logos.json, uns 14 MB), escolhe a logo
 *                                         de cada canal, confere que a imagem carrega e mede a cor dela com o ffmpeg
 *   node scripts/live-logos.js <pasta>    usa channels.json e logos.json já baixados nessa pasta
 *
 * Saída: { "<id do canal>": { u: "<url da logo>", a: ["#cor1", "#cor2"], d: "#fundo escuro" } }
 *   u  logo (o NAVEGADOR baixa direto do host de origem, nada passa pelo Render)
 *   a  fundo do cartão: claro se a logo é escura, escuro se a logo é clara (sempre legível)
 *   d  versão escura da cor da marca, para o destaque e o modal
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const API = 'https://iptv-org.github.io/api/';
const OUT = path.join(__dirname, '..', 'lib', 'liveLogos.json');

/** id do fdsFlix -> id do canal no catálogo do iptv-org (a escolha do canal certo é manual, para não pegar homônimo). */
const IDS = {
  sportv: 'SporTV.br', espn: 'ESPN.br', espn2: 'ESPN2.us', espn3: 'ESPN3.br', espn4: 'ESPN4.br',
  sportv2: 'SporTV2.br', sportv3: 'SporTV3.br', premiere: 'PremiereClubes.br', combate: 'Combate.br',
  foxsports: 'FoxSports.ar', bandsports: 'BandSports.br',
  telecine: 'TelecinePremium.br', axn: 'AXN.br', studiouniversal: 'StudioUniversalLatinAmerica.us', tbs: 'TBS.us',
  space: 'Space.ar', syfy: 'SYFY.us', discoverykids: 'DiscoveryKidsLatinAmerica.us',
  cartoon: 'CartoonNetworkLatinAmerica.us', discovery: 'DiscoveryChannelLatinAmerica.us',
  globo: 'TVGloboSaoPaulo.br', sbt: 'SBTInternacionalAmerica.br', record: 'Record.br', band: 'Band.br',
  redetv: 'RedeTV.br', cultura: 'TVCultura.br', tnt: 'TNT.us', history: 'History.br', tlc: 'TLCLatinAmerica.us',
  warner: 'WarnerChannel.us', tcm: 'TCM.us', viva: 'CanalViva.br', vh1: 'VH1.us', tooncast: 'Tooncast.us',
  woohoo: 'WooHoo.br', camara: 'TVCamara.br', amazonsat: 'AmazonSat.br', mil1noites: '1001Noites.br',
  adesso: 'AdessoTV.br', telabrasil: 'TelaBrasilTV.br'
};

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const MAX_BYTES = 400 * 1024;

async function getJson(dir, name) {
  if (dir) return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  const res = await fetch(`${API}${name}.json`, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
  return res.json();
}

const hex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
const toHex = (r, g, b) => `#${hex(r)}${hex(g)}${hex(b)}`;
const mix = (c, base, t) => [0, 1, 2].map((i) => base[i] * (1 - t) + c[i] * t);
const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/** ffmpeg: reduz a imagem a 24x24 RGBA e devolve as métricas que decidem o fundo do cartão. */
function analyse(buf) {
  const size = 24;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', `scale=${size}:${size}:flags=area,format=rgba`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'],
    { input: buf, maxBuffer: 1 << 20, timeout: 20000 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < size * size * 4) return null;
  const px = r.stdout;
  let n = 0, a = 0, sr = 0, sg = 0, sb = 0, sat = 0, tr = 0, tg = 0, tb = 0, tw = 0;
  for (let i = 0; i < size * size; i += 1) {
    const al = px[i * 4 + 3] / 255;
    a += al;
    if (al < 0.35) continue;
    const R = px[i * 4], G = px[i * 4 + 1], B = px[i * 4 + 2];
    n += 1; sr += R; sg += G; sb += B;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    const s = mx ? (mx - mn) / mx : 0;
    sat += s;
    // cor "da marca": pesa mais o que é saturado e não é quase branco/preto
    const w = s * s + 0.02;
    tr += R * w; tg += G * w; tb += B * w; tw += w;
  }
  if (n < 12) return null;
  const corner = [0, size - 1, (size - 1) * size, size * size - 1].map((i) => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2], px[i * 4 + 3] / 255]);
  return {
    coverage: a / (size * size),
    avg: [sr / n, sg / n, sb / n],
    brand: [tr / tw, tg / tw, tb / tw],
    sat: sat / n,
    corner: corner.reduce((acc, c) => [acc[0] + c[0] / 4, acc[1] + c[1] / 4, acc[2] + c[2] / 4, acc[3] + c[3] / 4], [0, 0, 0, 0])
  };
}

/** Decide os fundos a partir das métricas da logo. */
function palette(m) {
  const dark = [18, 18, 26];
  const light = [238, 240, 246];
  const brand = m.sat > 0.18 ? m.brand : [120, 120, 140];
  const d = toHex(...mix(brand, dark, 0.2)); // fundo escuro com um toque da marca
  let a;
  if (m.coverage > 0.88 && m.corner[3] > 0.9) {
    // imagem "em caixa" (fundo opaco): o cartão assume a cor da borda para a caixa sumir
    const c = m.corner.slice(0, 3);
    a = [toHex(...c), toHex(...mix([0, 0, 0], c, 0.12))];
  } else if (lum(m.avg) > 0.55) {
    a = [toHex(...mix(brand, dark, 0.3)), toHex(...mix(brand, [8, 8, 14], 0.12))]; // logo clara -> fundo escuro
  } else {
    a = [toHex(...mix(brand, light, 0.07)), toHex(...mix(brand, [214, 217, 228], 0.1))]; // logo escura -> fundo claro
  }
  return { a, d };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchImage(url) {
  let res;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (res.status !== 429 && res.status !== 503) break;
    await sleep(4000 * (attempt + 1)); // Wikimedia limita pedidos em sequência
  }
  await sleep(300);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = String(res.headers.get('content-type') || '');
  if (!/^image\//i.test(type)) throw new Error(`tipo ${type || 'desconhecido'}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`grande demais (${Math.round(buf.length / 1024)} KB)`);
  return { buf, type };
}

async function main() {
  const dir = process.argv[2] || '';
  const logos = await getJson(dir, 'logos');
  const by = new Map();
  for (const l of logos) { if (!by.has(l.channel)) by.set(l.channel, []); by.get(l.channel).push(l); }

  const out = {};
  const report = [];
  for (const [id, chId] of Object.entries(IDS)) {
    // raster primeiro (o ffmpeg mede PNG/JPG/WEBP; SVG não), das maiores para as menores; cada uma só entra se carregar de fato
    const list = (by.get(chId) || []).slice().sort((x, y) => (Number(y.format !== 'SVG') - Number(x.format !== 'SVG')) || (y.width * y.height - x.width * x.height));
    let done = false; let why = list.length ? '' : 'sem logo no catálogo';
    for (const l of list) {
      if (!/^https:\/\//i.test(l.url)) { why = 'logo sem https'; continue; }
      try {
        const { buf, type } = await fetchImage(l.url);
        let pal = { a: ['#1a1a24', '#10101a'], d: '#14141e' };
        if (!/svg/i.test(type)) {
          const m = analyse(buf);
          if (!m) { why = 'imagem ilegível'; continue; }
          pal = palette(m);
        }
        out[id] = { u: l.url, a: pal.a, d: pal.d };
        report.push(`ok   ${id.padEnd(16)} ${l.format} ${l.width}x${l.height} ${new URL(l.url).host}`);
        done = true; break;
      } catch (error) { why = `${new URL(l.url).host}: ${error.message}`; }
    }
    if (!done) report.push(`FALTA ${id.padEnd(15)} ${why}`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(report.join('\n'));
  console.log(`\n${Object.keys(out).length} de ${Object.keys(IDS).length} logos gravadas em ${path.relative(process.cwd(), OUT)}`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
module.exports = { IDS, analyse, palette };
