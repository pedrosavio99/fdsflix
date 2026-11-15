'use strict';

const TRUSTED = [
  'fdsflix-80ya.onrender.com',
  'fdsflix.onrender.com',
  'localhost',
  'vidlink.pro',
  'vidsrc.net',
  'vidsrc.cc',
  'vidsrc.xyz',
  'vidsrc.to',
  'vidfast.pro',
  '2embed.cc',
  'autoembed.co',
  'embed.su'
];

function trusted(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return TRUSTED.some((item) => host === item || host.endsWith('.' + item));
  } catch (err) {
    return false;
  }
}

function isBlank(url) {
  const value = String(url || '').trim();
  return !value || value === 'about:blank' || /^chrome:\/\/newtab\/?/i.test(value) || /^edge:\/\/newtab\/?/i.test(value);
}

// Rede de segurança: alguns players abrem uma aba em branco e só depois tentam
// navegar para o anúncio. Se a aba continuar vazia, fecha; se virar uma página
// real (login/OAuth), deixa aberta.
chrome.tabs.onCreated.addListener((tab) => {
  if (!tab || tab.id == null || tab.openerTabId == null) return;

  chrome.tabs.get(tab.openerTabId, (opener) => {
    if (chrome.runtime.lastError || !opener || !trusted(opener.url || opener.pendingUrl || '')) return;

    const tabId = tab.id;
    setTimeout(() => {
      chrome.tabs.get(tabId, (current) => {
        if (chrome.runtime.lastError || !current) return;
        if (isBlank(current.pendingUrl || current.url || '')) {
          chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
        }
      });
    }, 1200);
  });
});

/* ------------------------------------------------------------------ */
/* Ponte de extração: o painel do admin pede uma página e ela é buscada */
/* pelo IP DESTE navegador (residencial), não pelo IP do servidor.      */
/* Só hosts de extração — nunca serve de proxy para a internet inteira. */
/* ------------------------------------------------------------------ */

const EXTRACT_HOSTS = [
  'redecanais.vip',
  'redecanais.ceo',
  'redecanais.gold',
  'mgeb.lat',
  'superflixapi.boats',
  'myembed.biz',
  'embedplay.vip',
  'fembed1.lol',
  'vidsrc.sh'
];

function extractAllowed(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return EXTRACT_HOSTS.some((item) => host === item || host.endsWith('.' + item));
  } catch (err) {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'fdsflix-ext-fetch' || !msg.url) return undefined;
  if (!extractAllowed(msg.url)) {
    sendResponse({ ok: false, error: 'host não permitido pela extensão' });
    return true;
  }
  fetch(msg.url, {
    credentials: 'omit',
    headers: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7' }
  })
    .then(async (res) => ({ ok: res.ok, status: res.status, text: await res.text() }))
    .then((out) => sendResponse(out))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // resposta assíncrona
});
