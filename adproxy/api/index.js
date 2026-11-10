'use strict';

// Entrada serverless da Vercel. O mesmo app Express do AdShield é exportado
// como handler; a Vercel cuida do HTTP e do TLS. Configure TARGET_ORIGIN e
// PROXY_SECRET no projeto (Environment Variables).

const { loadConfig } = require('../lib/config');
const { createApp } = require('../lib/app');

module.exports = createApp(loadConfig());
