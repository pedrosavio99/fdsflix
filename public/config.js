/*
 * Configuração do frontend.
 *
 * Localmente (npm start) deixe apiBase vazio: o frontend fala com a mesma
 * origem que serviu a página.
 *
 * Na Vercel, o build (scripts/write-config.js) substitui este arquivo usando as
 * variáveis API_BASE_URL e API_KEY. Também dá para editar à mão:
 *
 *   window.__FDSFLIX_CONFIG__ = {
 *     apiBase: 'https://fdsflix-api.up.railway.app',
 *     apiKey: ''
 *   };
 *
 * Sem barra no final do apiBase.
 */
window.__FDSFLIX_CONFIG__ = {
  apiBase: '',
  apiKey: ''
};
