/*
 * fdsFlix · Configs: "Falhas de reprodução" e "Fontes mais usadas" (só administrador).
 *
 * Lê /api/admin/play-report (lib/playReports.js) quando a tela Configs abre. Todo texto entra por textContent: título e
 * motivo vêm do navegador de quem assistiu e não são confiáveis.
 */
(function () {
  'use strict';

  var CONFIG = window.__FDSFLIX_CONFIG__ || {};
  var API_BASE = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  var $ = function (id) { return document.getElementById(id); };
  if (!$('rpSec')) return;

  var STAGES = {
    busca: 'Procurando o vídeo', player: 'No player', espera: 'Carregando sem começar',
    troca: 'Pediu outra versão', rede: 'Conexão caiu', torrent: 'Torrent'
  };
  var last = null;
  var seq = 0;

  function adminKey() { try { return localStorage.getItem('fdsflix.adminKey') || ''; } catch (e) { return ''; } }

  function api(path) {
    var headers = { 'x-stats-key': adminKey() };
    if (CONFIG.apiKey) headers['x-api-key'] = CONFIG.apiKey;
    return fetch(API_BASE + path, { headers: headers, cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function when(iso) {
    return iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  }

  function name(e) {
    return e.title + (e.kind === 'series' && e.season ? ' · T' + e.season + 'E' + e.episode : '');
  }

  function paintSources(d) {
    var box = $('rpSources');
    box.textContent = '';
    if (!d.sources.length) { box.appendChild(el('p', '', 'Ainda sem dados. Aparece assim que alguém assistir.')); return; }
    d.sources.forEach(function (s) {
      var row = el('div', 'rp-src');
      var fill = el('i');
      fill.style.width = Math.max(s.pct, s.plays ? 2 : 0) + '%';
      row.appendChild(fill);
      row.appendChild(el('span', 'rp-name', s.source));
      row.appendChild(el('b', '', String(s.pct).replace('.', ',') + '%'));
      var bits = [s.plays + ' tocaram'];
      if (s.delivered) bits.push(s.delivered + ' links entregues');
      if (s.fails) bits.push(s.fails + ' com problema');
      if (s.successPct !== null) bits.push(String(s.successPct).replace('.', ',') + '% deu certo');
      row.appendChild(el('small', '', bits.join(' · ')));
      box.appendChild(row);
    });
  }

  function traceTable(trace) {
    var table = el('table', 'st-table');
    var head = el('tr');
    ['Fonte', 'Resultado', 'Tempo', 'Motivo'].forEach(function (t) { head.appendChild(el('th', '', t)); });
    table.appendChild(head);
    trace.forEach(function (t) {
      var tr = el('tr');
      [t.p, t.o, t.ms ? (t.ms / 1000).toFixed(1).replace('.', ',') + ' s' : '—', t.n || ''].forEach(function (v) { tr.appendChild(el('td', '', v)); });
      table.appendChild(tr);
    });
    return table;
  }

  function errorItem(e) {
    var item = el('details', 'rp-err');
    var sum = el('summary');
    sum.appendChild(el('span', 'st-pill ' + (e.resolvedBy ? 'ok' : 'err'), e.resolvedBy ? 'tocou depois' : 'não tocou'));
    sum.appendChild(el('strong', '', ' ' + name(e)));
    sum.appendChild(el('span', 'rp-meta', ' · ' + when(e.at) + ' · ' + e.reason + (e.admin ? ' · (você)' : '')));
    item.appendChild(sum);
    var body = el('div');
    [
      ['Etapa', STAGES[e.stage] || e.stage],
      ['Fonte em uso', e.source || (e.stage === 'busca' ? 'nenhuma entregou' : '—')],
      ['Motivo', e.reason + (e.status ? ' (HTTP ' + e.status + ')' : '')],
      ['Detalhe', e.detail],
      ['Depois tocou por', e.resolvedBy],
      ['Aparelho', [e.device, e.visitor].filter(Boolean).join(' · ')],
      ['TMDB', e.tmdbId]
    ].forEach(function (p) {
      if (!p[1]) return;
      var line = el('p');
      line.appendChild(el('strong', '', p[0] + ': '));
      line.appendChild(document.createTextNode(p[1]));
      body.appendChild(line);
    });
    if (e.trace && e.trace.length) {
      body.appendChild(el('p', '', 'Fontes tentadas nessa busca:'));
      body.appendChild(traceTable(e.trace));
    }
    item.appendChild(body);
    return item;
  }

  function paintErrors(d) {
    var only = $('rpOnly').checked;
    var titles = $('rpTitles');
    titles.textContent = '';
    var list = d.titles.filter(function (t) { return !only || t.unresolved; });
    if (list.length) {
      var table = el('table', 'st-table');
      var head = el('tr');
      ['Título', 'Último motivo', 'Última vez', 'Falhas (sem tocar)'].forEach(function (t) { head.appendChild(el('th', '', t)); });
      table.appendChild(head);
      list.slice(0, 20).forEach(function (t) {
        var tr = el('tr');
        [name(t), t.lastReason, when(t.lastAt), t.count + ' (' + t.unresolved + ')'].forEach(function (v) { tr.appendChild(el('td', '', v)); });
        table.appendChild(tr);
      });
      titles.appendChild(table);
    }

    var box = $('rpList');
    box.textContent = '';
    var errs = d.errors.filter(function (e) { return !only || !e.resolvedBy; });
    if (!errs.length) { box.appendChild(el('p', '', 'Nenhuma falha no período. 🎉')); return; }
    errs.forEach(function (e) { box.appendChild(errorItem(e)); });
  }

  function paint(d) {
    var st = d.storage || {};
    var pill = $('rpPill');
    pill.className = 'st-pill ' + (st.provider === 'supabase' && !st.tablesMissing && !st.lastError ? 'ok' : 'warn');
    pill.textContent = st.tablesMissing ? 'falta criar a tabela' : st.provider === 'supabase' ? (st.lastError ? 'Supabase com erro' : 'salvo no Supabase') : 'só na memória';
    $('rpMsg').textContent = d.totals.errors + ' falha(s), ' + d.totals.unresolved + ' sem tocar depois · ' + d.totals.plays + ' vídeos tocados' +
      (st.tablesMissing ? '. Rode o SQL no Supabase (botão abaixo); até lá o histórico zera quando o servidor reinicia.' : '') +
      (st.lastError && !st.tablesMissing ? '. ' + st.lastError : '');
    $('rpSql').hidden = !st.tablesMissing;
    paintSources(d);
    paintErrors(d);
  }

  function load() {
    var my = ++seq;
    $('rpMsg').textContent = 'Carregando…';
    api('/api/admin/play-report?days=' + encodeURIComponent($('rpDays').value))
      .then(function (r) { return r.json(); })
      .then(function (d) { if (my === seq) { last = d; paint(d); } })
      .catch(function (err) { if (my === seq) $('rpMsg').textContent = 'Não consegui carregar: ' + err.message; });
  }

  $('cfgOpen').addEventListener('click', load);
  if ($('bwCorner')) $('bwCorner').addEventListener('click', load);
  $('rpRefresh').addEventListener('click', load);
  $('rpDays').addEventListener('change', load);
  $('rpOnly').addEventListener('change', function () { if (last) paintErrors(last); });
  $('rpSql').addEventListener('click', function () {
    api('/api/admin/play-report/schema')
      .then(function (r) { return r.text(); })
      .then(function (sql) {
        var done = function () { $('rpMsg').textContent = 'SQL copiado: cole no Supabase → SQL Editor → Run.'; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(sql).then(done, function () { window.prompt('Copie o SQL:', sql); });
        else window.prompt('Copie o SQL:', sql);
      })
      .catch(function (err) { $('rpMsg').textContent = 'Não consegui buscar o SQL: ' + err.message; });
  });
})();
