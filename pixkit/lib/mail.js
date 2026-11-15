'use strict';

/**
 * Leitura e conferência do e-mail "Recebemos sua transferência via Pix" do Nubank.
 *
 * O e-mail só traz valor + horário (nada de pagador/txid). Por isso a confiança vem de duas coisas:
 *   1. o cabeçalho Authentication-Results MAIS ALTO (o que o próprio Gmail acrescenta, authserv mx.google.com)
 *      precisa dizer dkim=pass para nubank.com.br e dmarc=pass — alguém que mande um e-mail falso para a caixa
 *      não consegue passar nisso (e um Authentication-Results falso vindo no e-mail fica ABAIXO do do Gmail);
 *   2. o remetente (From) precisa ser do domínio nubank.com.br.
 * SPF é ignorado de propósito: com o reenvio Hotmail -> Gmail ele falha mesmo em e-mail legítimo.
 */

const MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

/** "Nome: valor" com continuação de linha (dobra RFC 5322) -> [{name, value}], na ordem em que aparecem. */
function parseHeaders(block) {
  const lines = String(block || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (!line) break; // fim do bloco de cabeçalhos
    if (/^[ \t]/.test(line)) {
      if (out.length) out[out.length - 1].value += ` ${line.trim()}`;
      continue;
    }
    const i = line.indexOf(':');
    if (i > 0) out.push({ name: line.slice(0, i).trim().toLowerCase(), value: line.slice(i + 1).trim() });
  }
  return out;
}

function firstHeader(headers, name) {
  const h = headers.find((item) => item.name === name);
  return h ? h.value : '';
}

/** "R$ 1.234,56" -> 123456 (centavos). */
function toCents(text) {
  const clean = String(text).replace(/\./g, '').replace(',', '.');
  const n = Number(clean);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function fromAddress(value) {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(value) || /([^\s<>"]+@[^\s<>"]+)/.exec(value);
  return m ? m[1].toLowerCase() : '';
}

const isNubankDomain = (d) => d === 'nubank.com.br' || d.endsWith('.nubank.com.br');

/**
 * @param {{headers:string, subject?:string, text?:string}} msg  headers = bloco de cabeçalhos CRU (como no "Mostrar original")
 * @param {number} now
 * @returns {{ok:true, id:string, amountCents:number, at:number} | {ok:false, reason:string, id?:string}}
 */
function verifyNubankPix(msg, now = Date.now()) {
  const headers = parseHeaders(msg && msg.headers);
  const id = firstHeader(headers, 'message-id');
  const fail = (reason) => ({ ok: false, reason, ...(id ? { id } : {}) });

  if (!id) return fail('sem Message-ID');

  const addr = fromAddress(firstHeader(headers, 'from'));
  if (!addr || !isNubankDomain(addr.split('@')[1] || '')) return fail('remetente não é do Nubank');

  // O Authentication-Results mais alto é o do servidor que recebeu por último (o Gmail).
  const auth = firstHeader(headers, 'authentication-results');
  if (!auth) return fail('sem Authentication-Results (o Gmail não anexou a verificação)');
  if (!/^mx\.google\.com\s*;/i.test(auth)) return fail('o Authentication-Results mais alto não é do Gmail');
  const dkim = /dkim=pass\b[^;]*?header\.(?:i|d)=@?([^\s;]+)/i.exec(auth);
  if (!dkim || !isNubankDomain(dkim[1].toLowerCase())) return fail('DKIM não passou para nubank.com.br');
  const dmarc = /dmarc=pass\b[^;]*?header\.from=([^\s;]+)/i.exec(auth);
  if (!dmarc || !isNubankDomain(dmarc[1].toLowerCase())) return fail('DMARC não passou para nubank.com.br');

  const subject = String(msg.subject || '');
  if (!/recebemos sua transfer[eê]ncia via pix/i.test(subject)) return fail('assunto não é o de Pix recebido');

  const m = /Valor recebido:\s*R\$\s*([\d.]+,\d{2})/i.exec(String(msg.text || ''));
  if (!m) return fail('não achei "Valor recebido" no texto');
  const amountCents = toCents(m[1]);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return fail('valor inválido');

  const at = Date.parse(firstHeader(headers, 'date'));
  if (!Number.isFinite(at)) return fail('sem Date válido');
  if (at > now + MAX_FUTURE_MS) return fail('Date no futuro');
  if (at < now - MAX_AGE_MS) return fail('e-mail antigo demais');

  return { ok: true, id, amountCents, at };
}

module.exports = { verifyNubankPix, parseHeaders, toCents, fromAddress };
