'use strict';

const { loadConfig } = require('./lib/config');
const { createApp } = require('./lib/app');

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`[adshield] configuração inválida: ${error.message}`);
  process.exit(1);
}

if (!config.secretStable) {
  console.warn(
    '[adshield] PROXY_SECRET não definido; usando segredo aleatório. ' +
      'Tokens de recursos deixarão de valer após reiniciar (defina PROXY_SECRET no Render).'
  );
}

if (!config.targetOrigin) {
  console.error('[adshield] TARGET_ORIGIN não configurado. O proxy responderá 503 até você definir.');
} else {
  console.log(`[adshield] Alvo: ${config.targetOrigin}`);
}
if (!config.proxyPlayerIframes) {
  console.log('[adshield] iframes de player de terceiros ficam diretos (PROXY_PLAYER_IFRAMES=0).');
}

const app = createApp(config);
const server = app.listen(config.port, config.host, () => {
  console.log(`[adshield] ouvindo em http://${config.host}:${config.port}`);
  console.log(`[adshield] health: http://127.0.0.1:${config.port}/_adshield/health`);
});

server.on('error', (error) => {
  console.error(`[adshield] falha ao ouvir em ${config.host}:${config.port}: ${error.message}`);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`[adshield] ${signal} recebido; encerrando...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
