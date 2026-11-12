'use strict';

/**
 * Medidor de banda de SAÍDA do próprio servidor (é o que o Render Free conta nos 5 GB).
 *
 * Conta os bytes que realmente saem por resposta HTTP, agrupados por tipo de rota, desde que o
 * processo subiu. Fica registrado no log a cada EGRESS_LOG_MIN minutos (padrão 5) e em /api/egress.
 * Reinício do Render zera o contador — o log guarda a história.
 */

const startedAt = Date.now();
const groups = new Map(); // nome -> { bytes, reqs }

function classify(pathname) {
  if (pathname === '/api/proxy') return 'video: /api/proxy';
  if (pathname === '/api/hls-proxy') return 'video: /api/hls-proxy';
  if (pathname.startsWith('/hls/')) return 'video: /hls (ffmpeg)';
  if (pathname.startsWith('/api/subtitle')) return 'legendas';
  if (pathname.startsWith('/api/usage')) return 'api: usage';
  if (pathname.startsWith('/api/visitors')) return 'api: visitors';
  if (pathname.startsWith('/api/')) return 'api: ' + (pathname.split('/')[2] || '?');
  if (pathname.startsWith('/vendor/') || pathname.startsWith('/cv/')) return 'estatico: vendor/cv';
  return 'estatico: pagina';
}

function middleware(req, res, next) {
  const name = classify(String(req.path || req.url || '/'));
  let sent = 0;
  const write = res.write;
  const end = res.end;
  res.write = function (chunk, encoding, cb) {
    if (chunk) sent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : undefined);
    return write.apply(this, arguments);
  };
  res.end = function (chunk, encoding, cb) {
    if (chunk && typeof chunk !== 'function') sent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : undefined);
    return end.apply(this, arguments);
  };
  // 'close' dispara também quando o cliente desiste no meio: conta só o que de fato foi escrito.
  res.on('close', () => {
    const g = groups.get(name) || { bytes: 0, reqs: 0 };
    g.bytes += sent;
    g.reqs += 1;
    groups.set(name, g);
  });
  next();
}

function snapshot() {
  const rows = [...groups.entries()]
    .map(([name, g]) => ({ name, mb: Number((g.bytes / 1048576).toFixed(2)), requests: g.reqs }))
    .sort((a, b) => b.mb - a.mb);
  const totalMb = Number(rows.reduce((a, r) => a + r.mb, 0).toFixed(2));
  return {
    sinceMinutes: Math.round((Date.now() - startedAt) / 60000),
    totalMb,
    note: 'Bytes de resposta HTTP desde que este processo subiu (reinício zera). Não inclui cabeçalhos TCP.',
    groups: rows
  };
}

function startLogging() {
  const minutes = Math.max(1, Number(process.env.EGRESS_LOG_MIN) || 5);
  const timer = setInterval(() => {
    const s = snapshot();
    if (!s.groups.length) return;
    console.log(
      `[egress] ${s.totalMb} MB em ${s.sinceMinutes} min · ` +
      s.groups.slice(0, 6).map((r) => `${r.name} ${r.mb} MB/${r.requests}req`).join(' · ')
    );
  }, minutes * 60 * 1000);
  timer.unref();
}

module.exports = { middleware, snapshot, startLogging };
