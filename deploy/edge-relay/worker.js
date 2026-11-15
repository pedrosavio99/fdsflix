/**
 * fdsFlix · relay de EXTRAÇÃO (para Wasmer Edge, Cloudflare Workers, Deno, Bun ou Node 18+).
 *
 * Serve para uma coisa só: buscar HTML/JSON de sites que barram IP de datacenter
 * (Cloudflare). O app no Render chama `<RELAY>?u=<url>` e recebe o conteúdo — o IP que
 * aparece para o site é o deste relay.
 *
 * Não carrega vídeo (para isso use deploy/media-relay / o Worker assinado). É leve:
 * sem dependências, um arquivo.
 *
 * Uso:
 *   GET  /?u=https%3A%2F%2Fwww4.redecanais.vip%2Fsearch%2Fvingadores%2F
 *   Header: x-senha: <RELAY_KEY>   (ou ?key=<RELAY_KEY>)
 *
 * Diagnóstico (sem senha, útil para saber se ESTE relay passa nos sites):
 *   GET /?probe=1&u=<url>   ->  { ok, status, challenge, bytes, ms, host }
 *
 * Variável de ambiente: RELAY_KEY (obrigatória — sem ela o relay recusa tudo).
 * Também aceita SM_RELAY_SENHA.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  'Access-Control-Max-Age': '86400'
};

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const CHALLENGE = /just a moment|verifica(?:c|ç)(?:a|o)|checking your browser|cf-challenge|attention required|access denied|enable javascript and cookies/i;

// Cabeçalhos que não devem ir para o site de destino.
const SKIP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-senha', 'x-relay-key',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
  'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip'
]);

function keyOf(env) {
  return String((env && (env.RELAY_KEY || env.SM_RELAY_SENHA)) || '').trim();
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }
  });
}

async function handle(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const target = url.searchParams.get('u');
  if (!target) return json(400, { error: 'informe ?u=<url>' });

  let dest;
  try {
    dest = new URL(target);
  } catch (err) {
    return json(400, { error: 'url inválida' });
  }
  if (dest.protocol !== 'https:' && dest.protocol !== 'http:') return json(400, { error: 'só http(s)' });

  // Diagnóstico: não busca conteúdo útil, só diz se ESTE relay passa no site.
  if (url.searchParams.get('probe') === '1') {
    const started = Date.now();
    try {
      const res = await fetch(dest.toString(), {
        headers: { 'User-Agent': DEFAULT_UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7', Accept: 'text/html,application/json' },
        redirect: 'follow'
      });
      const text = await res.text();
      return json(200, {
        ok: res.ok && !(CHALLENGE.test(text) && text.length < 20000),
        status: res.status,
        challenge: CHALLENGE.test(text),
        bytes: text.length,
        ms: Date.now() - started,
        host: dest.hostname
      });
    } catch (err) {
      return json(200, { ok: false, status: 0, error: String(err && err.message || err), host: dest.hostname });
    }
  }

  const expected = keyOf(env);
  if (!expected) return json(500, { error: 'RELAY_KEY não configurada neste relay' });
  const provided = String(request.headers.get('x-senha') || request.headers.get('x-relay-key') || url.searchParams.get('key') || '');
  if (!safeEqual(provided, expected)) return json(401, { error: 'senha do relay inválida' });

  // Repassa método, corpo e os cabeçalhos úteis (Range, Accept, etc.), trocando o UA.
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!SKIP.has(name.toLowerCase())) headers.set(name, value);
  });
  if (!headers.has('user-agent')) headers.set('User-Agent', DEFAULT_UA);
  if (!headers.has('accept-language')) headers.set('Accept-Language', 'pt-BR,pt;q=0.9,en;q=0.7');

  const init = { method: request.method, headers, redirect: 'follow' };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer();

  try {
    const upstream = await fetch(dest.toString(), init);
    const out = new Headers(upstream.headers);
    // O relay não expõe os cabeçalhos do provedor de hospedagem.
    for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) out.delete(name);
    for (const [k, v] of Object.entries(CORS)) out.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (err) {
    return json(502, { error: 'falha ao buscar a origem: ' + String(err && err.message || err).slice(0, 120) });
  }
}

// WinterCG (Wasmer Edge / Cloudflare Workers / Deno / Bun)
export default { fetch: handle };
export { handle };
