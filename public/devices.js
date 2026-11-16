/*
 * fdsFlix · aba "Aparelhos" (só administrador): apps para TV. Hoje só o Roku.
 * Baixa o .zip pronto (o servidor embute o próprio endereço) e mostra o passo a passo de instalação.
 * Tudo que vem da API entra por textContent.
 */
(function () {
  'use strict';

  var openBtn = document.getElementById('devOpen');
  var dlg = document.getElementById('devDialog');
  if (!openBtn || !dlg) return;

  var CONFIG = window.__FDSFLIX_CONFIG__ || {};
  var API_BASE = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  var $ = function (id) { return document.getElementById(id); };

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }

  function api(path) {
    var headers = {};
    if (CONFIG.apiKey) headers['x-api-key'] = CONFIG.apiKey;
    var key = lsGet('fdsflix.adminKey');
    if (key) headers['x-stats-key'] = key;
    return fetch(API_BASE + path, { headers: headers, cache: 'no-store' });
  }

  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }

  function status(text) { $('devStatus').textContent = text || ''; }

  // [texto] vira uma tecla (kbd). Tudo entra por textContent, nunca por HTML.
  function rich(parent, text) {
    String(text).split(/(\[[^\]]+\])/).forEach(function (part) {
      if (/^\[[^\]]+\]$/.test(part)) parent.appendChild(el('kbd', part.slice(1, -1)));
      else if (part) parent.appendChild(document.createTextNode(part));
    });
  }

  var ROKU_MANUAL = [
    { t: 'Ligue o modo desenvolvedor na TV', d: 'Com a TV na tela inicial, digite no controle: [Home] [Home] [Home] [↑] [↑] [→] [←] [→] [←] [→]. Abre a tela "Developer Settings": escolha "Enable installer and restart", aceite os termos e crie uma senha (anote). A TV reinicia.' },
    { t: 'Anote o IP da TV', d: 'Ao reiniciar, a tela do modo desenvolvedor mostra o IP (ex.: 192.168.0.25). Se perder: Configurações → Rede → Sobre. O PC (ou celular) precisa estar no mesmo Wi-Fi da TV.' },
    { t: 'Abra a página de instalação', d: 'No navegador do PC, digite http://IP-DA-TV. Usuário: rokudev. Senha: a que você criou no passo 1.' },
    { t: 'Envie o zip', d: 'Baixe o fdsflix-roku.zip aqui em cima. Na página da TV: [Upload] → escolha o arquivo → [Install]. O canal fdsFlix abre sozinho e fica no fim da tela inicial.' },
    { t: 'Use com o controle', d: 'Setas navegam, [OK] escolhe, [Voltar] volta/sai. Durante o filme, [*] (asterisco) abre "Outra versão" se o vídeo estiver errado ou não tocar. Dublado ou original é perguntado quando o título tem as duas.' }
  ];

  var ROKU_TIPS = [
    'Só cabe um canal instalado desse jeito por vez: instalar de novo substitui o anterior. Para remover: na mesma página da TV, "Delete app".',
    'Quase nunca precisa reinstalar: busca, fontes, legendas e troca de versão ficam no servidor e mudam só com o deploy. Baixe o zip de novo apenas se a interface do app mudar.',
    'Primeira abertura demorando em "Carregando…": o servidor gratuito acorda em cerca de 1 minuto.',
    'O zip sai com o endereço do servidor de onde você baixou. Baixe pelo site publicado (https), não pelo teste local.'
  ];

  function render(list) {
    var box = $('devList');
    box.textContent = '';
    list.forEach(function (d) {
      var card = el('div', null, 'cfg-card dev-card');

      var head = el('div', null, 'dev-head');
      var logo = el('span', null, 'dev-logo');
      logo.appendChild(document.createTextNode('fds'));
      logo.appendChild(el('b', 'Flix'));
      head.appendChild(logo);
      head.appendChild(el('span', d.name, 'dev-name'));
      card.appendChild(head);

      var dl = el('div', null, 'dev-dl');
      var btn = el('button', 'Baixar ' + d.file);
      btn.type = 'button';
      btn.disabled = !d.available;
      btn.addEventListener('click', function () { download(d, btn); });
      dl.appendChild(btn);
      dl.appendChild(el('span', 'Servidor embutido: ' + d.api, 'dev-api'));
      card.appendChild(dl);
      if (!d.available) card.appendChild(el('p', 'A pasta do app não está neste servidor.'));
      if (d.local) {
        card.appendChild(el('p', 'Teste local: o app vai falar com este PC (' + d.api + '). A TV precisa estar no mesmo Wi-Fi e o servidor precisa continuar rodando; se o firewall bloquear, libere a porta. Para uso normal, baixe pelo site publicado.', 'cfg-note'));
      } else if (!d.https) {
        card.appendChild(el('p', 'Atenção: este endereço não é HTTPS. Baixe pelo site publicado para o app apontar para o servidor certo.', 'cfg-note'));
      }

      var man = el('details', null, 'dev-manual');
      man.open = true;
      man.appendChild(el('summary', 'Como instalar no Roku'));
      var ol = el('ol');
      ROKU_MANUAL.forEach(function (step) {
        var li = el('li');
        li.appendChild(el('b', step.t));
        var p = el('p');
        rich(p, step.d);
        li.appendChild(p);
        ol.appendChild(li);
      });
      man.appendChild(ol);
      man.appendChild(el('h4', 'Bom saber'));
      var ul = el('ul');
      ROKU_TIPS.forEach(function (t) { ul.appendChild(el('li', t)); });
      man.appendChild(ul);
      card.appendChild(man);

      box.appendChild(card);
    });
  }

  function download(d, btn) {
    btn.disabled = true;
    status('Montando o canal…');
    api(d.download)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = d.file;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        status('Baixado (' + Math.round(blob.size / 1024) + ' KB). Siga os passos acima.');
      })
      .catch(function (err) { status('Não consegui baixar: ' + err.message); })
      .then(function () { btn.disabled = false; });
  }

  function load() {
    status('Carregando…');
    api('/api/admin/devices')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) { render(data.devices || []); status(''); })
      .catch(function (err) { status('Não consegui carregar: ' + err.message); });
  }

  openBtn.addEventListener('click', function () {
    if (!dlg.open) dlg.showModal();
    load();
  });
  $('devClose').addEventListener('click', function () { dlg.close(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
})();
