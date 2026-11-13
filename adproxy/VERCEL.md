# AdShield na Vercel (sem Render/VM)

O AdShield é o proxy que **sanitiza o HTML do player** e injeta o bloqueio de
`window.open`/pop-ups. Rodando na Vercel (serverless), nenhum PC precisa
instalar extensão e não é preciso Oracle/VM.

## Subir

Na Vercel, crie um projeto separado apontando para a pasta `adproxy` deste
repositório (Root Directory = `adproxy`).

Variáveis de ambiente: **nenhuma é obrigatória**. `TARGET_ORIGIN` (`https://vidlink.pro`) e
`PROXY_SECRET` vêm embutidas em `lib/config.js`; se você definir a variável na Vercel, ela manda
mais que o valor embutido:

```env
TARGET_ORIGIN=https://vidlink.pro      # opcional
PROXY_SECRET=<openssl rand -hex 32>    # opcional (o embutido é público)
```

O `vercel.json` já manda todas as rotas para `api/index.js`. A Vercel instala as
dependências do `package.json` do `adproxy` e publica.

Teste depois do deploy:

```bash
curl -I https://SEU-PROJETO.vercel.app/movie/603
```

A página deve voltar 200. O HTML do player não terá os scripts de anúncio e o
runtime injetado bloqueará `window.open` externo/vazio.

## Ligar no fdsFlix

No Render do fdsFlix, defina:

```env
ADSHIELD_BASE_URL=https://SEU-PROJETO.vercel.app
```

O fdsFlix passa a abrir o player VidLink via esse proxy. Para o iframe proxiado,
o sandbox é dispensado (o próprio runtime do AdShield bloqueia pop-ups); para
os outros provedores, o “Modo seguro” continua igual.

Sem `ADSHIELD_BASE_URL`, nada muda: o embed VidLink continua indo direto para
`vidlink.pro`.

## Segundo projeto: AdFallback (rodízio de nós)

O mesmo código pode subir **de novo**, em projetos separados, só como relay de mídia para os
filmes do fdsFlix. A diferença é uma variável: `MEDIA_PROXY=1`.

Os nós que já estão no pool do Vidsrc podem ser **reaproveitados** para este papel: reenvie neles o kit
novo (o mesmo `deploy-vercel.sh`) e cole as mesmas URLs em `ADSHIELD_FALLBACK_URLS`. Um nó, dois papéis,
a mesma cota — o consumo entra nos dois medidores.

O caminho mais simples é pelo próprio site: **Configs → “2b · AdFallback” → baixar `.zip`**.
O kit já vem com `MEDIA_PROXY=1` e uma chave de mídia única embutidos em `lib/config.js`
(zero variável no host), mais o `deploy-fallback.sh` (Vercel) e o `Dockerfile` (Wasmer/VPS).

Manual, se preferir subir do repositório:

```env
TARGET_ORIGIN=https://vidlink.pro
PROXY_SECRET=uma-chave-fixa-longa
MEDIA_PROXY=1
MEDIA_PROXY_KEY=uma-chave-compartilhada
```

No Render do fdsFlix:

```env
ADSHIELD_FALLBACK_URLS=https://SEU-NO-A.vercel.app,https://SEU-NO-B.wasmer.app
ADSHIELD_FALLBACK_KEY=uma-chave-compartilhada
```

Pronto: quando a cascata termina sem nenhuma fonte que não gaste o Render (o caso clássico é a
pool do Vidsrc inteira falhando), o filme que o VidLink Pro — ou outra fonte — achou passa a
tocar por um destes nós, em vez de o site responder 503.

- **Rodízio:** repita o nó em outra conta e separe as URLs por vírgula. O nó com mais folga é
  escolhido; nó que falhou vai para o fim por 90 s. Cota por nó: `ADSHIELD_FALLBACK_QUOTA_GB`
  (padrão 100) e `ADSHIELD_FALLBACK_QUOTAS=URL=GB` para quem não é Vercel.
- **Sticky:** o filme inteiro sai de um nó só (é ele que assina a playlist e os segmentos).
- **Zero Render:** o nó busca e entrega; o Render só devolve ~1 KB de JSON.
- **Sem a variável, nada muda.** Mesmo com ela, o caminho normal continua sendo o primeiro.

Valide o nó antes de ligar no Render:

```bash
npm run fallback:check -- https://SEU-NO https://exemplo.com/master.m3u8 SUA-CHAVE
```

## Limites

- A Vercel serve o HTML/JS/API do player; o vídeo em si continua vindo do CDN
  quando a URL é absoluta (como no VidLink). Se o player passar mídia pelo
  próprio `/api`, ela passa pela Vercel.
- Plano Hobby da Vercel tem limite de banda/duração; para uso intenso, confira
  os termos e limites atuais.
- O player pode ter checks de origem/anti-bot. Se o VidLink deixar de tocar
  atrás do proxy, use `PROXY_PLAYER_IFRAMES`/outro provedor ou mantenha o
  embed direto.
- O proxy não remove anúncios em vídeo (VAST/pre-roll); remove scripts,
  iframes, overlays e pop-ups do HTML.

---

# Vidsrc direto, sem iframe e sem anúncio (`/vidsrc/*`)

O mesmo projeto Vercel também **extrai o Vidsrc e entrega o vídeo** para o player
do fdsFlix. Não há iframe, então não há anúncio; o fdsFlix toca o HLS no próprio
`<video>` (hls.js).

## Como funciona

```text
fdsFlix /api/stream  ->  GET  <vercel>/vidsrc/stream?tmdb=603      (JSON: master.m3u8 assinada)
navegador (hls.js)   ->  GET  <vercel>/vidsrc/hls?u=...&s=...      (playlists e segmentos .ts)
<vercel>             ->  vidsrc.sh -> stellar -> api.php + WASM -> /pl/.../master.m3u8
```

### Por que precisa passar pela Vercel (IP binding)

O CDN do Vidsrc responde `ip X not in range` se o token (JWT) for usado por outro
IP. O token carrega `ip_cidr` (IPv4 `/24`, IPv6 `/64`) e o `api_token` que o gera
também é amarrado ao IP. As chamadas de extração não têm CORS e exigem `Referer`
do Vidsrc, então o navegador do usuário não consegue gerar o próprio token.

Medido nos testes:

- só o **token** é amarrado ao IP; o caminho `/pl/...` **não é**;
- o token vale para **qualquer título/episódio** e dura **4 h**;
- a Vercel sai por **vários IPs** (7 diferentes em 30 requisições paralelas).

Por isso o proxy guarda **um token por instância** e o aplica em qualquer caminho
(`getEdgeToken`). Se o CDN responder 403 porque o IP mudou, ele refaz o token e
repete a requisição sozinho. Em 429 (rate limit do CDN) ele espera e repete.

### Segurança

Playlists e segmentos ficam em domínios que mudam por título (ex.: master em
`oakhollowoutpost.space`, segmentos em `sageandsolstice.space`), então não existe
lista fixa de hosts. Toda URL que o proxy emite é **assinada com HMAC**
(`PROXY_SECRET`); URL sem assinatura válida recebe 403. Não é proxy aberto nem
dá SSRF (`http://169.254.169.254/...` também cai em 403). Sem `PROXY_SECRET`, a
chave é derivada de `VERCEL_DEPLOYMENT_ID` (funciona, mas defina `PROXY_SECRET`).

## Ligar / desligar (voltar ao que era)

No **Render** (fdsFlix):

```env
VIDSRC_PROXY_URL=https://SEU-PROJETO.vercel.app     # liga: Vidsrc vira a 1ª fonte
```

- **Desligar:** apague `VIDSRC_PROXY_URL` e faça redeploy. A cascata volta exatamente
  ao que era (VidLink primeiro). Nenhum outro arquivo precisa mudar.
- **Falha automática:** se a Vercel estiver fora ou o título não existir no Vidsrc,
  o provedor devolve `null` e a cascata segue para o VidLink sozinha.
- **Só reordenar:** `FALLBACK_ORDER=VidLink Pro,Vidsrc Proxy` deixa o VidLink na frente.

## Endpoints

| Rota | Uso |
| --- | --- |
| `GET /vidsrc/stream?tmdb=603` | filme; série: `&type=tv&s=1&e=1`. Devolve `url` (master) e `sources` (3 espelhos, cada um com 640p/1280p/1920p) |
| `GET /vidsrc/hls?u=&s=` | playlists e segmentos assinados |
| `GET /vidsrc/probe?tmdb=603` | diagnóstico: IP de saída e status de master/variante/segmento a partir da Vercel |

## Limites reais

- O vídeo **passa pela Vercel**: 1080p ≈ 2,2 GB/hora. O plano Hobby tem ~100 GB/mês
  de transferência (≈ 45 h de 1080p) e é de uso não comercial; confira os termos atuais.
- **Edge × função Node:** `/vidsrc/hls` roda no Edge runtime (`api/hls.js` + `lib/edgeHls.mjs`, ligado por
  `vercel.json`), que não conta *Fast Origin Transfer* (10 GB no Hobby). Na função Node (`lib/vidsrc.js`,
  usada por deploys antigos, sem esse rewrite) cada byte conta nos dois limites e o de 10 GB trava
  primeiro. `/vidsrc/stream` e `/vidsrc/probe` seguem na função Node (decifrar a lista usa WASM, que o Edge
  não compila). O Edge gera o PRÓPRIO token do CDN: o IP de saída dele é outro e o token é amarrado ao /24.
  `GET /vidsrc/hls?cap=1` devolve `{"adproxy":"edge"}` (é como o Render descobre qual é qual).
- Medido (função na Vercel, região padrão `iad1`): 6–15× tempo real por usuário e
  3 usuários simultâneos sem erro. Rajada de 12+ segmentos paralelos no mesmo IP
  leva 429 do CDN, o que um player normal (1–2 por vez) não faz.
- Se o Vidsrc mudar a cadeia (`vs_src.php`, `CFG`, `CONFIG.apiToken`, WASM), a
  extração quebra. Use `/vidsrc/probe` para ver em qual etapa falhou.
