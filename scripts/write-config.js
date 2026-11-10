'use strict';

/**
 * Gera public/config.js usando API_BASE_URL e API_KEY.
 *
 * Usado no build da Vercel (frontend estático): assim a URL do backend e a
 * chave opcional ficam em variáveis de ambiente do projeto, sem editar arquivo
 * à mão. Localmente (npm start) o public/config.js do repositório é usado.
 */

const fs = require('fs');
const path = require('path');

const rawBase = String(process.env.API_BASE_URL || '').trim();
const apiBase = rawBase.replace(/\/+$/, '');
const apiKey = String(process.env.API_KEY || '').trim();
const embedProxyBase = String(process.env.ADSHIELD_BASE_URL || '').trim().replace(/\/+$/, '');

const target = path.join(__dirname, '..', 'public', 'config.js');
const content =
  '/* Gerado por scripts/write-config.js no build. */\n' +
  'window.__FDSFLIX_CONFIG__ = ' +
  JSON.stringify({ apiBase, apiKey, embedProxyBase }, null, 2) +
  ';\n';

fs.writeFileSync(target, content, 'utf8');
console.log(`[config] apiBase = ${apiBase || '(mesma origem)'}`);
console.log(`[config] apiKey  = ${apiKey ? '(definida)' : '(vazia)'}`);
console.log(`[config] adshield = ${embedProxyBase || '(desligado)'}`);
