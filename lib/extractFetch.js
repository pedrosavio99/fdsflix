'use strict';

/**
 * Extracção com "máscara de IP" em cadeia.
 *
 * O problema: os sites que o fdsFlix raspa (redecanais, mgeb.lat, vidlink…) ficam atrás do
 * Cloudflare e **desafiam IP de datacenter**. Do Render (AWS) eles respondem 403/"Just a moment";
 * de uma conexão residencial eles respondem normal. Relay público (r.jina.ai, allorigins,
 * corsproxy…) não resolve: todos são datacenter e levam o mesmo desafio — testado.
 *
 * A saída é a mesma que o projeto já usa para o vídeo: um relay **seu**, rodando em casa
 * (`deploy/media-relay`, mesmo código do Worker). Ele é exposto por um túnel (cloudflared) e o
 * Render passa a pedir a extração por ali:
 *
 *   EXTRACT_RELAY_URL=https://<seu-tunel>.trycloudflare.com
 *   EXTRACT_RELAY_KEY=<a mesma RELAY_KEY do relay>
 *
 * A ordem de tentativa é: direto (rápido, funciona em dev) → relay residencial (passa
 * Cloudflare) → relay do Worker (Cloudflare→Cloudflare; passa alguns, não todos).
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const CHALLENGE = /just a moment|verifica(?:c|ç)(?:a|o)|checking your browser|cf-challenge|attention required|access denied|enable javascript and cookies/i;

function strip(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/** Relay residencial (o do dono, em casa). */
function homeRelay() {
  return {
    url: strip(process.env.EXTRACT_RELAY_URL),
    key: String(process.env.EXTRACT_RELAY_KEY || process.env.VIDEO_RELAY_KEY || '').trim()
  };
}

/** Relay do Worker (Cloudflare). */
function workerRelay() {
  const url = strip(process.env.VIDEO_RELAY_URL || process.env.RELAY_URL || process.env.SM_RELAY);
  const key = String(process.env.VIDEO_RELAY_KEY || process.env.RELAY_KEY || process.env.SM_RELAY_SENHA || '').trim();
  return { url, key };
}

function relayStatus() {
  const home = homeRelay();
  const worker = workerRelay();
  return {
    home: Boolean(home.url),
    worker: Boolean(worker.url),
    chain: [home.url ? 'residencial' : null, worker.url ? 'worker' : null, 'direto'].filter(Boolean)
  };
}

async function once(url, { timeoutMs = 9000, headers = {}, relay = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, timeoutMs));
  try {
    const target = relay
      ? (() => { const u = new URL(relay.url); u.searchParams.set('u', url); return u.toString(); })()
      : url;
    const extra = relay ? { 'x-senha': relay.key, 'x-relay-key': relay.key } : {};
    const res = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...extra,
        ...headers
      }
    });
    if (!res || !res.ok) return { ok: false, status: res ? res.status : 0, via: relay ? relay.name : 'direto' };
    const text = await res.text();
    if (!text) return { ok: false, status: res.status, via: relay ? relay.name : 'direto' };
    // Desafio do Cloudflare chega como 200: não serve como resposta.
    if (CHALLENGE.test(text) && text.length < 20000) {
      return { ok: false, status: res.status, challenge: true, via: relay ? relay.name : 'direto' };
    }
    return { ok: true, status: res.status, text, via: relay ? relay.name : 'direto' };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'tempo esgotado' : err.message, via: relay ? relay.name : 'direto' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Busca um HTML/JSON tentando direto, o relay residencial e o Worker, nessa ordem.
 * @returns {Promise<{ok:boolean,status:number,text?:string,via:string,challenge?:boolean,error?:string}>}
 */
async function fetchSmart(url, options = {}) {
  const home = homeRelay();
  const worker = workerRelay();
  const tried = [];

  const direct = await once(url, { ...options, timeoutMs: Math.min(options.timeoutMs || 9000, 5000) });
  if (direct.ok) return direct;
  tried.push(`direto:${direct.status || direct.error || 'falhou'}`);

  if (home.url && home.key) {
    const viaHome = await once(url, { ...options, timeoutMs: options.timeoutMs || 12000, relay: { ...home, name: 'residencial' } });
    if (viaHome.ok) return viaHome;
    tried.push(`residencial:${viaHome.status || viaHome.error || 'falhou'}`);
  } else {
    tried.push('residencial:não configurado');
  }

  if (worker.url) {
    const viaWorker = await once(url, { ...options, timeoutMs: options.timeoutMs || 12000, relay: { ...worker, name: 'worker' } });
    if (viaWorker.ok) return viaWorker;
    tried.push(`worker:${viaWorker.status || viaWorker.error || 'falhou'}`);
  }

  return { ok: false, status: direct.status || 0, via: 'nenhum', tried };
}

module.exports = { fetchSmart, relayStatus, homeRelay, workerRelay };
