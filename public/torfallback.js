/*
 * fdsFlix · torrent como ÚLTIMO recurso para o público (filmes).
 *
 * Só é chamado pelo index.html DEPOIS que a cascata de fontes inteira falhou. Pede candidatos a
 * /api/torrent/find (o servidor decide se há nó com banda sobrando; sem isso responde enabled:false e o
 * site mostra o erro de sempre), e toca com o FdsTorPlayer na variante divertida ("ora, ora… cinéfilo de
 * gostos peculiares"). Nada técnico aparece para a pessoa; o detalhe é `.admin-only` dentro do player.
 *
 *   FdsTorFallback.start({ id, host, onFail }) -> Promise<'started' | 'unavailable'>
 *   FdsTorFallback.stop()
 */
(function (root) {
  'use strict';

  var CONFIG = root.__FDSFLIX_CONFIG__ || {};
  var API_BASE = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  var cur = null; // { pending, player, token }
  var seq = 0;

  function headers(extra) {
    var h = extra || {};
    if (CONFIG.apiKey) h['x-api-key'] = CONFIG.apiKey;
    var k = '';
    try { k = localStorage.getItem('fdsflix.adminKey') || ''; } catch (e) { /* sem storage */ }
    if (k) h['x-stats-key'] = k;
    return h;
  }

  // Conta ao servidor quão rápido a cópia foi (ou que não serviu): a próxima pessoa já recebe a melhor primeiro.
  function learn(body) {
    try {
      fetch(API_BASE + '/api/torrent/learn', { method: 'POST', keepalive: true, headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) }).catch(function () {});
    } catch (e) { /* ok */ }
  }

  function stop() {
    seq += 1;
    if (!cur) return;
    try { if (cur.pending) cur.pending.destroy(); } catch (e) { /* ok */ }
    try { if (cur.player) cur.player.destroy(); } catch (e) { /* ok */ }
    if (cur.host) { cur.host.textContent = ''; cur.host.hidden = true; }
    cur = null;
  }

  function start(o) {
    stop();
    var my = seq;
    var host = o.host;
    if (!host || !root.FdsTorPlayer) return Promise.resolve('unavailable');
    host.hidden = false;
    cur = { host: host, pending: root.FdsTorPlayer.pending({ host: host, mode: 'public', fill: true }), player: null };

    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 45000);
    // Admin: manda os nós salvos neste navegador (o servidor só os aceita com a senha; o público nunca informa nós).
    var saved = '';
    try { saved = (JSON.parse(localStorage.getItem('fdsflix.torrentNodes') || '[]') || []).join(','); } catch (e) { /* sem storage */ }
    var nodesQs = saved && headers()['x-stats-key'] ? '&nodes=' + encodeURIComponent(saved) : '';
    return fetch(API_BASE + '/api/torrent/find?type=movie&id=' + encodeURIComponent(o.id) + nodesQs, { headers: headers(), cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { clearTimeout(to); return r.json().catch(function () { return {}; }); })
      .catch(function () { clearTimeout(to); return {}; })
      .then(function (d) {
        if (my !== seq) return 'stopped';
        if (!d || !d.enabled || !d.candidates || !d.candidates.length || !d.nodes || !d.nodes.length) { api.lastWhy = (d && d.why) || 'sem resposta'; api.lastDebug = (d && d.debug) ? JSON.stringify(d.debug) : ''; stop(); return 'unavailable'; }
        var first = d.candidates[0];
        var item = { hash: first.hash, magnet: first.magnet, size: first.size, title: '', alts: d.candidates.slice(1) };
        cur.pending.destroy();
        cur.pending = null;
        cur.player = root.FdsTorPlayer.play({
          host: host,
          mode: 'public',
          fill: true,
          item: item,
          nodes: d.nodes,
          rank: d.rank || [],
          runtimeMin: d.runtimeMin || 0,
          log: o.log || function () {},
          onReady: function (r) {
            if (my !== seq) return;
            if (o.onPlaying) o.onPlaying();
            if (r && r.kBs > 0) learn({ hash: r.hash, kBs: r.kBs, ok: true });
          },
          onSpeed: function (hash, kBs) { if (my === seq && kBs > 0) learn({ hash: hash, kBs: kBs, ok: true }); },
          onBad: function (hash) { if (my === seq) learn({ hash: hash, ok: false }); },
          onFail: function (reason, tech) { if (my === seq && o.onFail) o.onFail(reason, tech); }
        });
        if (root.FdsTorSubs) {
          root.FdsTorSubs.attach(cur.player, {
            id: o.id,
            type: 'movie',
            isDub: function (hash) {
              return d.candidates.some(function (c) { return c.dub && String(c.hash).toLowerCase() === String(hash).toLowerCase(); });
            }
          });
        }
        return 'started';
      });
  }

  var api = { start: start, stop: stop, lastWhy: '', lastDebug: '' };
  root.FdsTorFallback = api;
})(window);
