/*
 * fdsFlix · tela "Pix" (só administrador). Teste de permissão por pagamento Pix.
 * Gera a cobrança do aparelho, mostra o QR/copia-e-cola e acompanha até o servidor confirmar (e-mail do Nubank).
 * Quando confirma, mostra só o selo "Acesso liberado por 10 min". Tudo é texto (textContent): nada de HTML vindo do servidor.
 */
(function () {
  'use strict';

  var openBtn = document.getElementById('pixOpen');
  var dlg = document.getElementById('pixDialog');
  if (!openBtn || !dlg) return;

  var CONFIG = window.__FDSFLIX_CONFIG__ || {};
  var API_BASE = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  var LS_DEVICE = 'fdsflix.deviceId';
  var LS_SETTINGS = 'fdsflix.pix.settings';
  var POLL_MS = 4000;

  var $ = function (id) { return document.getElementById(id); };
  var st = { data: null, charge: null, code: '', timer: 0, tick: 0, busy: false, paidShown: false };

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sem storage */ } }

  // Identifica ESTE aparelho (o servidor guarda de qual aparelho veio cada pagamento).
  function deviceId() {
    var id = lsGet(LS_DEVICE);
    if (!/^[\w-]{8,64}$/.test(id)) {
      var rnd = window.crypto && crypto.randomUUID ? crypto.randomUUID() : ('d' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
      id = rnd.slice(0, 64);
      lsSet(LS_DEVICE, id);
    }
    return id;
  }

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
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function money(cents) { return 'R$ ' + (cents / 100).toFixed(2).replace('.', ','); }
  function clock(ms) { return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function mmss(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function ago(ms) {
    if (!ms) return 'nunca';
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < 90) return 'há ' + Math.max(s, 0) + ' s';
    return 'há ' + Math.round(s / 60) + ' min';
  }

  function setText(id, text) { var n = $(id); if (n) n.textContent = text || ''; }
  function note(text, kind) {
    var n = $('pixNote');
    n.textContent = text || '';
    n.className = 'pix-note' + (kind ? ' ' + kind : '');
  }

  /* ------------------------------ selo de acesso ------------------------------ */

  function paintBadge() {
    var badge = $('pixBadge');
    var access = st.data && st.data.access;
    if (!access) { badge.hidden = true; return; }
    var left = access.until - (Date.now() + (st.skew || 0));
    if (left <= 0) { badge.hidden = true; st.data.access = null; return; }
    badge.hidden = false;
    badge.textContent = '✅ Acesso liberado por 10 min · restam ' + mmss(left);
  }

  /* ------------------------------ QR e cobrança ------------------------------ */

  function paintQr(code) {
    var box = $('pixQr');
    box.textContent = '';
    if (!code) return;
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(code);
      qr.make();
      var img = new Image();
      img.alt = 'QR Code do Pix';
      img.src = qr.createDataURL(5, 2);
      box.appendChild(img);
    } catch (e) {
      box.textContent = 'Não consegui desenhar o QR; use o copia-e-cola.';
    }
  }

  function paintCharge() {
    var c = st.charge;
    $('pixPay').hidden = !c || c.status !== 'pending';
    if (!c) { setText('pixWait', ''); return; }
    if (c.status === 'pending') {
      $('pixCode').value = st.code;
      paintQr(st.code);
      var left = c.expiresAt - (Date.now() + (st.skew || 0));
      setText('pixWait', 'Aguardando o pagamento de ' + money(c.amountCents) + ' · vale por mais ' + mmss(left));
    } else if (c.status === 'expired') {
      setText('pixWait', 'Essa cobrança venceu. Gere outra.');
    }
  }

  function paintHistory() {
    var list = $('pixHistory');
    list.textContent = '';
    var rows = (st.data && st.data.history) || [];
    if (!rows.length) { var li0 = document.createElement('li'); li0.textContent = 'Nenhuma cobrança ainda.'; list.appendChild(li0); return; }
    rows.forEach(function (r) {
      var li = document.createElement('li');
      var tag = document.createElement('b');
      tag.textContent = r.status === 'paid' ? '✅ pago' : (r.status === 'pending' ? '⏳ aguardando' : '⌛ venceu');
      li.appendChild(tag);
      li.appendChild(document.createTextNode(' · ' + money(r.amountCents) + ' · ' + clock(r.createdAt) + ' · ' + (r.device || 'aparelho ?') +
        (r.visitor ? ' · ' + r.visitor : '')));
      list.appendChild(li);
    });
  }

  function paintNode() {
    var d = st.data;
    if (!d) return;
    var s = d.settings;
    $('pixMicroUrl').placeholder = s.microUrl || 'https://seu-no.wasmer.app';
    if (s.microUrl && !$('pixMicroUrl').value) $('pixMicroUrl').value = s.microUrl;
    setText('pixPixInfo', s.pix ? 'Salvo: chave ' + s.pix.keyHint + ' · ' + s.pix.name + ' · ' + money(s.pix.amountCents) : 'Nenhum código Pix salvo ainda.');
    $('pixKit').disabled = !s.kitReady;
    $('pixScript').disabled = !s.kitReady || !s.microUrl;
    var parts = [];
    if (!s.kitReady) parts.push('Sem Supabase no servidor: não dá para gerar a chave do nó.');
    if (d.persist && d.persist.enabled && d.persist.tablesMissing) parts.push('⚠ Rode supabase/pix-schema.sql no Supabase: sem isso nada fica guardado.');
    else if (d.persist && d.persist.lastError) parts.push('⚠ Supabase: ' + d.persist.lastError);
    if (!d.persist || !d.persist.enabled) parts.push('Sem Supabase: os pagamentos ficam só na memória do servidor.');
    var m = d.micro || {};
    if (s.microUrl) {
      parts.push('Gmail avisou o nó ' + ago(m.lastPushAt) + (m.lastError ? ' · erro do nó: ' + m.lastError : ''));
      if (m.rejected && m.rejected.length) parts.push('Último e-mail recusado: ' + m.rejected[0].reason);
    }
    setText('pixNodeInfo', parts.join(' · '));
  }

  function paintAll() {
    paintBadge();
    paintCharge();
    paintHistory();
    paintNode();
    var s = st.data && st.data.settings;
    $('pixGen').disabled = st.busy || !s || !s.pix || (st.charge && st.charge.status === 'pending');
    $('pixGen').textContent = s && s.pix ? 'Gerar cobrança de ' + money(s.pix.amountCents) : 'Gerar cobrança';
  }

  /* ------------------------------ comunicação ------------------------------ */

  // Se o servidor reiniciou (plano grátis) antes do Supabase estar pronto, devolve as configurações guardadas neste navegador.
  function restoreSettings(data) {
    var saved = lsGet(LS_SETTINGS);
    if (!saved || (data.settings.pix && data.settings.microUrl)) return Promise.resolve(data);
    var body;
    try { body = JSON.parse(saved); } catch (e) { return Promise.resolve(data); }
    var send = {};
    if (!data.settings.microUrl && body.microUrl) send.microUrl = body.microUrl;
    if (!data.settings.pix && body.pixCode) send.pixCode = body.pixCode;
    if (!send.microUrl && !send.pixCode) return Promise.resolve(data);
    return json('/api/pix/settings', { method: 'POST', body: JSON.stringify(send) })
      .then(function () { return json('/api/pix/state?deviceId=' + encodeURIComponent(deviceId())); })
      .catch(function () { return data; });
  }

  function load() {
    return json('/api/pix/state?deviceId=' + encodeURIComponent(deviceId())).then(restoreSettings).then(function (data) {
      st.data = data;
      st.skew = data.now - Date.now();
      if (data.current && (!st.charge || st.charge.status !== 'paid')) { st.charge = data.current.charge; st.code = data.current.code; }
      paintAll();
      schedule();
    }).catch(function (err) {
      note('Não consegui falar com o servidor: ' + err.message + '. No plano grátis do Render ele pode levar ~1 min para acordar.', 'err');
    });
  }

  function poll() {
    if (!st.charge || st.charge.status !== 'pending' || !dlg.open) return;
    json('/api/pix/status?id=' + encodeURIComponent(st.charge.id) + '&deviceId=' + encodeURIComponent(deviceId())).then(function (out) {
      st.charge = out.charge;
      if (st.data) st.data.access = out.access;
      if (out.charge.status === 'paid') { note('Pagamento confirmado!', 'ok'); load(); return; }
      paintCharge();
      if (out.charge.status !== 'pending') load();
    }).catch(function (err) { note('Consulta falhou: ' + err.message, 'err'); });
  }

  function schedule() {
    clearInterval(st.timer);
    clearInterval(st.tick);
    if (!dlg.open) return;
    st.tick = setInterval(function () { paintBadge(); if (st.charge && st.charge.status === 'pending') paintCharge(); }, 1000);
    if (st.charge && st.charge.status === 'pending') st.timer = setInterval(poll, POLL_MS);
  }

  function generate() {
    st.busy = true; paintAll(); note('Gerando…');
    json('/api/pix/charge', { method: 'POST', body: JSON.stringify({ deviceId: deviceId() }) }).then(function (out) {
      st.charge = out.charge; st.code = out.code;
      note(out.reused ? 'Você já tinha uma cobrança aberta: reaproveitei.' : '', '');
    }).catch(function (err) { note(err.message, 'err'); }).then(function () {
      st.busy = false;
      return load();
    });
  }

  function saveSettings() {
    var microUrl = $('pixMicroUrl').value.trim();
    var pixCode = $('pixCodeIn').value.trim();
    if (!microUrl && !pixCode) { note('Preencha a URL do nó e/ou o código Pix.', 'err'); return; }
    note('Salvando…');
    json('/api/pix/settings', { method: 'POST', body: JSON.stringify({ microUrl: microUrl, pixCode: pixCode }) }).then(function () {
      var keep = {};
      try { keep = JSON.parse(lsGet(LS_SETTINGS) || '{}'); } catch (e) { keep = {}; }
      if (microUrl) keep.microUrl = microUrl;
      if (pixCode) keep.pixCode = pixCode;
      lsSet(LS_SETTINGS, JSON.stringify(keep));
      $('pixCodeIn').value = '';
      note('Salvo.', 'ok');
      return load();
    }).catch(function (err) { note(err.message, 'err'); });
  }

  function download(path, filename, type) {
    note('Preparando o arquivo…');
    api(path).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (d) { throw new Error(d.error || ('HTTP ' + r.status)); });
      return r.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([blob], { type: type }));
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      note('Arquivo baixado: ' + filename, 'ok');
    }).catch(function (err) { note(err.message, 'err'); });
  }

  function ping() {
    note('Testando o nó…');
    json('/api/pix/ping', { method: 'POST', body: '{}' }).then(function (out) {
      note('Nó ok · Gmail avisou ' + ago(out.lastPushAt) + ' · ' + out.events + ' e-mail(s) do Nubank na última hora.', 'ok');
      return load();
    }).catch(function (err) { note('Nó: ' + err.message, 'err'); });
  }

  /* ------------------------------ ligações ------------------------------ */

  function open() {
    note('');
    st.paidShown = false;
    if (!dlg.open) dlg.showModal();
    load();
  }
  openBtn.addEventListener('click', open);
  $('pixClose').addEventListener('click', function () { dlg.close(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', function () { clearInterval(st.timer); clearInterval(st.tick); });
  $('pixGen').addEventListener('click', generate);
  $('pixSave').addEventListener('click', saveSettings);
  $('pixPing').addEventListener('click', ping);
  $('pixKit').addEventListener('click', function () { download('/api/pix/kit', 'fdsflix-pix-kit.zip', 'application/zip'); });
  $('pixScript').addEventListener('click', function () { download('/api/pix/script', 'gmail-pix.gs', 'text/plain'); });
  $('pixCopy').addEventListener('click', function () {
    var done = function () { note('Código copiado. Cole no app do seu banco (Pix copia e cola).', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(st.code).then(done, function () { $('pixCode').select(); });
    else { $('pixCode').select(); try { document.execCommand('copy'); done(); } catch (e) { /* o usuário copia à mão */ } }
  });
})();
