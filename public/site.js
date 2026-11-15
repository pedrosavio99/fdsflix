/*
 * fdsFlix · tela "Site" (só administrador): dois switches — Manutenção e "Mudamos de URL" — e o estado da API.
 * Os switches só valem ao clicar em Aplicar (evita derrubar o site com um toque sem querer).
 */
(function () {
  'use strict';

  var openBtn = document.getElementById('siteOpen');
  var dlg = document.getElementById('siteDialog');
  if (!openBtn || !dlg) return;

  var CONFIG = window.__FDSFLIX_CONFIG__ || {};
  var API_BASE = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  var $ = function (id) { return document.getElementById(id); };
  var data = null;
  var pulse = 0;

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }

  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (CONFIG.apiKey) headers['x-api-key'] = CONFIG.apiKey;
    var key = lsGet('fdsflix.adminKey');
    if (key) headers['x-stats-key'] = key;
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    opts.headers = headers;
    opts.cache = 'no-store';
    return fetch(API_BASE + path, opts);
  }
  function json(path, opts) {
    return api(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  function note(text, kind) {
    var n = $('siteNote');
    n.textContent = text || '';
    n.className = 'pix-note' + (kind ? ' ' + kind : '');
  }

  function draft() {
    return {
      maintenance: { on: $('siteMaint').checked, message: $('siteMsg').value.trim() },
      moved: { on: $('siteMoved').checked, url: $('siteUrl').value.trim() }
    };
  }

  function paintSwitches() {
    $('siteMsgBox').classList.toggle('on', $('siteMaint').checked);
    $('siteUrlBox').classList.toggle('on', $('siteMoved').checked);
  }

  function paintLive() {
    var v = $('siteVisitors');
    if (!data) { v.textContent = '…'; return; }
    var movedOn = data.moved.on && data.moved.url;
    v.textContent = movedOn ? 'o aviso de nova URL (e são levados para lá)'
      : (data.maintenance.on ? 'a tela de manutenção' : 'o site normal');
    v.className = movedOn || data.maintenance.on ? 'warn' : 'ok';
  }

  function paintPersist() {
    var p = data && data.persist;
    var parts = [];
    if (p && p.enabled && p.tablesMissing) parts.push('⚠ Rode supabase/pix-schema.sql: sem a tabela o aviso só vale até o Render reiniciar.');
    else if (p && p.lastError) parts.push('⚠ Supabase: ' + p.lastError);
    else if (p && !p.enabled) parts.push('Sem Supabase: o aviso só vale até o Render reiniciar.');
    else if (p) parts.push('✅ Guardado no Supabase: o aviso sobrevive a reinícios do Render.');
    var box = $('sitePersist');
    box.textContent = parts.join(' ');
    box.className = p && p.enabled && !p.tablesMissing && !p.lastError ? 'pix-note ok' : 'pix-note';
  }

  function fill() {
    if (!data) return;
    $('siteMaint').checked = data.maintenance.on;
    $('siteMsg').value = data.maintenance.message || '';
    $('siteMsg').placeholder = data.defaultMessage || '';
    $('siteMoved').checked = data.moved.on;
    $('siteUrl').value = data.moved.url || '';
    paintSwitches();
    paintLive();
    paintPersist();
  }

  // Saúde da API: o ping mede o tempo de resposta de verdade (e acorda o Render se estiver dormindo).
  function ping() {
    var dot = $('siteDot'); var label = $('siteApi');
    dot.className = 'dot wait'; label.textContent = 'testando…';
    var t0 = performance.now();
    api('/api/health').then(function (r) {
      var ms = Math.round(performance.now() - t0);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json().then(function (h) {
        dot.className = 'dot ok';
        label.textContent = 'no ar · ' + ms + ' ms' + (h && typeof h.sessions === 'number' ? ' · ' + h.sessions + ' sessão(ões) de vídeo' : '');
      });
    }).catch(function (err) {
      dot.className = 'dot bad';
      label.textContent = 'fora do ar ou dormindo (' + err.message + ')';
    });
  }

  function load() {
    return json('/api/site/admin').then(function (d) { data = d; fill(); }).catch(function (err) {
      note('Não consegui falar com o servidor: ' + err.message + '. No plano grátis do Render ele pode levar ~1 min para acordar.', 'err');
    });
  }

  function apply() {
    var d = draft();
    if (d.moved.on && !d.moved.url) { note('Para ligar "Mudamos de URL" informe o endereço novo.', 'err'); $('siteUrl').focus(); return; }
    if (d.maintenance.on && !(data && data.maintenance.on) &&
        !window.confirm('Ligar a manutenção derruba o site para todos os visitantes (menos você). Continuar?')) return;
    note('Aplicando…');
    json('/api/site/set', { method: 'POST', body: JSON.stringify(d) }).then(function (out) {
      data = out; fill();
      note(out.maintenance.on || out.moved.on ? 'Aplicado. Os visitantes já veem o aviso (até ~45 s para a aba aberta atualizar).' : 'Aplicado: o site está normal para todos.', 'ok');
      if (window.FdsSiteGate) window.FdsSiteGate.refresh();
    }).catch(function (err) { note(err.message, 'err'); });
  }

  function preview(which) {
    var d = draft();
    if (!window.FdsSiteGate) return;
    if (which === 'moved' && !d.moved.url) { note('Digite o endereço novo para ver a prévia.', 'err'); return; }
    dlg.close();
    window.FdsSiteGate.preview(which, which === 'moved' ? { url: d.moved.url.indexOf('://') < 0 ? 'https://' + d.moved.url : d.moved.url } : { message: d.maintenance.message || (data && data.defaultMessage) });
  }

  openBtn.addEventListener('click', function () {
    note('');
    if (!dlg.open) dlg.showModal();
    load();
    ping();
    clearInterval(pulse);
    pulse = setInterval(function () { if (dlg.open) ping(); else clearInterval(pulse); }, 20000);
  });
  $('siteClose').addEventListener('click', function () { dlg.close(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', function () { clearInterval(pulse); });
  $('siteMaint').addEventListener('change', paintSwitches);
  $('siteMoved').addEventListener('change', paintSwitches);
  $('siteApply').addEventListener('click', apply);
  $('sitePing').addEventListener('click', ping);
  $('sitePrevMaint').addEventListener('click', function () { preview('maintenance'); });
  $('sitePrevMoved').addEventListener('click', function () { preview('moved'); });
})();
