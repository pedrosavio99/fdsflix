# fdsFlix Direct + AdShield (extensão Chrome/Edge)

Extensão **opcional** que resolve o problema que um site/proxy não consegue
resolver sozinho: fazer o vídeo do fdsFlix ir **direto do CDN do provedor para o
navegador**, sem passar pelo Render, e remover anúncios dos players embutidos.

> Isto não é um servidor. É uma extensão de navegador. Sem ela, o fdsFlix
> continua funcionando do jeito antigo (proxy/transcodificação no Render).

## Por que extensão?

Testei o CDN do VidLink:

```text
GET com User-Agent de navegador + Referer  -> 429
GET com User-Agent neutro e sem Referer    -> 206 video/mp4
```

O navegador não deixa uma página comum alterar `User-Agent`/`Referer` nem ler
uma resposta cross-origin sem CORS. Um proxy resolveria, mas aí o vídeo passa
pelo proxy. A extensão usa `declarativeNetRequest` para:

- trocar o `User-Agent` para `fdsFlix/2.0 (+local player)` nas requisições
  externas de mídia/XHR feitas pela página do fdsFlix;
- remover o `Referer`;
- adicionar `Access-Control-Allow-Origin: *` e expor `Content-Range`;
- bloquear domínios de anúncio;
- limpar elementos de anúncio nos iframes dos players;
- bloquear `window.open`/links externos e fechar abas em branco abertas
  pelos players (sem forçar o sandbox do player).

Assim o vídeo sai do CDN direto para o navegador: **0 bytes de vídeo no Render**.

## Instalar (Chrome ou Edge)

1. Baixe/atualize este repositório.
2. Abra `chrome://extensions` (ou `edge://extensions`).
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação** / **Load unpacked**.
5. Selecione a pasta `extension/`.
6. Abra `https://fdsflix-80ya.onrender.com` e dê play.

A extensão marca a página; o fdsFlix detecta e pede `direct=1` ao backend.
No console/status do player deve aparecer algo como:

```text
📡 O vídeo vai direto do provedor para o navegador (extensão) — 0 bytes no Render.
```

## Como saber se está funcionando

- Abra o DevTools → **Network** e filtre por `mp4`, `m3u8` ou o host do CDN
  (ex.: `bcdn.hakunaymatata.com`).
- As requisições de vídeo devem ir para o host do CDN, **não** para
  `fdsflix-80ya.onrender.com/api/proxy` nem `/hls/...`.
- O status do player deve dizer `0 bytes no Render`.

## Bloqueio de novas abas sem quebrar o player

Em vez de forçar o `sandbox` (que pode quebrar players), a extensão:

- sobrescreve `window.open` **só nos domínios do fdsFlix/players**:
  - permite same-origin (navegação do próprio player) e OAuth conhecido;
  - bloqueia domínio externo, `about:blank` e paths de anúncio;
- bloqueia cliques/forms `target="_blank"` externos;
- o [`background.js`](background.js) fecha, após ~1,2 s, abas que continuarem
  em branco/`about:blank` abertas por uma aba do fdsFlix/player.
- O “Modo seguro” do fdsFlix continua existindo e opcional; a extensão não
  força sandbox.

## O que a extensão altera

A regra [`rules.json`](rules.json) só age em requisições **externas** iniciadas
pela página do fdsFlix (`initiatorDomains`) e só nos tipos `media`,
`xmlhttprequest` e `other`. As chamadas para `/api/stream`, `/api/search` e
`/api/subtitle` no próprio fdsFlix não são afetadas.

Ela também bloqueia domínios de anúncio conhecidos e o [`content.js`](content.js)
remove scripts/iframes/contêineres de anúncio apenas no fdsFlix e nos domínios
de player conhecidos.

## Limitações

- **Precisa instalar a extensão.** Não existe como uma página comum alterar
  `User-Agent`/`Referer` ou ler vídeo cross-origin sem CORS.
- **Chrome/Edge 111+.** O Firefox tem suporte diferente a `world: MAIN` e DNR;
  não foi testado.
- **Anúncios em vídeo (VAST/pre-roll/mid-roll)** dentro do player não são
  removidos; são decisão do player. Overlays/popups/scripts de anúncio no HTML
  são removidos/bloqueados.
- Se o CDN mudar as regras (exigir outro header), a extensão pode parar de
  funcionar; o fdsFlix cai de volta no proxy do Render.
- A URL do provedor expira; para filmes muito longos pode ser necessário
  recarregar. O fdsFlix tem fallback para o servidor.
- A extensão tem permissão `<all_urls>` porque precisa rodar nos iframes dos
  players e alterar cabeçalhos dos CDNs. Instale apenas o código deste
  repositório; não baixe versões de terceiros.

## Se o fdsFlix mudar de domínio

Edite:

- `manifest.json` → `content_scripts.matches` (hoje `<all_urls>`);
- `rules.json` → `initiatorDomains` e `excludedRequestDomains`;
- `main.js`/`content.js` → `FDS_HOSTS`/`STRICT_HOSTS`.

## Teste rápido sem navegador

O backend pode ser testado com:

```bash
curl "https://fdsflix-80ya.onrender.com/api/stream?id=603&type=movie&res=480&hevc=1&direct=1"
```

Deve retornar `"mode":"direct"`, `"via":"browser"` e uma URL do CDN
(ex.: `bcdn.hakunaymatata.com`), não uma URL `/api/proxy` ou `/hls/` do
fdsFlix. Sem a extensão, essa URL responde **429** no navegador; com a
extensão, o `declarativeNetRequest` troca os headers e ela responde **206**.
