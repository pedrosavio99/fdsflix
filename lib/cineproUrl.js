'use strict';

/**
 * Utilitários de URL do CinePro embutido.
 *
 * O CinePro pode devolver URLs com "localhost" ou "127.0.0.1" (ou a porta dele)
 * dependendo da configuração. Tudo que apontar para a MESMA máquina/porta da
 * base configurada é normalizado para a base; qualquer outro host é rejeitado.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

function cineproBase() {
  try {
    return new URL(process.env.CINEPRO_API_BASE || 'http://localhost:3001');
  } catch (err) {
    return null;
  }
}

/** @returns {string|null} URL reescrita para a base do CinePro, ou null se for de outro lugar. */
function normalizeCineProUrl(raw, relativeTo) {
  const base = cineproBase();
  if (!base) return null;

  let url;
  try {
    url = new URL(raw, relativeTo || base);
  } catch (err) {
    return null;
  }

  if (url.origin === base.origin) return url.toString();

  const sameMachine = LOOPBACK.has(base.hostname) && LOOPBACK.has(url.hostname);
  if (sameMachine && url.port === base.port && url.protocol === base.protocol) {
    url.hostname = base.hostname;
    return url.toString();
  }
  return null;
}

/** "1080p" / "1080" / "HD" -> "1080" ou "auto" (o front acrescenta o "p"). */
function cleanQuality(quality) {
  const m = String(quality || '').match(/(\d{3,4})/);
  return m ? m[1] : 'auto';
}

module.exports = { normalizeCineProUrl, cleanQuality, cineproBase };
