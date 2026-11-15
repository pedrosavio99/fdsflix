# Relay residencial (contornar bloqueio de IP de datacenter)

## Por que

Os sites que raspamos (redecanais, mgeb.lat, vidlink…) ficam atrás do Cloudflare e **desafiam
IP de datacenter**. Do Render (AWS) eles respondem `403` / "Just a moment"; de uma conexão
residencial respondem normal.

Máscaras públicas **não resolvem** (medido): `r.jina.ai` leva o desafio, `allorigins`/`corsproxy`/
`codetabs`/`thingproxy`/`corsfix` dão erro. Todas são datacenter.

A saída é um relay **seu**, rodando em casa — o projeto já tem o servidor (`deploy/media-relay`),
que roda o mesmo código do Worker.

## Como montar (10 min, grátis)

1. No PC de casa (o mesmo que tem o projeto):

```bash
RELAY_KEY="uma-senha-forte" PORT=8787 node deploy/media-relay/server.mjs
```

2. Exponha para a internet com um túnel (não precisa abrir porta no roteador):

```bash
cloudflared tunnel --url http://127.0.0.1:8787
# copie a URL https://xxxx.trycloudflare.com
```

3. No Render, configure:

```
EXTRACT_RELAY_URL=https://xxxx.trycloudflare.com
EXTRACT_RELAY_KEY=uma-senha-forte      # a mesma RELAY_KEY
```

Pronto: a extração (busca no redecanais, mgeb, busca na web) sai pelo seu IP residencial, e o
vídeo continua indo do CDN direto para o navegador (o relay não carrega vídeo).

## Ordem de tentativa

`lib/extractFetch.js` tenta sempre: **direto → residencial → Worker**. Em desenvolvimento o
direto funciona; no Render o residencial entra no lugar.

O painel **Outras fontes** mostra a cadeia em uso ("saída: residencial + worker").

## Cuidados

- O túnel `trycloudflare.com` muda de URL a cada reinício: para URL fixa, use um tunnel nomeado
  (domínio próprio + `cloudflared tunnel create`).
- O PC de casa precisa estar ligado quando você usar o admin (para o público, as fontes por API
  que funcionam sozinhas continuam valendo).
- Não use isso para servir vídeo: o relay residencial é só para **extrair** (JSON/HTML, poucos KB).
