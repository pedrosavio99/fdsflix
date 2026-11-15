'use strict';

/**
 * Proteção do /api/stream contra estouro de manada. Duas coisas, ambas invisíveis no uso normal:
 *
 *  1. JUNTA PEDIDOS IGUAIS EM VOO. Se 100 pessoas pedem o mesmo filme (mesma URL, mesmo host) enquanto a primeira
 *     busca ainda está rodando, só a primeira percorre a cascata; as outras recebem a MESMA resposta assim que ela
 *     sai. Nada fica guardado depois da resposta: o próximo pedido (inclusive o "↻ Recarregar") faz uma busca nova.
 *  2. LIMITA CASCATAS SIMULTÂNEAS (padrão 30: só pega em pane de verdade; no caso feliz a busca espera rede, não CPU). Quando as fontes caem, cada busca fica dezenas de segundos raspando
 *     provedores; sem limite elas se acumulam e engasgam o servidor. Passando do limite, o pedido espera na fila, e
 *     NUNCA é recusado: depois de QUEUE_WAIT_MS ele roda mesmo assim (no pior caso, igual a como era antes).
 *
 * O administrador (senha) nunca é juntado nem enfileirado: ele quer o diagnóstico próprio de cada tentativa.
 * Qualquer coisa inesperada cai em next(): o handler original roda como se este módulo não existisse.
 */

function createStreamGuard(options = {}) {
  const maxActive = Math.max(1, Number(options.maxActive) || 30);
  const queueWaitMs = options.queueWaitMs == null ? 30000 : Math.max(0, Number(options.queueWaitMs));
  const followWaitMs = options.followWaitMs == null ? 70000 : Math.max(0, Number(options.followWaitMs));
  const isAdmin = typeof options.isAdmin === 'function' ? options.isAdmin : () => false;

  const flights = new Map(); // chave -> { promise, resolve }
  const waiters = [];
  let active = 0;
  const stats = { led: 0, coalesced: 0, queued: 0, queueTimeouts: 0, peakActive: 0 };

  function acquire() {
    const grant = () => {
      active += 1;
      if (active > stats.peakActive) stats.peakActive = active;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
        const next = waiters.shift();
        if (next) next.go();
      };
    };
    if (active < maxActive) return Promise.resolve(grant());
    stats.queued += 1;
    return new Promise((resolve) => {
      const waiter = {};
      const timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        stats.queueTimeouts += 1;
        resolve(grant()); // espera esgotada: roda mesmo assim, nunca recusa
      }, queueWaitMs);
      if (timer.unref) timer.unref();
      waiter.go = () => { clearTimeout(timer); resolve(grant()); };
      waiters.push(waiter);
    });
  }

  function keyOf(req) {
    return `${req.protocol || ''}://${req.get ? req.get('host') || '' : ''}${req.originalUrl || req.url || ''}`;
  }

  function middleware(req, res, next) {
    try {
      if (isAdmin(req)) return next();
      const key = keyOf(req);
      const existing = flights.get(key);

      if (existing) {
        stats.coalesced += 1;
        let done = false;
        const finish = (out) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (res.headersSent || res.writableEnded || res.destroyed) return;
          if (out) return res.status(out.status).json(out.body);
          return middleware(req, res, next); // quem liderava não entregou JSON: este pedido faz a própria busca
        };
        const timer = setTimeout(() => finish(null), followWaitMs);
        if (timer.unref) timer.unref();
        existing.promise.then(finish, () => finish(null));
        return undefined;
      }

      let resolveFlight;
      const promise = new Promise((resolve) => { resolveFlight = resolve; });
      const flight = { promise, resolve: resolveFlight };
      flights.set(key, flight);
      stats.led += 1;

      let release = () => {};
      let settled = false;
      const settle = (out) => {
        if (settled) return;
        settled = true;
        if (flights.get(key) === flight) flights.delete(key);
        resolveFlight(out);
      };

      const originalJson = res.json.bind(res);
      res.json = (body) => {
        settle({ status: res.statusCode || 200, body });
        release();
        return originalJson(body);
      };
      res.on('close', () => { settle(null); release(); });

      acquire().then((rel) => {
        release = rel;
        if (settled) { rel(); return; } // o cliente já foi embora e ninguém depende disto
        next();
      }, () => next());
    } catch (err) {
      return next();
    }
    return undefined;
  }

  return { middleware, stats: () => ({ ...stats, active, waiting: waiters.length, inFlight: flights.size, maxActive }) };
}

module.exports = { createStreamGuard };
