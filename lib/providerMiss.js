'use strict';

/**
 * Memória curta de "esta fonte já respondeu SEM resultado para este título".
 *
 * Serve para que as duas etapas de abrir um vídeo (descobrir as versões e a cascata normal) não
 * repitam a mesma pesquisa que acabou de falhar: o que uma viu vazio a outra pula por alguns segundos.
 * Só guarda "sem resultado" limpo (nunca erro/tempo esgotado: esses podem ser passageiros) e vence
 * rápido, para o "↻ Recarregar" e a próxima tentativa fazerem busca de verdade.
 */

const TTL_MS = 25 * 1000;
const MAX = 2000;
const misses = new Map(); // "tipo:id:SxE:fonte" -> expira em

function key(type, id, s, e, name) {
  return `${type}:${id}:${type === 'tv' ? `${s}x${e}` : ''}:${name}`;
}

function note(type, id, s, e, name) {
  misses.set(key(type, id, s, e, name), Date.now() + TTL_MS);
  while (misses.size > MAX) misses.delete(misses.keys().next().value);
}

function recent(type, id, s, e, name) {
  const k = key(type, id, s, e, name);
  const until = misses.get(k);
  if (!until) return false;
  if (until < Date.now()) { misses.delete(k); return false; }
  return true;
}

function clear() { misses.clear(); }

module.exports = { note, recent, clear, TTL_MS };
