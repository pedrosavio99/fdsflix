/*
 * fdsFlix · "Torrents" (dentro de "Outras fontes"; só administrador).
 *
 * Quando o link de vídeo falha, o admin procura o MESMO título nos trackers e recebe magnet/.torrent.
 * Dublado PT-BR primeiro; o motor rejeita CAM/TS/sample e casa título + ano (mesmo rigor do vídeo).
 *
 * Nada disto existe para o visitante: a seção está dentro do diálogo .admin-only, o módulo não roda
 * sem html.is-admin e as rotas exigem a senha. Texto vindo da API entra por textContent.
 */
(function () {
  'use strict';

  var box = document.getElementById('torrentBox');
  var form = document.getElementById('torrentForm');
  var input = document.getElementById('torrentQ');
  var yearEl = document.getElementById('torrentYear');
  var resultsEl = document.getElementById('torrentResults');
  var noteEl = document.getElementById('torrentNote');
  var kitBtn = document.getElementById('torrentKit');
  if (!box || !form || !input || !resultsEl || !noteEl) return;
  if (!document.documentElement.classList.contains('is-admin')) return;

  var CONFIG = window.__FDSFLIX_CONFIG__ || {};
  var API_BASE = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  var seq = 0;

  function key() { try { return localStorage.getItem('fdsflix.adminKey') || ''; } catch (e) { return ''; } }

  function headers() {
    var h = {};
    if (CONFIG.apiKey) h['x-api-key'] = CONFIG.apiKey;
    var k = key();
    if (k) h['x-stats-key'] = k;
    return h;
  }

  function note(text, kind) {
    noteEl.textContent = text || '';
    noteEl.className = 'pix-note' + (kind ? ' ' + kind : '');
  }

  function rowOf(item) {
    var row = document.createElement('div');
    row.className = 'src-row';
    var head = document.createElement('div');
    head.className = 'src-head';
    var b = document.createElement('b');
    b.textContent = '[' + (item.audio || 'orig') + '/' + (item.quality || 'auto') + '] ' + (item.title || '');
    var meta = document.createElement('span');
    meta.className = 'src-no';
    meta.textContent = (item.seeds || 0) + ' seeds' + (item.source ? ' · ' + item.source : '');
    head.appendChild(b);
    head.appendChild(meta);
    row.appendChild(head);
    var link = item.magnet || item.torrent;
    if (link) {
      var a = document.createElement('a');
      a.href = link;
      a.textContent = item.magnet ? 'magnet' : 'arquivo .torrent';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.display = 'inline-block';
      a.style.marginTop = '.25rem';
      row.appendChild(a);
    }
    return row;
  }

  function render(data) {
    resultsEl.textContent = '';
    var res = (data && data.results) || [];
    if (!res.length) {
      note((data && data.note) || 'Nada encontrado.', 'warn');
      return;
    }
    var worked = ((data && data.sources) || []).filter(function (s) { return s.ok && s.count; })
      .map(function (s) { return s.name + ' (' + s.count + ')'; });
    note(res.length + ' resultado(s)' + (worked.length ? ' · ' + worked.join(', ') : ''));
    res.forEach(function (item) { resultsEl.appendChild(rowOf(item)); });
  }

  function search() {
    var title = String(input.value || '').trim();
    if (!title) { note('Informe o título.', 'warn'); return; }
    var my = ++seq;
    note('Procurando nos trackers…');
    resultsEl.textContent = '';
    var url = API_BASE + '/api/admin/torrents?title=' + encodeURIComponent(title) +
      '&year=' + encodeURIComponent(yearEl ? yearEl.value || '' : '');
    fetch(url, { headers: headers(), cache: 'no-store' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
          return d;
        });
      })
      .then(function (d) { if (my === seq) render(d); })
      .catch(function (e) { if (my === seq) note('Falhou: ' + e.message, 'warn'); });
  }

  function downloadKit() {
    note('Montando o kit…');
    fetch(API_BASE + '/api/admin/torrents/kit.zip', { headers: headers(), cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'fdsflix-torrent-kit.zip';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        note('Kit baixado (motor + CLI + README).');
      })
      .catch(function (e) { note('Não consegui baixar o kit: ' + e.message, 'warn'); });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); search(); });
  if (kitBtn) kitBtn.addEventListener('click', downloadKit);
})();
