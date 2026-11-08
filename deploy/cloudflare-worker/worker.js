/**
 * fdsFlix - Cloudflare Worker Repassador para Vídeos e APIs (Streaming Relay)
 *
 * Inspirado no padrão SM_RELAY do módulo-playlist:
 * Bypassa bloqueios de Cloudflare / Datacenter (HTTP 403 / 429) em sites
 * como AnimeFire, catálogos de streaming e CDNs de vídeo.
 *
 * Recursos para vídeo:
 * - Suporte nativo a HTTP Range Requests (Status 206 Partial Content) para busca/seek no player.
 * - Streaming direto do corpo da resposta (ReadableStream) sem acumular dados em memória.
 * - Suporte a playlists HLS (.m3u8), chunks (.ts / .m4s) e APIs JSON.
 * - Cabeçalhos CORS completos para permitir reprodução em qualquer frontend.
 * - Senha OBRIGATÓRIA (RELAY_KEY ou SM_RELAY_SENHA) via x-senha ou x-relay-key. Sem a senha
 *   configurada o worker recusa tudo (senão viraria um proxy aberto para a internet inteira).
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Encoding',
  'Access-Control-Max-Age': '86400',
};

// Headers que NÃO devem ser repassados para o site de destino (específicos do Cloudflare/Edge)
const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
  'x-senha',
  'x-relay-key',
  'x-redirect'
]);

// Comparação em tempo (quase) constante para a senha.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env = {}, ctx) {
    const requestUrl = new URL(request.url);

    // 1. Tratamento de CORS Preflight (OPTIONS)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    // 2. Extração da URL de destino
    const targetUrl = requestUrl.searchParams.get('u') ||
      requestUrl.searchParams.get('url') ||
      request.headers.get('x-target-url');

    // Se nenhuma URL foi enviada, exibe status de saúde do worker
    if (!targetUrl) {
      return new Response(JSON.stringify({
        ok: true,
        service: 'fdsFlix Video Relay Worker',
        version: '1.0.0',
        usage: '/?u=https://site-destino.com/arquivo.m3u8',
        keyConfigured: Boolean(env.RELAY_KEY || env.SM_RELAY_SENHA)
      }, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...CORS_HEADERS
        }
      });
    }

    // 3. Senha obrigatória. Sem RELAY_KEY configurada, recusa (fail-closed).
    const requiredKey = String(env.RELAY_KEY || env.SM_RELAY_SENHA || '').trim();
    if (!requiredKey) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Worker sem senha configurada. Defina a variável/secret RELAY_KEY no painel da Cloudflare.'
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
      });
    }
    const providedKey = request.headers.get('x-senha') || request.headers.get('x-relay-key') || '';
    if (!safeEqual(providedKey, requiredKey)) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Chave de acesso inválida ou não fornecida no x-senha ou x-relay-key'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
      });
    }

    // 4. Validação da URL de destino
    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
      if (!/^https?:$/.test(parsedTarget.protocol)) {
        throw new Error('Apenas protocolos http e https são permitidos.');
      }
    } catch (err) {
      return new Response(JSON.stringify({
        ok: false,
        error: `URL de destino inválida: ${err.message}`
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...CORS_HEADERS
        }
      });
    }

    // 5. Montagem dos cabeçalhos repassados ao destino
    const forwardHeaders = new Headers();

    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (!HOP_BY_HOP_HEADERS.has(lower) && !lower.startsWith('cf-')) {
        forwardHeaders.set(key, value);
      }
    }

    // Pede o corpo sem compressão ao destino: evita content-encoding divergente do corpo
    // entregue (e o Content-Length repassado ao player bate com os bytes).
    forwardHeaders.set('accept-encoding', 'identity');

    // Suporte para sobreposição explícita de Referer e Origin (exigidos por CDNs de vídeo)
    if (request.headers.has('x-custom-referer')) {
      forwardHeaders.set('referer', request.headers.get('x-custom-referer'));
    }
    if (request.headers.has('x-custom-origin')) {
      forwardHeaders.set('origin', request.headers.get('x-custom-origin'));
    }
    if (request.headers.has('x-custom-user-agent')) {
      forwardHeaders.set('user-agent', request.headers.get('x-custom-user-agent'));
    }

    // 6. Opções de busca no destino
    const isManualRedirect = requestUrl.searchParams.get('redirect') === 'manual' ||
      request.headers.get('x-redirect') === 'manual';

    const fetchOptions = {
      method: request.method,
      headers: forwardHeaders,
      redirect: isManualRedirect ? 'manual' : 'follow'
    };

    // Repassa o corpo em requisições POST/PUT
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      fetchOptions.body = request.body;
    }

    // 7. Execução da chamada a partir da rede Cloudflare
    try {
      const upstreamResponse = await fetch(parsedTarget.toString(), fetchOptions);

      // Clona e limpa os cabeçalhos de resposta
      const responseHeaders = new Headers(upstreamResponse.headers);

      // Injeta cabeçalhos CORS completos
      for (const [k, v] of Object.entries(CORS_HEADERS)) {
        responseHeaders.set(k, v);
      }

      // Se for redirecionamento manual, repassa o header Location
      if (isManualRedirect && upstreamResponse.headers.has('location')) {
        responseHeaders.set('Location', upstreamResponse.headers.get('location'));
      }

      // Devolve o corpo como stream direto (vital para Range / vídeo HLS)
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders
      });
    } catch (err) {
      return new Response(JSON.stringify({
        ok: false,
        error: `Falha ao conectar com o destino: ${err.message}`
      }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...CORS_HEADERS
        }
      });
    }
  }
};
