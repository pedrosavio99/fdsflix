# AdShield na Vercel (sem Render/VM)

O AdShield é o proxy que **sanitiza o HTML do player** e injeta o bloqueio de
`window.open`/pop-ups. Rodando na Vercel (serverless), nenhum PC precisa
instalar extensão e não é preciso Oracle/VM.

## Subir

Na Vercel, crie um projeto separado apontando para a pasta `adproxy` deste
repositório (Root Directory = `adproxy`).

Variáveis de ambiente:

```env
TARGET_ORIGIN=https://vidlink.pro
PROXY_SECRET=<openssl rand -hex 32>
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
