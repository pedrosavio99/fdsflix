'use strict';

/**
 * Tradução automática de legendas (gratuita, sem chave de API).
 *
 * Regra de ouro: o TEMPO nunca é tocado. Só o texto de cada fala é trocado, então a legenda
 * traduzida continua exatamente tão sincronizada quanto a original (o atraso/escala do
 * usuário é aplicado depois, em shiftVtt, igual para qualquer idioma).
 *
 * Provedores (tentados em ordem; um que falha esfria por um tempo e o próximo assume):
 *   1. Google "clients5" (POST com vários `q`, devolve 1 resultado por `q` — alinhamento exato)
 *   2. Google "gtx" (um `q` com as linhas separadas por \n; só vale se a contagem de linhas bater)
 *   3. LibreTranslate, se LIBRETRANSLATE_URL estiver definido (opcional; instância própria é grátis)
 */

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MAX_BATCH_ITEMS = 40;
const MAX_BATCH_CHARS = 3500;
const CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 12000;
const COOLDOWN_MS = 60 * 1000;
const WRAP_AT = 42;

/* ------------------------------------------------------------------ */
/* Provedores                                                          */
/* ------------------------------------------------------------------ */

const cooldown = new Map(); // nome do provedor -> timestamp até quando fica de lado

async function postForm(url, params, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}?${params}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      body
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      // captcha / página de "automated queries" vem como HTML
      throw new Error('resposta não-JSON (provável limite/captcha)');
    }
  } finally {
    clearTimeout(timer);
  }
}

function formBody(key, values) {
  const body = new URLSearchParams();
  for (const value of values) body.append(key, value);
  return body.toString();
}

async function viaClients5(texts, to, from) {
  const params = new URLSearchParams({ client: 'dict-chrome-ex', sl: from, tl: to }).toString();
  const data = await postForm('https://clients5.google.com/translate_a/t', params, formBody('q', texts));
  if (!Array.isArray(data) || data.length !== texts.length) throw new Error('contagem de itens não bate');
  return data.map((item) => {
    const value = Array.isArray(item) ? item[0] : item;
    if (typeof value !== 'string') throw new Error('item inesperado');
    return value;
  });
}

async function viaGtx(texts, to, from) {
  const params = new URLSearchParams({ client: 'gtx', sl: from, tl: to, dt: 't', dj: '0' }).toString();
  const data = await postForm('https://translate.googleapis.com/translate_a/single', params, formBody('q', [texts.join('\n')]));
  const segments = Array.isArray(data && data[0]) ? data[0] : null;
  if (!segments) throw new Error('formato inesperado');
  const joined = segments.map((segment) => (segment && segment[0]) || '').join('');
  const lines = joined.replace(/\n+$/, '').split('\n');
  if (lines.length !== texts.length) throw new Error('contagem de linhas não bate');
  return lines;
}

async function viaLibre(texts, to, from) {
  const base = String(process.env.LIBRETRANSLATE_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('LIBRETRANSLATE_URL não definido');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 2);
  try {
    const response = await fetch(`${base}/translate`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: texts,
        source: from,
        target: to === 'pt' ? 'pt-BR' : to,
        format: 'text',
        api_key: process.env.LIBRETRANSLATE_API_KEY || undefined
      })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const out = data && data.translatedText;
    if (!Array.isArray(out) || out.length !== texts.length) throw new Error('contagem de itens não bate');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

const PROVIDERS = [
  { name: 'google-clients5', run: viaClients5 },
  { name: 'google-gtx', run: viaGtx },
  { name: 'libretranslate', run: viaLibre, enabled: () => Boolean(process.env.LIBRETRANSLATE_URL) }
];

/** Traduz um lote com o primeiro provedor que responder certo. Lança se todos falharem. */
async function translateBatch(texts, to, from = 'auto') {
  const errors = [];
  const now = Date.now();
  const usable = PROVIDERS.filter((p) => (!p.enabled || p.enabled()));
  // quem está esfriando vai para o fim da fila (ainda é tentado se for o único que sobrou)
  const ordered = [
    ...usable.filter((p) => (cooldown.get(p.name) || 0) <= now),
    ...usable.filter((p) => (cooldown.get(p.name) || 0) > now)
  ];

  for (const provider of ordered) {
    try {
      const result = await provider.run(texts, to, from);
      cooldown.delete(provider.name);
      return result;
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
      // Erro de contagem é problema do lote (não do provedor): não esfria.
      if (!/contagem/.test(err.message)) cooldown.set(provider.name, Date.now() + COOLDOWN_MS);
    }
  }
  throw new Error(errors.join(' | ') || 'nenhum provedor de tradução disponível');
}

/**
 * Traduz uma lista de textos. Devolve um array do mesmo tamanho; `null` onde não deu.
 * `batch` é injetável para testes.
 */
async function translateTexts(texts, { to = 'pt', from = 'auto', batch = translateBatch } = {}) {
  const results = new Array(texts.length).fill(null);

  // Monta lotes limitados por quantidade e tamanho.
  const chunks = [];
  let current = [];
  let chars = 0;
  texts.forEach((text, index) => {
    if (current.length && (current.length >= MAX_BATCH_ITEMS || chars + text.length > MAX_BATCH_CHARS)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(index);
    chars += text.length;
  });
  if (current.length) chunks.push(current);

  async function runChunk(indexes) {
    try {
      const out = await batch(indexes.map((i) => texts[i]), to, from);
      indexes.forEach((i, n) => { results[i] = typeof out[n] === 'string' ? out[n] : null; });
    } catch (err) {
      if (indexes.length === 1) return; // desistiu desse; fica null (mantém o original)
      // Divide ao meio: isola uma fala problemática sem perder o lote inteiro.
      const mid = Math.ceil(indexes.length / 2);
      await runChunk(indexes.slice(0, mid));
      await runChunk(indexes.slice(mid));
    }
  }

  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
    while (next < chunks.length) {
      const mine = chunks[next++];
      await runChunk(mine);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ */
/* WebVTT                                                              */
/* ------------------------------------------------------------------ */

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'" };

function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|nbsp|quot|#39);/g, (m) => ENTITIES[m] || m);
}

function escapeVtt(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

const HAS_LETTER = /\p{L}/u;
const DIALOG_LINE = /^\s*(?:<[^>]+>)*\s*[-–—]\s*/;

/** Quebra um texto traduzido em linhas de ~42 caracteres, balanceadas, no máximo 3. */
function wrapText(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= WRAP_AT) return clean;
  const parts = Math.min(3, Math.ceil(clean.length / WRAP_AT));
  const words = clean.split(' ');
  const target = clean.length / parts;
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > target && lines.length < parts - 1) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/** Lê o WebVTT em blocos; cada cue vira { blockIndex, timingIndex, lines }. */
function parseBlocks(vtt) {
  const blocks = String(vtt).replace(/\r\n?/g, '\n').split(/\n{2,}/).filter((b) => b.trim());
  const cues = [];
  blocks.forEach((block, blockIndex) => {
    if (/^\s*(WEBVTT|NOTE|STYLE|REGION)/.test(block)) return;
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) return;
    cues.push({ blockIndex, timingIndex, lines });
  });
  return { blocks, cues };
}

/**
 * Traduz o texto das falas de um WebVTT sem mexer em nenhum tempo.
 * Devolve { vtt, total, translated, failed, complete }.
 */
async function translateVtt(vtt, { to = 'pt', from = 'auto', batch } = {}) {
  const { blocks, cues } = parseBlocks(vtt);

  // 1) Quebra cada fala em "unidades" a traduzir.
  const units = []; // { cue, slot, prefix, italic, text }
  const plans = cues.map((cue) => {
    const textLines = cue.lines.slice(cue.timingIndex + 1);
    const dialogue = textLines.length >= 2 && textLines.filter((l) => DIALOG_LINE.test(l)).length >= 2;
    const groups = dialogue ? textLines.map((l) => [l]) : [textLines];
    return groups.map((group) => {
      const raw = group.join(' ');
      const italic = /^\s*<i>/i.test(raw) && /<\/i>\s*$/i.test(raw);
      const dash = DIALOG_LINE.test(group[0]) ? '- ' : '';
      const text = decodeEntities(raw.replace(/<[^>]+>/g, ' ').replace(/^\s*[-–—]\s*/, '').replace(/\s+/g, ' ').trim());
      const unit = { original: group.join('\n'), dash, italic, text, index: -1, translatable: HAS_LETTER.test(text) };
      units.push(unit);
      return unit;
    });
  });

  // 2) Textos únicos (muita fala se repete: "What?", "Yeah.") -> menos requisições.
  const unique = new Map(); // texto -> posição
  const uniqueTexts = [];
  for (const unit of units) {
    if (!unit.translatable) continue;
    if (!unique.has(unit.text)) { unique.set(unit.text, uniqueTexts.length); uniqueTexts.push(unit.text); }
    unit.index = unique.get(unit.text);
  }

  const results = uniqueTexts.length ? await translateTexts(uniqueTexts, { to, from, batch }) : [];

  // 3) Remonta. Fala que não foi traduzida mantém o texto original.
  let translated = 0;
  let failed = 0;
  const outBlocks = blocks.slice();

  cues.forEach((cue, n) => {
    const rendered = plans[n].map((unit) => {
      if (!unit.translatable) return unit.original;
      const result = results[unit.index];
      if (!result || !result.trim()) { failed += 1; return unit.original; }
      translated += 1;
      let line = escapeVtt(wrapText(result));
      if (unit.italic) line = line.split('\n').map((l) => `<i>${l}</i>`).join('\n');
      return unit.dash + line;
    });
    const head = cue.lines.slice(0, cue.timingIndex + 1);
    outBlocks[cue.blockIndex] = head.concat(rendered.join('\n').split('\n')).join('\n');
  });

  const total = translated + failed;
  return {
    vtt: outBlocks.join('\n\n') + '\n',
    total,
    translated,
    failed,
    complete: failed === 0 || failed / Math.max(1, total) < 0.02
  };
}

module.exports = { translateVtt, translateTexts, translateBatch, wrapText, parseBlocks };
