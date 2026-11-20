/*
 * fdsFlix · tela "Carga" (só administrador): o servidor está aguentando?
 * Mesmo com a tela fechada, o ponto no botão muda de cor (verde / amarelo / vermelho) e, quando piora, aparece um aviso
 * no topo e o título da aba ganha o ícone do estado. Com a tela aberta, atualiza a cada 3 s.
 * Tudo o que vem da API entra por textContent (nada de HTML).
 */
(function () {
  'use strict';

  var openBtn = document.getElementById('loadOpen');
  var dlg = document.getElementById('loadDialog');
  if (!openBtn || !dlg) return;

  var CONFIG = window.__FDSFLIX_CONFIG__ || {};
  var API_BASE = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  var $ = function (id) { return document.getElementById(id); };
  var BG_MS = 15000;
  var LIVE_MS = 3000;
  var RANK = { ok: 0, warn: 1, bad: 2 };
  var ICON = { ok: '', warn: '🟡 ', bad: '🔴 ' };
  var baseTitle = document.title;
  var lastLevel = 'ok';
  var timer = 0;
  var floatTimer = 0;
  var inFlight = false;
  var floatEl = null;

  function adminKey() { try { return localStorage.getItem('fdsflix.adminKey') || ''; } catch (e) { return ''; } }

  function fetchLoad(lite) {
    var headers = { 'x-stats-key': adminKey() };
    if (CONFIG.apiKey) headers['x-api-key'] = CONFIG.apiKey;
    return fetch(API_BASE + '/api/admin/load' + (lite ? '?lite=1' : ''), { headers: headers, cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* ------------------------------ formatação ------------------------------ */

  function fmtInt(n) { return n == null ? '–' : String(Math.round(n)); }
  function fmtMs(n) { return n == null ? '–' : (n >= 1000 ? (n / 1000).toFixed(1) + ' s' : Math.round(n) + ' ms'); }
  function fmtCores(c) { return c >= 1 ? c.toFixed(1).replace('.', ',') + ' CPU' : (Math.round(c * 100) / 100).toString().replace('.', ',') + ' CPU'; }
  function lvl(value, warn, bad) { return value == null ? 'ok' : (value >= bad ? 'bad' : (value >= warn ? 'warn' : 'ok')); }
  function setText(id, text) { var e = $(id); if (e) e.textContent = text; }
  function setLevel(tile, level) { if (!tile) return; tile.classList.remove('warn', 'bad'); if (level !== 'ok') tile.classList.add(level); }
  function tileOf(id) { var e = $(id); return e ? e.closest('.ld-tile') : null; }

  var HEAD = {
    ok: ['Tudo tranquilo', 'O servidor está com folga.'],
    warn: ['Atenção: está apertando', 'Ainda atende, mas com pouca folga. Veja os avisos abaixo.'],
    bad: ['Sobrecarregado', 'Os usuários já devem sentir lentidão ou falhas. Veja o que está causando abaixo.']
  };

  /* -------------------------------- gráficos ------------------------------- */

  function spark(svgId, values, opts) {
    var svg = $(svgId);
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var NS = 'http://www.w3.org/2000/svg';
    var pts = values.map(function (v, i) { return { i: i, v: v }; }).filter(function (p) { return p.v != null; });
    if (pts.length < 2) return;
    var max = Math.max(opts.min != null ? opts.min : 0, Math.max.apply(null, pts.map(function (p) { return p.v; })));
    if (opts.floorMax) max = Math.max(max, opts.floorMax);
    if (max <= 0) max = 1;
    var n = values.length;
    var x = function (i) { return n === 1 ? 0 : (i / (n - 1)) * 300; };
    var y = function (v) { return 66 - (v / max) * 60; };
    if (opts.warn != null && opts.warn <= max) {
      var g = document.createElementNS(NS, 'line');
      g.setAttribute('x1', 0); g.setAttribute('x2', 300);
      g.setAttribute('y1', y(opts.warn)); g.setAttribute('y2', y(opts.warn));
      g.setAttribute('stroke', '#ffb43a'); g.setAttribute('stroke-width', '1'); g.setAttribute('stroke-dasharray', '4 4'); g.setAttribute('opacity', '.55');
      g.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(g);
    }
    var d = pts.map(function (p, k) { return (k ? 'L' : 'M') + x(p.i).toFixed(1) + ' ' + y(p.v).toFixed(1); }).join(' ');
    var area = document.createElementNS(NS, 'path');
    area.setAttribute('d', d + ' L' + x(pts[pts.length - 1].i).toFixed(1) + ' 68 L' + x(pts[0].i).toFixed(1) + ' 68 Z');
    area.setAttribute('fill', opts.color); area.setAttribute('opacity', '.16');
    svg.appendChild(area);
    var line = document.createElementNS(NS, 'path');
    line.setAttribute('d', d); line.setAttribute('fill', 'none'); line.setAttribute('stroke', opts.color);
    line.setAttribute('stroke-width', '1.8'); line.setAttribute('stroke-linejoin', 'round'); line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(line);
  }

  /* -------------------------------- pintura -------------------------------- */

  function paintNav(level, title) {
    var dot = $('loadDot');
    if (dot) { dot.className = 'ld-navdot ' + (level || ''); }
    openBtn.title = title || 'Carga do servidor';
    document.title = (ICON[level] || '') + baseTitle.replace(/^(🟡|🔴) /, '');
  }

  function notifyWorse(cur) {
    if (!floatEl) {
      floatEl = document.createElement('div');
      floatEl.className = 'ld-float'; floatEl.hidden = true; floatEl.setAttribute('role', 'alert');
      floatEl.addEventListener('click', function () { floatEl.hidden = true; if (!dlg.open) openBtn.click(); });
      document.body.appendChild(floatEl);
    }
    var top = cur.alerts && cur.alerts[0];
    floatEl.className = 'ld-float ' + cur.level;
    floatEl.textContent = (cur.level === 'bad' ? '🔴 Servidor sobrecarregado' : '🟡 Servidor apertando') + (top ? ': ' + top.title : '') + ' · toque para ver';
    floatEl.hidden = false;
    clearTimeout(floatTimer);
    floatTimer = setTimeout(function () { floatEl.hidden = true; }, 12000);
  }

  function track(cur) {
    var worse = RANK[cur.level] > RANK[lastLevel];
    var first = lastLevel === null;
    lastLevel = cur.level;
    paintNav(cur.level, cur.level === 'ok' ? 'Carga do servidor: tudo tranquilo' : (cur.alerts[0] ? cur.alerts[0].title : 'Carga do servidor'));
    if (worse && !first && !dlg.open) notifyWorse(cur);
  }

  function paint(d) {
    var c = d.current;
    var lim = d.limits || {};

    var banner = $('ldBanner');
    banner.className = 'ld-banner ' + c.level;
    setText('ldHead', HEAD[c.level][0]);
    setText('ldSub', HEAD[c.level][1]);
    var ul = $('ldAlerts');
    while (ul.firstChild) ul.removeChild(ul.firstChild);
    (c.alerts || []).forEach(function (a) {
      var li = document.createElement('li'); li.className = a.level;
      var b = document.createElement('b'); b.textContent = (a.level === 'bad' ? '🔴 ' : '🟡 ') + a.title;
      var s = document.createElement('span'); s.textContent = a.detail;
      li.appendChild(b); li.appendChild(s); ul.appendChild(li);
    });

    setText('ldOnline', fmtInt(c.online));
    setText('ldOnlineSub', 'últimos 5 min: ' + fmtInt(c.online5) + ' · assistindo agora ≈ ' + fmtInt(c.watching));

    setText('ldPlays', fmtInt(c.playsPerMin));
    setText('ldPlaysSub', c.streamN60
      ? 'abrir filme: típico ' + fmtMs(c.streamP50Ms) + ', pior caso ' + fmtMs(c.streamP95Ms) + ' · falhas ' + Math.round(c.streamFailPct || 0) + '%'
      : 'ninguém apertou play neste último minuto');

    var cpuLv = lvl(c.cpuPct, 70, 90);
    setText('ldCpu', c.cpuPct == null ? '–' : Math.round(c.cpuPct) + '%');
    $('ldCpuBar').style.width = Math.min(100, c.cpuPct || 0) + '%';
    setLevel(tileOf('ldCpu'), RANK[lvl(c.throttledPct, 20, 50)] > RANK[cpuLv] ? lvl(c.throttledPct, 20, 50) : cpuLv);
    setText('ldCpuSub', 'limite do plano: ' + (lim.cpuCores != null ? fmtCores(lim.cpuCores) : '?') + (lim.cpuSource === 'cgroup' ? '' : ' (esta máquina, sem limite de plano)') +
      (c.throttledPct != null ? ' · segurado pelo plano: ' + Math.round(c.throttledPct) + '% do tempo' : ''));

    setText('ldLag', fmtMs(c.lagP99Ms));
    setLevel(tileOf('ldLag'), lvl(c.lagP99Ms, 200, 600));

    setText('ldMem', c.memMB == null ? '–' : Math.round(c.memMB) + ' MB' + (lim.memMB ? ' de ' + Math.round(lim.memMB) : ''));
    $('ldMemBar').style.width = Math.min(100, c.memPct || 0) + '%';
    setLevel(tileOf('ldMem'), lvl(c.memPct, 75, 90));
    setText('ldMemSub', c.childRssMB != null ? 'servidor ' + Math.round(c.rssMB) + ' MB + CinePro ' + Math.round(c.childRssMB) + ' MB' : 'servidor ' + Math.round(c.rssMB || 0) + ' MB · CinePro desligado ou fora do Docker');

    var g = c.guard;
    setText('ldQueue', g ? g.active + ' de ' + g.maxActive : '–');
    setLevel(tileOf('ldQueue'), g ? (g.waiting >= 15 ? 'bad' : (g.waiting >= 1 ? 'warn' : 'ok')) : 'ok');
    setText('ldQueueSub', g ? (g.waiting ? g.waiting + ' esperando na fila · ' : 'ninguém esperando · ') + 'pedidos iguais atendidos de uma vez desde o início: ' + g.coalesced : '');

    if (c.projectedMaxOnline != null) {
      setText('ldCap', '≈ ' + c.projectedMaxOnline + ' online');
      setText('ldCapSub', 'projeção pela CPU de agora (usando até 80% do limite): ' + fmtInt(c.online) + ' online gastam ' + Math.round(c.cpuPct) + '% do limite. Vale como ordem de grandeza; confirme quando o movimento subir.');
    } else {
      setText('ldCap', '–');
      setText('ldCapSub', 'Precisa de pelo menos 8 pessoas online ao mesmo tempo para estimar o teto. Aparece sozinho quando o movimento subir.');
    }

    var s = d.series;
    if (s) {
      spark('ldChOnline', s.online, { color: '#6ea8fe' });
      spark('ldChCpu', s.cpuPct, { color: '#ffb43a', warn: 70, floorMax: 100 });
      spark('ldChLag', s.lagP99Ms, { color: '#c792ea', warn: 200, floorMax: 250 });
      spark('ldChMem', s.memMB, { color: '#3ddc84', floorMax: lim.memMB || 0, warn: lim.memMB ? lim.memMB * 0.75 : null });
    }
    setText('ldChOnlineNow', fmtInt(c.online));
    setText('ldChCpuNow', c.cpuPct == null ? '' : Math.round(c.cpuPct) + '%');
    setText('ldChLagNow', fmtMs(c.lagP99Ms));
    setText('ldChMemNow', c.memMB == null ? '' : Math.round(c.memMB) + ' MB');

    var up = Math.max(0, Math.round((d.now - d.startedAt) / 60000));
    setText('ldNote', 'Atualiza a cada 3 s com esta tela aberta. Histórico guardado só na memória do servidor: zera quando o Render reinicia ou dorme (no ar há ' +
      (up >= 120 ? Math.round(up / 60) + ' h' : up + ' min') + '). "Online" conta quem falou com o site no último minuto (cada aba aberta avisa a cada ~45 s); "assistindo" é quem deu play nas últimas 3 h e continua com a aba aberta.');
  }

  function paintOffline(message) {
    var banner = $('ldBanner');
    banner.className = 'ld-banner wait';
    setText('ldHead', 'Sem resposta do servidor');
    setText('ldSub', message + ' No plano grátis do Render o servidor pode estar dormindo (leva ~1 min para acordar) ou reiniciando.');
    paintNav('', 'Carga do servidor: sem resposta');
  }

  /* ------------------------- banda de saída do Render ------------------------- */

  var EG_MS = 20000;
  var egLast = 0;
  var egBusy = false;

  function fmtMB(v) {
    if (v == null) return '–';
    if (v >= 1024) return (v / 1024).toFixed(2).replace('.', ',') + ' GB';
    if (v >= 1) return (v >= 10 ? Math.round(v) : v.toFixed(2).replace('.', ',')) + ' MB';
    if (v >= 0.001) return Math.max(1, Math.round(v * 1024)) + ' KB';
    return '0 KB';
  }

  /* Barras por dia (um dia só já aparece; a linha de `spark` precisa de 2 pontos). */
  function bars(svgId, values, color) {
    var svg = $(svgId);
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!values.length) return;
    var NS = 'http://www.w3.org/2000/svg';
    var max = Math.max.apply(null, values.concat([0.001]));
    var n = values.length;
    var slot = 300 / Math.max(n, 14);
    var w = Math.max(2, slot - 2);
    values.forEach(function (v, i) {
      var h = Math.max(v > 0 ? 2 : 0, (v / max) * 60);
      var r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', (300 - (n - i) * slot + 1).toFixed(1));
      r.setAttribute('y', (68 - h).toFixed(1));
      r.setAttribute('width', w.toFixed(1));
      r.setAttribute('height', h.toFixed(1));
      r.setAttribute('rx', 1.5);
      r.setAttribute('fill', color);
      r.setAttribute('opacity', i === n - 1 ? '1' : '.6');
      var t = document.createElementNS(NS, 'title'); t.textContent = fmtMB(v);
      r.appendChild(t);
      svg.appendChild(r);
    });
  }

  function fillList(id, rows, render) {
    var ul = $(id);
    if (!ul) return;
    while (ul.firstChild) ul.removeChild(ul.firstChild);
    if (!rows.length) {
      var e = document.createElement('li'); e.className = 'eg-empty'; e.textContent = 'ainda sem dados neste mês';
      ul.appendChild(e);
      return;
    }
    rows.forEach(function (r) {
      var o = render(r);
      var li = document.createElement('li');
      if (o.hot) li.className = 'hot';
      var sp = document.createElement('span'); sp.textContent = o.name; sp.title = o.name;
      var b = document.createElement('b'); b.textContent = o.value;
      if (o.extra) { var sm = document.createElement('small'); sm.textContent = ' ' + o.extra; b.appendChild(sm); }
      li.appendChild(sp); li.appendChild(b); ul.appendChild(li);
    });
  }

  function paintEgress(d) {
    var t = d.today || {};
    var m = d.month || {};
    var guard = d.videoGuard || {};
    var totalToday = (t.httpMb || 0) + (t.outSentMb || 0);
    var totalMonth = (m.httpMb || 0) + (m.outSentMb || 0);

    setText('egToday', fmtMB(totalToday));
    setText('egTodaySub', 'respostas ' + fmtMB(t.httpMb || 0) + ' + saída própria ' + fmtMB(t.outSentMb || 0) + ' (recebido de fora: ' + fmtMB(t.outRecvMb || 0) + ')');
    setText('egMonth', fmtMB(totalMonth));
    setText('egMonthSub', 'respostas ' + fmtMB(m.httpMb || 0) + ' + saída própria ' + fmtMB(m.outSentMb || 0) + ' · ' + (m.days || 0) + ' dia(s) medido(s)');

    setText('egVideo', fmtMB(m.videoMb || 0));
    setLevel(tileOf('egVideo'), (m.videoMb || 0) >= 500 ? 'bad' : ((m.videoMb || 0) >= 20 ? 'warn' : 'ok'));
    setText('egVideoSub', (m.videoMb || 0) > 0 ? 'vídeo saiu pelo servidor: veja a linha "video:" abaixo' : 'nenhum vídeo passou pelo servidor neste mês');

    var rejected = guard.rejected || 0;
    setText('egGuard', rejected ? 'barrou ' + rejected : 'sem pedidos');
    var gs = rejected ? 'pedidos de vídeo ao servidor recusados desde o último reinício' : 'ninguém tentou pegar vídeo pelo servidor desde o último reinício';
    if (guard.allowedEnv) gs += ' · ATENÇÃO: ALLOW_RENDER_VIDEO está ligada e liberou ' + guard.allowedEnv;
    if (guard.last) gs += ' · último: ' + guard.last.path + (guard.last.forwarded ? ' (via proxy)' : '');
    setText('egGuardSub', gs);
    setLevel(tileOf('egGuard'), guard.allowedEnv ? 'bad' : 'ok');

    var days = d.days || [];
    bars('egChHttp', days.map(function (x) { return x.httpMb; }), '#6ea8fe');
    bars('egChOut', days.map(function (x) { return x.outSentMb; }), '#c792ea');
    var last = days.length ? days[days.length - 1] : null;
    setText('egChHttpNow', last ? fmtMB(last.httpMb) + ' hoje' : '');
    setText('egChOutNow', last ? fmtMB(last.outSentMb) + ' hoje' : '');

    fillList('egHttpList', (m.http || []).filter(function (r) { return r.mb > 0; }).slice(0, 8), function (r) {
      return { name: r.name, value: fmtMB(r.mb), extra: r.requests + ' req', hot: /^video:/.test(r.name) && r.mb > 0 };
    });
    fillList('egOutList', (m.out || []).slice(0, 10), function (r) {
      return { name: r.host, value: '↑' + fmtMB(r.sentMb) + ' ↓' + fmtMB(r.recvMb), extra: r.conns + ' conex.', hot: r.sentMb >= 100 };
    });

    var p = d.persistence || {};
    setText('egWhen', p.kind ? '· histórico em ' + (p.kind === 'supabase' ? 'Supabase (sobrevive a deploy)' : 'arquivo local (some quando o Render reinicia)') : '');
    setText('egNote', 'Medido pelo próprio servidor, por dia em UTC, e gravado a cada 10 min e ao desligar. O painel do Render soma o mesmo em duas contas: "HTTP Responses" = respostas; "Service-Initiated" = saída própria (↑). ' +
      'O que o app mede passa de cabeçalhos HTTP e TLS por cima, então o painel do Render costuma mostrar um pouco mais. ' +
      (p.error ? 'Aviso do histórico: ' + p.error + '. ' : '') +
      (p.lastSaveAt ? 'Última gravação: ' + new Date(p.lastSaveAt).toLocaleTimeString() + '.' : 'Ainda não gravou neste início.'));
  }

  function egressTick(force) {
    if (egBusy || !adminKey() || (!force && Date.now() - egLast < EG_MS)) return;
    egBusy = true;
    egLast = Date.now();
    var headers = { 'x-stats-key': adminKey() };
    if (CONFIG.apiKey) headers['x-api-key'] = CONFIG.apiKey;
    fetch(API_BASE + '/api/admin/egress?days=31', { headers: headers, cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(paintEgress).catch(function (err) {
      setText('egNote', 'Não consegui ler a banda (' + err.message + ').');
    }).then(function () { egBusy = false; });
  }

  /* --------------------------------- ciclo --------------------------------- */

  function tick() {
    if (inFlight || document.hidden || !adminKey()) return;
    inFlight = true;
    var live = dlg.open;
    fetchLoad(!live).then(function (d) {
      track(d.current);
      if (live) { paint(d); egressTick(false); }
    }).catch(function (err) {
      if (live) paintOffline(err.message === 'HTTP 403' || err.message === 'HTTP 401' ? 'A senha de administrador não foi aceita.' : 'Não consegui falar com a API (' + err.message + ').');
      else paintNav('', 'Carga do servidor: sem resposta');
    }).then(function () { inFlight = false; });
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(tick, dlg.open ? LIVE_MS : BG_MS);
  }

  openBtn.addEventListener('click', function () {
    if (!dlg.open) dlg.showModal();
    if (floatEl) floatEl.hidden = true;
    schedule();
    inFlight = false;
    tick();
    egressTick(true);
  });
  $('loadClose').addEventListener('click', function () { dlg.close(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', schedule);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });

  lastLevel = null;
  schedule();
  setTimeout(tick, 1500);
})();
