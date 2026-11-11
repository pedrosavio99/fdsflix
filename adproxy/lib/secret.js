'use strict';

// Segredo de assinatura EMBUTIDO (veja o comentário em lib/config.js). Sem dependências de
// propósito: é importado tanto pelo app Node (lib/config.js) quanto pelo Edge (lib/edgeHls.mjs).
// PROXY_SECRET na Vercel, se existir, manda mais que este valor.
const BUILTIN_PROXY_SECRET =
  'e58123d7001b6d1f7e2f14aa0ca02b8ef87465b062c870121613ffe8505bff3b';

module.exports = { BUILTIN_PROXY_SECRET };
