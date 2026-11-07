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

module.exports = { srtToVtt, shiftVtt };

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

function shiftVtt(vtt, seconds) {
  const shift = Number(seconds) || 0;
  if (!shift) return vtt;

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

    const newStart = start + shift;
    const newEnd = end + shift;

    // Cue inteiramente antes do começo do vídeo: descarta.
    if (newEnd <= 0) continue;

    lines[index] =
      `${formatVttTime(Math.max(0, newStart))} --> ${formatVttTime(newEnd)}` +
      (settings ? ` ${settings}` : '');

    output.push(lines.join('\n'));
  }

  return output.join('\n\n') + '\n';
}
