'use strict';

// A chave é trocada pelo fdsFlix quando o kit é baixado (botão "Baixar kit" da tela Pix). Sem ela o nó não sobe,
// a não ser que PIX_SECRET esteja no ambiente (testes locais).
const EMBEDDED_SECRET = '';

module.exports = {
  secret: String(process.env.PIX_SECRET || EMBEDDED_SECRET || ''),
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  EMBEDDED_ANCHOR: "const EMBEDDED_SECRET = '';"
};
