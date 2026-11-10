/**
 * fdsFlix - relay de mídia em Node (alternativa ao Cloudflare Worker).
 *
 * Roda o MESMO código do Worker (deploy/cloudflare-worker/worker.js: rota assinada /m/<token>,
 * modo /?u= com senha, Range, playlists HLS) como servidor HTTP comum. Serve para hospedar o
 * "cano" do vídeo num host com MUITA banda de saída (ex.: Oracle Cloud Always Free, ~10 TB/mês),
 * deixando o Render só com a parte leve: achar o filme e assinar o token (~1 KB).
 *
 * Sem dependências (Node >= 18). Atrás de HTTPS (Caddy), porque o site é https.
 *
 *   RELAY_KEY=<igual à VIDEO_RELAY_KEY do Render> node server.mjs
 *   PORT=8787 (padrão)  HOST=127.0.0.1 (padrão; Caddy fica na frente)
 */

import http from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const key = String(process.env.RELAY_KEY || process.env.VIDEO_RELAY_KEY || '').trim();
if (!key) {
  console.error('Defina RELAY_KEY (a mesma VIDEO_RELAY_KEY do Render).');
  process.exit(1);
}

// worker.js usa "export default" mas o package.json do projeto é CommonJS: importa pelo texto.
const source = await readFile(fileURLToPath(new URL('../cloudflare-worker/worker.js', import.meta.url)), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const env = { RELAY_KEY: key };

const server = http.createServer(async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const url = `${proto}://${req.headers.host}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(url, {
      method: req.method,
      headers,
      signal: controller.signal,
      ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {})
    });
    const out = await worker.fetch(request, env, {});
    res.writeHead(out.status, Object.fromEntries(out.headers));
    if (!out.body) return res.end();
    // pipe respeita a contrapressão: não enche a memória se o player for mais lento que o CDN.
    const body = Readable.fromWeb(out.body);
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  }
});

server.requestTimeout = 0;      // vídeo é longo
server.listen(PORT, HOST, () => console.log(`fdsFlix media relay em http://${HOST}:${PORT}`));
