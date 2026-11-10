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
