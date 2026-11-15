# Relay de extração (Wasmer Edge, Worker, Deno, Bun ou Node)

Um arquivo (`worker.js`), sem dependências. Ele só **busca HTML/JSON** de sites que barram
IP de datacenter e devolve para o fdsFlix. Não carrega vídeo.

## Rotas

```
GET /?u=<url>            (header x-senha: RELAY_KEY)
GET /?probe=1&u=<url>    -> { ok, status, challenge, bytes, ms }   (sem senha, só diagnóstico)
```

## Subir no Wasmer Edge

1. Crie uma aplicação JS/Edge no painel da Wasmer.
2. Cole o conteúdo de `worker.js` como entrypoint (ele exporta `export default { fetch }`).
3. Defina a variável de ambiente **`RELAY_KEY`** com uma senha forte.
4. Publique e copie a URL (ex.: `https://fdsflix-relay.wasmer.app`).
5. No Render, configure:

```
EXTRACT_RELAY_URL=https://fdsflix-relay.wasmer.app
EXTRACT_RELAY_KEY=a-mesma-senha
```

> Se o runtime da Wasmer não aceitar `export default { fetch }`, use a versão Node:
> `RELAY_KEY=... node deploy/media-relay/server.mjs` em qualquer host com Node 18+
> (é o mesmo protocolo `?u=`), e aponte `EXTRACT_RELAY_URL` para ele.

## Testar se ESTE relay passa nos sites

Abra no navegador (troque a URL):

```
https://SEU-RELAY/?probe=1&u=https%3A%2F%2Fmgeb.lat%2Fembed%2F299534
https://SEU-RELAY/?probe=1&u=https%3A%2F%2Fwww4.redecanais.vip%2Fsearch%2Fvingadores%2F
```

`"ok": true` = esse relay serve para aquele site. `"challenge": true` = o Cloudflare barrou
aquele IP (relay não ajuda; precisa de IP residencial).

O painel do admin tem o mesmo teste em **Outras fontes → Testar relay**.
