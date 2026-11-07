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

module.exports = { srtToVtt };
