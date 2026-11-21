'use strict';

/**
 * Lista final de legendas de uma resposta de vídeo: junta o que a fonte trouxe com o que o "cérebro"
 * (lib/subtitleBrain.js) achou, conferiu e ordenou. Português do Brasil conferido sempre em 1º; outro idioma só
 * por escolha da pessoa.
 */

const registry = require('./registry');
const subtitleBrain = require('./subtitleBrain');

const LANG_MAP = {
  'português': 'pt',
  'portugues': 'pt',
  'portuguese': 'pt',
  'english': 'en',
  'inglês': 'en',
  'ingles': 'en',
  'español': 'es',
  'espanhol': 'es',
  'spanish': 'es',
  'français': 'fr',
  'francês': 'fr',
  'frances': 'fr',
  'french': 'fr',
  'deutsch': 'de',
  'alemão': 'de',
  'italiano': 'it',
  'italian': 'it',
  '日本語': 'ja',
  '한국어': 'ko',
  '中文': 'zh',
  'русский': 'ru',
  'russian': 'ru',
  'हिन्दी': 'hi',
  'العربية': 'ar',
  'اَلْعَرَبِيَّةُ': 'ar',
  'türkçe': 'tr',
  'polski': 'pl',
  'nederlands': 'nl',
  'bahasa indonesia': 'id',
  'indonesian': 'id',
  'melayu': 'ms',
  'malay': 'ms',
  'filipino': 'fil',
  'tiếng việt': 'vi',
  'ไทย': 'th',
  'svenska': 'sv',
  'suomi': 'fi',
  'norsk': 'no',
  'dansk': 'da',
  'čeština': 'cs',
  'magyar': 'hu',
  'română': 'ro',
  'български': 'bg',
  'українська': 'uk',
  'עברית': 'he',
  'فارسی': 'fa',
  'eesti': 'et',
  'latviešu': 'lv',
  'lietuvių': 'lt'
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function normalizeLang(label) {
  const key = String(label || '').trim().toLowerCase();
  if (LANG_MAP[key]) return LANG_MAP[key];
  // "pt-BR", "Portuguese - Brazilian", "pob"… antes viravam 'und' e o pt-BR nunca contava como português.
  if (subtitleBrain.parseLabel(label, '').lang === 'pt') return 'pt';
  if (/^[a-z]{2}$/.test(key)) return key;
  return 'und';
}

// Idioma-base para traduzir quando a faixa não tem legenda em português: inglês primeiro
// (é a que as fontes mais têm e a que melhor traduz), depois idiomas próximos.
const TRANSLATE_SOURCE_ORDER = ['en', 'es', 'fr', 'it', 'de'];
const TRANSLATE_TARGET = 'pt';
const TRANSLATE_LABEL = 'Português (Brasil) · tradução automática';

// A legenda é pedida quando a pessoa a ESCOLHE, às vezes no meio do filme: o link precisa durar o filme inteiro
// (antes valia 4 min e a faixa escolhida depois disso respondia 404 "Legenda expirada"). O token é minúsculo;
// o TEXTO baixado fica num cache compartilhado e limitado (loadSubtitleVtt), não preso a cada token.
const SUBTITLE_TTL_MS = 3 * 60 * 60 * 1000;

function buildCaptions(rawCaptions, autoShift = 0, plan = null) {
  const raw = Array.isArray(rawCaptions) ? rawCaptions : [];
  // Com o "cérebro" (lib/subtitleBrain.js) o português vem JÁ conferido e ordenado; o pt cru do provedor sai da lista
  // (ele entrou na disputa como candidata: ou ganhou lugar em `plan.ptbr`, ou foi barrado por ser ruim).
  const isPt = (c) => normalizeLang(c.language) === TRANSLATE_TARGET;
  const rest = plan ? raw.filter((c) => !isPt(c)) : raw;

  const captions = rest.map((caption) => {
    const lang = normalizeLang(caption.language);
    const token = registry.register('subtitle', { url: caption.url, autoShift, lang }, SUBTITLE_TTL_MS);
    return {
      label: caption.language || 'Legenda',
      srclang: lang,
      default: false,
      url: `/api/subtitle?t=${token}`
    };
  });

  // Português do Brasil escolhido pelo cérebro: melhor primeiro (padrão); as outras ficam de reserva para o failover.
  const ptbr = [];
  const brFiles = plan && Array.isArray(plan.ptbr) ? plan.ptbr.slice(0, 3) : [];
  brFiles.forEach((c, i) => {
    const sync = c.sync || { shift: 0, scale: 1 };
    const token = registry.register('subtitle', {
      local: { vtt: c.vtt, info: c.info },
      baseShift: sync.shift,
      baseScale: sync.scale,
      autoShift,
      lang: 'pt'
    }, SUBTITLE_TTL_MS);
    ptbr.push({
      label: i === 0 ? 'Português (Brasil)' : `Português (Brasil) · opção ${i + 1}`,
      srclang: 'pt',
      ptbr: true,
      default: false,
      url: `/api/subtitle?t=${token}`
    });
  });
  // Português de Portugal: fica na lista (a pessoa pode escolher), mas nunca é padrão nem reserva automática.
  const ptpt = (plan && Array.isArray(plan.ptpt) ? plan.ptpt.slice(0, 1) : []).map((c) => ({
    label: 'Português (Portugal)',
    srclang: 'pt-PT',
    default: false,
    url: `/api/subtitle?t=${registry.register('subtitle', { local: { vtt: c.vtt, info: c.info }, autoShift, lang: 'pt' }, SUBTITLE_TTL_MS)}`
  }));

  // Tradução automática para PT-BR: o servidor baixa a legenda de origem e troca só o texto,
  // sem mexer nos tempos (continua sincronizada). Só é feita quando alguém abre a faixa.
  const hasPt = ptbr.length > 0 || captions.some((caption) => caption.srclang === TRANSLATE_TARGET);
  const sources = raw.filter((c) => c && c.url && normalizeLang(c.language) !== TRANSLATE_TARGET);
  let translated = null;
  if (sources.length) {
    const rank = (c) => {
      const i = TRANSLATE_SOURCE_ORDER.indexOf(normalizeLang(c.language));
      return i === -1 ? TRANSLATE_SOURCE_ORDER.length : i;
    };
    const source = sources.slice().sort((a, b) => rank(a) - rank(b))[0];
    const token = registry.register('subtitle', {
      url: source.url,
      autoShift,
      lang: normalizeLang(source.language),
      translateTo: TRANSLATE_TARGET
    }, SUBTITLE_TTL_MS);
    translated = {
      label: TRANSLATE_LABEL,
      srclang: TRANSLATE_TARGET,
      translated: true,
      from: normalizeLang(source.language),
      default: false,
      url: `/api/subtitle?t=${token}`
    };
  }

  // Ordem: pt-BR conferido (melhor 1º) → tradução (reserva) → Portugal → o resto (inglês etc., só por escolha da pessoa).
  // Sem pt-BR conferido, a tradução vira a 1ª (como sempre foi); com pt nativo vindo do provedor (sem o cérebro) ela fica no fim.
  const out = [];
  out.push(...ptbr);
  if (translated && (!hasPt || ptbr.length)) out.push(translated);
  out.push(...ptpt);
  out.push(...captions);
  if (translated && hasPt && !ptbr.length) out.push(translated);

  const preferred =
    out.find((caption) => caption.ptbr) ||
    out.find((caption) => caption.translated && !hasPt) ||
    out.find((caption) => caption.srclang === 'pt') ||
    out.find((caption) => caption.srclang === 'en') ||
    out[0];

  if (preferred) preferred.default = true;
  return out;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Legendas finais de uma resposta de vídeo: junta o que a fonte trouxe com o que o cérebro achou/conferiu.
 * `brainJob`: Promise de { prep, runtimeSec } (ver /api/stream); `budgetEnd`: até quando vale esperar por ele.
 * Nunca atrasa nem derruba o vídeo: sem cérebro a lista sai como antes.
 */
async function smartCaptions({ own, companion, provider, shift, brainJob, budgetEnd, trace }) {
  const ownList = Array.isArray(own) ? own : [];
  const comp = Array.isArray(companion) ? companion : [];
  const list = ownList.length ? ownList : comp;
  let plan = null;
  try {
    const got = brainJob ? await Promise.race([brainJob, delay(Math.max(0, (budgetEnd || 0) - Date.now())).then(() => null)]) : null;
    if (got && got.prep) {
      const mine = new Set(ownList.map((c) => c.url));
      const trustAll = provider === 'VidLink Pro';
      const seen = new Set();
      const extras = [...ownList, ...comp].filter((c) => c && c.url && !seen.has(c.url) && seen.add(c.url));
      plan = await subtitleBrain.choose(got.prep, { runtimeSec: got.runtimeSec, extras, trusted: (url) => trustAll || mine.has(url) });
      if (trace) {
        const top = plan.ptbr[0];
        trace.push({
          provider: 'Legendas pt-BR',
          outcome: top ? 'USADO' : 'sem resultado',
          ms: 0,
          notes: [
            ...plan.notes,
            top ? `melhor: ${top.id} (nota ${top.score}; ${top.why.join(', ') || 'sem sinais extras'})` +
              (top.sync && top.sync.basis ? ` · corrigida: ${top.sync.shift.toFixed(2)} s, escala ${top.sync.scale.toFixed(4)} (${top.sync.basis})` : '') : 'nenhuma legenda pt-BR serviu',
            ...plan.rejected.slice(0, 6).map((r) => `barrada ${r.id}: ${r.reason}`)
          ]
        });
      }
    }
  } catch (err) {
    plan = null;
  }
  return buildCaptions(list, shift, plan);
}

module.exports = { normalizeLang, buildCaptions, smartCaptions, SUBTITLE_TTL_MS, TRANSLATE_LABEL };
