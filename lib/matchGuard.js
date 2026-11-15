'use strict';

/**
 * "Este upload é MESMO este filme?" — regra única para as fontes de upload aberto
 * (BitChute, Internet Archive, PeerTube), onde qualquer um publica qualquer coisa com qualquer nome.
 *
 * O erro que isto evita: título parecido + duração parecida não bastam. "La Odisea" (nome alternativo
 * em espanhol de "A Odisseia", 2026) casou com a minissérie de 1997 de 2h54, publicada em 2023.
 *
 * Regras (nesta ordem):
 *  1. Publicado ANTES do lançamento do filme (folga de 14 dias) → NÃO é este filme.
 *  2. O título do upload cita um ano diferente do filme (folga ±1) → NÃO é.
 *  3. Título/descrição citam o ano do filme (±1) → prova positiva, vale.
 *  4. Sem nenhum ano: só vale se o título do upload for EXATAMENTE o nome principal do filme
 *     (pt-BR, original ou inglês — nunca um nome alternativo de outro país) e a duração bater de perto (±4%).
 */

const DAY = 24 * 3600 * 1000;

function norm(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\((?:19|20)\d{2}\)|\[(?:19|20)\d{2}\]/g, ' ')
    .replace(/\b(?:dublado|legendado|dual audio|audio dual|pt[- ]?br|ptbr|nacional|portugues|filme completo|full movie|completo|completa|hd|fhd|4k|1080p|720p|480p|bluray|dvdrip|webrip|web-dl|h264|x264)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function yearsIn(text) {
  const out = [];
  const re = /(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(Number(m[1]));
  return out;
}

function isoMs(text) {
  const t = Date.parse(String(text || ''));
  return Number.isFinite(t) ? t : 0;
}

/**
 * @param {{year:number, releaseDate?:string, primary?:string[], runtimeSec?:number}} info  dados do TMDB
 * @param {{label:string, description?:string, publishedAt?:string, durationSec?:number, upYear?:number}} cand  o upload
 * @returns {{ok:boolean, why:string}}
 */
function check(info, cand) {
  if (!info || !info.year) return { ok: true, why: 'sem ano do TMDB para conferir' };
  const label = String(cand.label || '');
  const released = isoMs(info.releaseDate);
  const published = isoMs(cand.publishedAt);
  if (released && published && published < released - 14 * DAY) {
    return { ok: false, why: `publicado em ${String(cand.publishedAt).slice(0, 10)}, antes do lançamento (${info.releaseDate})` };
  }
  const labelYears = yearsIn(label);
  if (labelYears.length && !labelYears.some((y) => Math.abs(y - info.year) <= 1)) {
    return { ok: false, why: `título cita ${labelYears.join('/')}, o filme é de ${info.year}` };
  }
  if (cand.upYear && Math.abs(cand.upYear - info.year) > 1 && !labelYears.length && !yearsIn(cand.description).some((y) => Math.abs(y - info.year) <= 1)) {
    // Ano de catalogação do item (Archive): só barra se nada mais prova o ano.
    if (Math.abs(cand.upYear - info.year) > 3) return { ok: false, why: `catalogado como ${cand.upYear}, o filme é de ${info.year}` };
  }
  if (labelYears.some((y) => Math.abs(y - info.year) <= 1)) return { ok: true, why: 'ano no título confere' };
  if (yearsIn(cand.description).some((y) => Math.abs(y - info.year) <= 1)) return { ok: true, why: 'ano na descrição confere' };

  // Sem ano nenhum: exige o nome principal exato e duração apertada.
  const primary = (info.primary || []).map(norm).filter((n) => n.length >= 3);
  const exact = primary.includes(norm(label));
  if (!exact) return { ok: false, why: 'sem ano e o título não é o nome principal do filme' };
  if (info.runtimeSec && cand.durationSec && Math.abs(cand.durationSec - info.runtimeSec) > Math.max(180, info.runtimeSec * 0.04)) {
    return { ok: false, why: 'sem ano e a duração não bate de perto' };
  }
  return { ok: true, why: 'título idêntico ao nome principal' };
}

module.exports = { check, norm, yearsIn };
