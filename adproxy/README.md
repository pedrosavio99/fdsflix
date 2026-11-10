# AdShield Proxy

Proxy reverso em **Node.js + Express + Cheerio** que abre um site alvo sem os
anúncios que ele injeta no HTML. A página é buscada no servidor, limpa e devolvida
ao navegador; CSS, JS, imagens, playlists HLS e iframes permitidos são
reescritos para continuarem passando pelo proxy.

> É um serviço **separado** do fdsFlix. Não usa ffmpeg, TMDB, VidLink, CinePro
> nem o player do projeto principal.

## O que ele faz

1. Recebe `GET /qualquer/caminho` e busca `TARGET_ORIGIN/qualquer/caminho`.
2. Sanitiza o HTML:
   - remove `<script src>` de domínios/paths de anúncio;
   - remove scripts inline com `popunder`, `window.open`, detectores de adblock;
   - remove `<iframe>` de anúncio por domínio, marcação e tamanhos típicos
     (`300x250`, `728x90`, `160x600`, etc.);
   - remove contêineres com classes/ids `ad`, `ads`, `ad-slot`, `advert`,
     `sponsor`, `popunder`, `div-gpt-ad`, `adsbygoogle` etc.;
   - remove CSP/X-Frame-Options do upstream (necessário para o runtime e para
     incorporar players);
   - injeta stubs de `adsbygoogle`, `googletag`, `blockAdBlock`/`FuckAdBlock` e
     bloqueia `window.open` para domínios externos;
   - injeta CSS que esconde sobras de anúncios.
3. Reescreve URLs:
   - recursos e páginas do próprio alvo continuam em caminhos locais e passam
     pelo catch-all do proxy;
   - recursos de CDNs/terceiros viram `/_adshield/r/<token-assinado>`;
   - `srcset`, `style`, `<style>`, `@import`, `url()`, `poster`, `action`,
     `data-src`, `<base>` e meta tags de imagem/vídeo também são reescritos;
   - playlists HLS (`m3u8`) têm segmentos, chaves e `EXT-X-MAP` reescritos.
4. Repassa `Range` (vídeo/206), `Set-Cookie` (sem `Domain`), `ETag`,
   `Cache-Control` e `Content-Disposition`. Não repassa CSP, XFO, HSTS,
   `Set-Cookie` de terceiros nem cabeçalhos hop-by-hop.

## Como os iframes são classificados

A ordem é conservadora: **lista negra primeiro, sinais de player depois**.

| Sinal | Efeito |
| :--- | :--- |
| host/path de anúncio conhecido | remove |
| `300x250`, `728x90`, `160x600`, `320x50`… | remove, a menos que existam sinais fortes de player |
| iframe oculto, `1x1`, `about:blank` sem classe de player | remove |
| host de player conhecido (`vidlink.pro`, `vidsrc.*`, `youtube.com`, `player.vimeo.com`, Bunny, Mux…) | mantém |
| path `/embed`, `/player`, `/watch`, `/video`, `/stream`, `.m3u8` | mantém |
| `allowfullscreen` + proporção 16:9 + tamanho grande | mantém |
| classe/id/título `player`, `video-player`, `jwplayer`, `plyr`… | mantém |
| iframe grande sem sinal nenhum | mantém (neutro) |

A lista de players pode ser ampliada com `EXTRA_PLAYER_HOSTS`.

### Política padrão para iframe de player

`PROXY_PLAYER_IFRAMES=0` (padrão): o iframe do player de **terceiro** fica
apontando direto para a origem. Isso preserva players que:

- validam `Origin`/`Referer`/domínio;
- usam cookies de sessão ou tokens assinados;
- passam por Cloudflare/anti-bot;
- dependem de `window.top`, permissões ou DRM.

O preço é honesto: **não é possível remover anúncios desenhados dentro desse
iframe**. O proxy remove o iframe de anúncio e o HTML ao redor; o conteúdo
interno do player de terceiro continua sendo do player.

`PROXY_PLAYER_IFRAMES=1`: o iframe também passa pelo proxy e o HTML interno é
sanitizado (scripts de anúncio, popunders, contêineres etc.). Isso resolve
players simples, mas pode quebrar os casos acima. Teste no site que você usa.

## Requisitos

- Node.js **20.18.1+** (recomendado 22)
- `TARGET_ORIGIN` configurado
- `PROXY_SECRET` estável em produção

## Vercel (proxy do player, sem VM/Render)

O AdShield pode rodar como função serverless na Vercel e ser usado só para
proxiar o HTML do player VidLink (bloqueando pop-ups/anúncios) sem extensão nos
PCs dos usuários. Veja [`VERCEL.md`](VERCEL.md).

## Rodar localmente

```bash
cd adproxy
cp .env.example .env
# edite TARGET_ORIGIN e PROXY_SECRET
npm install
npm start
```

Abra `http://localhost:3000`. O health check é
`http://localhost:3000/_adshield/health`.

Para gerar o segredo:

```bash
openssl rand -hex 32
```

### Testes

```bash
cd adproxy
npm test
```

Os testes sobem um site-fixture e um CDN locais e verificam sanitização,
classificação de iframes, tokens, SSRF, Range, HLS, charset, cookies, gzip,
redirecionamento e formulários.

## Deploy no Render

### Opção A — adicionar ao Blueprint

O `render.yaml` da raiz **não** cria o AdShield por padrão (ele não é útil para o
próprio fdsFlix). Para usar em outro site, adicione este serviço ao seu Blueprint:

```yaml
- type: web
  name: fdsflix-adshield
  runtime: node
  plan: free
  region: oregon
  rootDir: adproxy
  buildCommand: npm ci
  startCommand: npm start
  healthCheckPath: /_adshield/health
  envVars:
    - key: NODE_VERSION
      value: "22"
    - key: TARGET_ORIGIN
      sync: false
    - key: PROXY_SECRET
      generateValue: true
```

No Render: **New → Blueprint** → conecte o repositório → informe
`TARGET_ORIGIN`. O `PROXY_SECRET` é gerado automaticamente e não muda entre
restarts (os tokens de recursos continuam válidos). Se preferir, crie o serviço
manualmente pela Opção B.

### Opção B — criar o serviço manualmente

| Campo | Valor |
| :--- | :--- |
| Type | Web Service |
| Runtime | Node |
| Root Directory | `adproxy` |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/_adshield/health` |

Variáveis:

| Nome | Valor |
| :--- | :--- |
| `TARGET_ORIGIN` | `https://site-alvo.com` |
| `PROXY_SECRET` | `openssl rand -hex 32` (ou generated value do Render) |
| `NODE_VERSION` | `22` |

O Render injeta `PORT` e a aplicação escuta em `0.0.0.0`. Não é preciso definir
`PORT`.

> **Plano Free:** o serviço dorme após ~15 min de inatividade e acorda em ~1 min.
> Sanitizar HTML é barato, mas o cold start continua existindo. Se o site alvo
> tiver muito tráfego de vídeo, ele pode ser o gargalo de banda — o proxy
> transporta os bytes.

### Docker (VPS, Fly.io, Railway etc.)

```bash
docker build -t adshield adproxy
docker run --rm -p 3000:3000 --env-file adproxy/.env adshield
```

## Variáveis de ambiente

| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `TARGET_ORIGIN` | — | Origem do site alvo. **Sem caminho e sem barra no fim.** |
| `PROXY_SECRET` | aleatório | Chave HMAC dos tokens de recursos. Defina em produção. |
| `PORT` | `3000` | Porta HTTP. |
| `HOST` | `0.0.0.0` | Interface de escuta. |
| `PROXY_PLAYER_IFRAMES` | `0` | `1` proxia também o HTML de iframes de player de terceiros. |
| `HARDEN_PLAYER_IFRAMES` | `0` | Adiciona/limita `sandbox` em iframes (remove popups/top navigation). |
| `REWRITE_EXTERNAL_LINKS` | `0` | `1` faz links externos clicados passarem pelo proxy. |
| `BLOCK_POPUPS` | `1` | Bloqueia `window.open` para domínio externo no runtime injetado. |
| `POPUP_ALLOW_HOSTS` | vazio | Domínios que ainda podem abrir popup (ex.: `accounts.google.com`). |
| `INJECT_ADBLOCK_STUBS` | `1` | Define `adsbygoogle`, `googletag`, `blockAdBlock` etc. |
| `INJECT_HIDING_CSS` | `1` | CSS que esconde contêineres de anúncio remanescentes. |
| `FORWARD_COOKIES` | `1` | Envia cookies do navegador ao alvo (nunca a CDNs cross-origin). |
| `ALLOW_CROSS_ORIGIN` | `1` | Proxia recursos de outros domínios. `0` deixa o navegador ir direto. |
| `ALLOW_PRIVATE_UPSTREAMS` | `0` | Permite IPs/hosts privados fora do alvo. **Não ligue em produção (SSRF).** |
| `EXTRA_PLAYER_HOSTS` | vazio | Hosts extras de player, separados por vírgula. |
| `UPSTREAM_USER_AGENT` | Chrome | User-Agent usado nas requisições ao alvo. |
| `UPSTREAM_TIMEOUT_MS` | `30000` | Timeout até os headers do upstream. |
| `MAX_HTML_BYTES` | `8388608` | Limite de HTML para sanitizar (8 MB). |
| `MAX_CSS_BYTES` | `4194304` | Limite de CSS/HLS para reescrever (4 MB). |
| `MAX_REQUEST_BODY_BYTES` | `2097152` | Limite de corpo de POST/PUT (2 MB). |
| `DEBUG` | `0` | Logs detalhados (não loga tokens). |

## Rotas internas

| Rota | Descrição |
| :--- | :--- |
| `GET /_adshield/health` | Status, alvo, versão, segredo estável. |
| `GET /_adshield/info` | Configuração resumida (sem segredo). |
| `GET /_adshield/r/<token>` | Recurso/página de outro host, assinado por HMAC. |
| `GET /_adshield/blocked.gif` | GIF transparente 1x1. |

O prefixo `/_adshield` é reservado. Um caminho do site alvo que comece com ele
é servido por token em vez de caminho local.

## Segurança

- **SSRF:** o alvo configurado é sempre permitido; qualquer outro destino passa
  por validação de protocolo, bloqueio de IPs privados/loopback/metadata e
  resolução DNS antes de cada salto de redirecionamento.
- **Proxy não aberto:** URLs de terceiros são assinadas com HMAC; o cliente não
  consegue inventar um destino.
- **Cookies:** só vão para o alvo; não vão para CDNs cross-origin. `Set-Cookie`
  de terceiros é descartado e o `Domain` é removido do cookie do alvo.
- **CSP/XFO:** removidos de propósito para o proxy poder reescrever e para o
  player poder ser incorporado. Isso diminui a proteção do site original; o
  proxy deve ser usado em sites de confiança.
- **Conteúdo do alvo roda no seu domínio:** scripts do site alvo têm acesso ao
  `localStorage`/cookies do domínio do proxy. Não use o mesmo domínio do seu
  banco/login.
- **Segredo:** se `PROXY_SECRET` mudar, tokens antigos param de funcionar. No
  Render, use `generateValue: true` ou um valor fixo.

## Limitações honestas

1. **Anúncios dentro de iframe de player direto** não podem ser removidos. Veja
   `PROXY_PLAYER_IFRAMES`.
2. **JS que injeta anúncios depois do carregamento** (createElement, XHR,
   `fetch`, workers) não é reescrito. O proxy limpa o HTML inicial, não executa
   um navegador.
3. **Pre-roll/mid-roll VAST dentro do vídeo** continua sendo decisão do player.
4. **Players com anti-bot/Cloudflare/DRM** podem recusar o proxy. Nesse caso,
   mantenha `PROXY_PLAYER_IFRAMES=0`.
5. **Login/OAuth** pode falhar se depender de cookies de terceiros ou de
   redirecionamentos para domínios externos.
6. **Service workers, WebSockets e downloads grandes** não são suportados
   integralmente.
7. **HTML muito grande** (> `MAX_HTML_BYTES`) retorna erro em vez de vazar a
   página sem sanitização.
8. **`window.open` é bloqueado** para domínios externos; se o site precisar
   abrir um popup legítimo, use `POPUP_ALLOW_HOSTS`.
9. A lista de anúncios é heurística. Falsos positivos/negativos são esperados;
   ajuste `EXTRA_PLAYER_HOSTS` e as listas em `lib/adRules.js`.

## Estrutura

```
adproxy/
  server.js             sobe o Express
  lib/app.js            rotas, proxy e envio da resposta
  lib/config.js         envs e validação
  lib/urls.js           tokens HMAC, rewriting e guarda SSRF
  lib/adRules.js        listas de anúncios e classificação de iframes
  lib/htmlRewrite.js    sanitização/reescrita do HTML
  lib/cssRewrite.js     url() e @import
  lib/hlsRewrite.js     playlists HLS
  lib/upstream.js       fetch, redirects, headers, cookies e charset
  test/proxy.test.js    testes de integração
  Dockerfile
```

## Aviso de uso

Remover anúncios pode violar os termos de uso e direitos autorais do site alvo.
Use este proxy apenas em sites que você possui, que autorizam esse uso, ou em
contextos legítimos de privacidade/acessibilidade. Você é responsável pelo
tráfego e pelo conteúdo que proxiar.
