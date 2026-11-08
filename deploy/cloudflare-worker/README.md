# Cloudflare Worker Repassador de Vídeos (Streaming Relay)

Este worker funciona no mesmo formato do repassador do `modulo-playlist-main` (`SM_RELAY`), porém otimizado especificamente para **vídeos, HLS e APIs**:

- **Range Requests (HTTP 206 Partial Content):** permite que o player de vídeo pule e faça seek pelo arquivo sem baixar o vídeo inteiro.
- **Streaming de Resposta:** repassa o corpo da requisição diretamente via stream, sem estourar limites de memória do Worker ao lidar com arquivos de vídeo ou chunks `.ts`/`.m4s`.
- **CORS Completo:** libera `Access-Control-Allow-Origin: *`, `Range`, `Accept-Ranges` e headers de mídia.
- **Bypass de Datacenter:** contorna os bloqueios de IP de datacenters (Render, Vercel, Railway, VPS) em sites como AnimeFire e outros provedores com proteção Cloudflare.
- **Senha obrigatória:** o worker recusa tudo (HTTP 503) enquanto `RELAY_KEY` não estiver configurada, e exige o header `x-senha`/`x-relay-key` (HTTP 401 se errado). Sem isso ele seria um proxy aberto.

---

## 0. Conta na Cloudflare (grátis, sem cartão)

1. Acesse <https://dash.cloudflare.com/sign-up>, informe e-mail e senha e confirme o e-mail.
2. Não precisa adicionar domínio nem cartão: ignore qualquer oferta de "Add a site".
3. Plano gratuito de Workers: 100.000 requisições/dia (cada playlist e segmento HLS conta 1).

## Como Criar e Subir o Worker na Cloudflare

### Opção 1: Pelo Painel Web da Cloudflare (Sem instalar nada no PC - Mais Fácil)

1. Acesse o painel da [Cloudflare Dashboard](https://dash.cloudflare.com/) e faça login.
2. No menu lateral, clique em **Compute (Workers & Pages)** → **Workers & Pages**.
3. Clique no botão **Create application** → **Create Worker**.
4. Dê um nome (por exemplo: `fdsflix-relay`) e clique em **Deploy**.
5. Na página seguinte, clique em **Edit code** (ou **Quick edit**).
6. Apague o código que estiver lá e cole todo o conteúdo do arquivo [`worker.js`](worker.js).
7. Clique em **Deploy** no canto superior direito.
8. **(Obrigatório)** Adicione a chave secreta:
   - Volte para a página do Worker → clique na aba **Settings** → **Variables and Secrets**.
   - Em **Environment Variables**, adicione uma variável:
     - Tipo: **Secret** (ou Text)
     - Nome: `RELAY_KEY`
     - Valor: uma senha de sua escolha (ex.: `minha_chave_forte_123`)
   - Clique em **Save and Deploy**.
9. Copie a URL do seu Worker gerada pela Cloudflare (ex.: `https://fdsflix-relay.seu-usuario.workers.dev`).

---

### Opção 2: Pelo Terminal via Wrangler

```bash
cd deploy/cloudflare-worker
npx wrangler deploy
# Para configurar a senha do worker:
npx wrangler secret put RELAY_KEY
```

---

## Como Ativar no fdsFlix

No seu arquivo `.env` (no Render, Vercel ou local):

```bash
VIDEO_RELAY_URL=https://fdsflix-relay.seu-usuario.workers.dev
VIDEO_RELAY_KEY=minha_chave_forte_123
```

> **Importante:** Se você deixar `VIDEO_RELAY_URL` em branco ou não configurar, o `fdsFlix` continuará fazendo as requisições normais diretas do servidor, garantindo que **absolutamente nada quebre**!


## Testar depois do deploy

```bash
# deve responder 401 (sem senha)
curl -i "https://fdsflix-relay.SEU-USUARIO.workers.dev/?u=https://example.com"
# deve responder 200
curl -i -H "x-senha: SUA_SENHA" "https://fdsflix-relay.SEU-USUARIO.workers.dev/?u=https://example.com"
# a API do AnimeFire pelo worker (se vier 403, o site barra a Cloudflare também)
curl -i -H "x-senha: SUA_SENHA" "https://fdsflix-relay.SEU-USUARIO.workers.dev/?u=https://api.animefire.one/"
```

Ao iniciar, o fdsFlix mostra `Relay CF : ativo (...)` no console.
