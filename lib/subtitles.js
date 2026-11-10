'use strict';

/**
 * Converte legendas SRT (application/x-subrip) para WebVTT.
 * O elemento <track> do HTML5 só aceita WebVTT — por isso as legendas
 * do provedor não apareciam.
 */

function srtToVtt(input) {
  const text = String(input)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');

  if (/^\s*WEBVTT/.test(text)) return text;

  const out = ['WEBVTT', ''];
  let blank = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine;

    // Remove o número sequencial da cue do SRT.
    if (/^\s*\d+\s*$/.test(line)) continue;

    let converted = line
      // 00:00:01,000 --> 00:00:04,000  =>  00:00:01.000 --> 00:00:04.000
      .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
      // remove tags de posicionamento do ASS/SSA ({\an8}, {\pos(...)} etc.)
      .replace(/\{\\[^}]*\}/g, '')
      // <font ...> não é suportado pelo WebVTT
      .replace(/<\/?font[^>]*>/gi, '');

    if (!converted.trim()) {
      if (!blank) {
        out.push('');
        blank = true;
      }
      continue;
    }

    blank = false;
    out.push(converted);
  }

  const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return `${body}\n`;
}

module.exports = { srtToVtt, shiftVtt, decodeSubtitle, stripSpamCues, analyzeVtt };

/**
 * Desloca todos os cues de um WebVTT em `seconds` (positivo = legenda mais
 * tarde). Cues que terminam antes de 0 são removidos.
 */
function parseVttTime(value) {
  const clean = String(value || '').trim().replace(',', '.');
  if (!clean) return 0;
  const parts = clean.split(':');
  let total = 0;
  for (const part of parts) total = total * 60 + (Number(part) || 0);
  return total;
}

function formatVttTime(totalSeconds) {
  const ms = Math.max(0, Math.round(totalSeconds * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const pad = (n, size) => String(n).padStart(size, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

/**
 * nova_hora = hora * scale + seconds. `scale` corrige legendas feitas para outro
 * fps/velocidade (a legenda "escorrega" ao longo do filme). 1 = sem mudança.
 */
function shiftVtt(vtt, seconds, scaleInput) {
  const shift = Number(seconds) || 0;
  const scale = Number.isFinite(Number(scaleInput)) && Number(scaleInput) > 0.5 && Number(scaleInput) < 2 ? Number(scaleInput) : 1;
  if (!shift && scale === 1) return vtt;

  const blocks = String(vtt).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const output = [];

  for (const block of blocks) {
    if (!block.trim()) continue;

    // Cabeçalho e metadados não têm timestamp.
    if (/^\s*(WEBVTT|NOTE|STYLE|REGION)/.test(block)) {
      output.push(block);
      continue;
    }

    const lines = block.split('\n');
    const index = lines.findIndex((line) => line.includes('-->'));
    if (index === -1) {
      output.push(block);
      continue;
    }

    const [startRaw, endRaw] = lines[index].split('-->');
    const start = parseVttTime(startRaw);
    const endWithSettings = String(endRaw || '').trim();
    const endToken = endWithSettings.split(/\s+/)[0] || '';
    const settings = endWithSettings.slice(endToken.length).trim();
    const end = parseVttTime(endToken);

    const newStart = start * scale + shift;
    const newEnd = end * scale + shift;

    // Cue inteiramente antes do começo do vídeo: descarta.
    if (newEnd <= 0) continue;

    lines[index] =
      `${formatVttTime(Math.max(0, newStart))} --> ${formatVttTime(newEnd)}` +
      (settings ? ` ${settings}` : '');

    output.push(lines.join('\n'));
  }

  return output.join('\n\n') + '\n';
}


/* ------------------------------------------------------------------ */
/* Codificação, propaganda e diagnóstico                                */
/* ------------------------------------------------------------------ */

// Muitos .srt antigos vêm em página de código do Windows, não em UTF-8
// (ex.: "isto é" vira "isto �"). Escolhe pelo idioma quando não for UTF-8 válido.
const LEGACY_CHARSET = {
  pt: 'windows-1252', es: 'windows-1252', fr: 'windows-1252', it: 'windows-1252', de: 'windows-1252',
  nl: 'windows-1252', sv: 'windows-1252', da: 'windows-1252', no: 'windows-1252', fi: 'windows-1252',
  ca: 'windows-1252', id: 'windows-1252', ms: 'windows-1252', en: 'windows-1252', sw: 'windows-1252',
  pl: 'windows-1250', cs: 'windows-1250', sk: 'windows-1250', hu: 'windows-1250', ro: 'windows-1250',
  hr: 'windows-1250', sl: 'windows-1250', sq: 'windows-1250',
  ru: 'windows-1251', uk: 'windows-1251', bg: 'windows-1251', sr: 'windows-1251', mk: 'windows-1251',
  el: 'windows-1253', tr: 'windows-1254', he: 'windows-1255', ar: 'windows-1256', fa: 'windows-1256',
  ur: 'windows-1256', vi: 'windows-1258', th: 'windows-874',
  zh: 'gb18030', ja: 'shift_jis', ko: 'euc-kr'
};

function decodeWith(buffer, charset) {
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch (err) {
    return null;
  }
}

/** Bytes de uma legenda -> texto. Aceita .gz, UTF-16 (BOM), UTF-8 e páginas legadas. */
function decodeSubtitle(input, lang) {
  let buf = Buffer.isBuffer(input) ? input : Buffer.from(input);

  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { buf = require('zlib').gunzipSync(buf); } catch (err) { /* segue com o original */ }
  }

  if (buf[0] === 0xff && buf[1] === 0xfe) return decodeWith(buf, 'utf-16le') || '';
  if (buf[0] === 0xfe && buf[1] === 0xff) return decodeWith(buf, 'utf-16be') || '';

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch (err) {
    // não é UTF-8 válido: página de código do idioma
  }

  const code = String(lang || '').toLowerCase().slice(0, 2);
  return decodeWith(buf, LEGACY_CHARSET[code] || 'windows-1252')
    || buf.toString('latin1');
}

// Cues de propaganda que os sites de legenda enfiam no começo/fim.
const SPAM_PATTERNS = [
  /opensubtitles/i, /open-subtitles/i, /osdb\.link/i, /api\.opensubtitles/i,
  /subtitles? (by|from|downloaded)/i, /\bsubscene\b/i, /\byifysubtitles\b/i, /\baddic7ed\b/i,
  /\bpodnapisi\b/i, /\bsubdl\b/i, /\bsubsunacs\b/i, /\blegendas?\.tv\b/i, /\blegendei\b/i,
  /advertise your product/i, /become (a )?vip member/i, /\bvip member\b/i, /anggota vip/i,
  /support us and/i, /\bwww\.[\w-]+\.(com|org|net|tv)\b/i,
  /@(hotmail|gmail|yahoo|outlook)\.com/i
];

/** Remove cues de propaganda; devolve o VTT limpo e quantos cues saíram. */
function stripSpamCues(vtt) {
  const blocks = String(vtt).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out = [];
  let removed = 0;
  let cueIndex = 0;

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing === -1) { out.push(block); continue; }

    cueIndex += 1;
    const text = lines.slice(timing + 1).join(' ');
    // Só avalia o começo e o fim do arquivo: no meio do filme é fala de verdade.
    const edge = cueIndex <= 4 || blocks.length - cueIndex <= 3;
    if (!text.trim() || (edge && SPAM_PATTERNS.some((re) => re.test(text)))) {
      removed += 1;
      continue;
    }
    out.push(block);
  }

  return { vtt: out.join('\n\n') + '\n', removed };
}

/** Resumo para o player avisar de legenda quebrada/incompleta. */
function analyzeVtt(vtt) {
  let cues = 0;
  let first = null;
  let last = 0;
  let chars = 0;
  let bad = 0;

  for (const block of String(vtt).replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing === -1) continue;
    const [startRaw, endRaw] = lines[timing].split('-->');
    const start = parseVttTime(startRaw);
    const end = parseVttTime(String(endRaw || '').trim().split(/\s+/)[0]);
    cues += 1;
    if (first === null) first = start;
    if (end > last) last = end;
    const text = lines.slice(timing + 1).join('');
    chars += text.length;
    bad += (text.match(/�/g) || []).length;
  }

  return {
    cues,
    firstStart: first === null ? 0 : Math.round(first * 1000) / 1000,
    lastEnd: Math.round(last * 1000) / 1000,
    garbled: chars ? Math.round((bad / chars) * 1000) / 1000 : 0
  };
}
