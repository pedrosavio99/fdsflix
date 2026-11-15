/**
 * fdsFlix · Pix pelo Gmail (Google Apps Script).
 *
 * 1. script.google.com -> Novo projeto, apague o que vier e cole ESTE arquivo inteiro.
 * 2. Menu Executar -> escolha "install" -> Executar (autorize o acesso ao Gmail quando pedir).
 * 3. Pronto: a cada minuto ele olha os e-mails do Nubank das últimas 3 h e avisa o nó do Pix.
 *    (Para ver o que ele achou: Executar -> "testar" e abra o Registro de execução.)
 */
var MICRO_URL = '__MICRO_URL__';
var SECRET = '__PIX_SECRET__';
var WINDOW_MIN = 180;

function collect_() {
  var since = Date.now() - WINDOW_MIN * 60000;
  var threads = GmailApp.search('from:todomundo@nubank.com.br after:' + Math.floor(since / 1000), 0, 20);
  var out = [];
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      if (m.getDate().getTime() < since) return;
      var raw = m.getRawContent();
      var cut = raw.search(/\r?\n\r?\n/);
      out.push({
        headers: raw.slice(0, cut < 0 ? 20000 : Math.min(cut, 20000)),
        subject: m.getSubject(),
        text: m.getPlainBody().slice(0, 4000)
      });
    });
  });
  return out;
}

function send_(messages) {
  var res = UrlFetchApp.fetch(MICRO_URL.replace(/\/+$/, '') + '/pix/mail', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-pix-secret': SECRET },
    payload: JSON.stringify({ messages: messages }),
    muteHttpExceptions: true
  });
  return res.getResponseCode() + ' ' + res.getContentText().slice(0, 300);
}

function checkPix() {
  var messages = collect_();
  if (!messages.length) return;
  send_(messages);
}

function testar() {
  var messages = collect_();
  Logger.log(messages.length + ' e-mail(s) do Nubank nas últimas 3 h');
  if (messages.length) Logger.log('resposta do nó: ' + send_(messages));
}

function install() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkPix') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkPix').timeBased().everyMinutes(1).create();
  Logger.log('Gatilho de 1 minuto criado.');
}
