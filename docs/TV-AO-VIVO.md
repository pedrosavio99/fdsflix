# TV ao vivo

Botão **TV ao vivo** na barra do topo, ao lado da lupa (atalho: `#tv` na URL). É um módulo separado do player de
filmes: nada do fluxo de títulos, legendas ou cascata de filmes foi alterado.

## Como funciona

```text
navegador --GET /api/live/stream?ch=espn--> Render   (só JSON, alguns KB)
Render: junta fontes -> testa de verdade (playlist + 1 segmento) -> escolhe por onde o vídeo vai
navegador <-- vídeo ---------------------- fonte direta | Vercel (/live/hls, /live/np) | AdShield (páginas de player)
```

O vídeo **nunca passa pelo Render**. Se uma fonte não tem como chegar ao navegador sem passar por ele, ela é pulada.

| Tipo da fonte | Por onde vai | Consome |
| --- | --- | --- |
| HTTPS com CORS | direto da fonte para o navegador | nada seu |
| HTTP, ou HTTPS sem CORS, nas portas 80/443 | Vercel Edge `/live/hls` | banda da Vercel (100 GB/conta) |
| qualquer outra porta | Vercel função Node `/live/np` | banda da Vercel (10 GB/conta, conta também Fast Origin Transfer) |
| página de player (HTML com anúncios) | AdShield `/_adshield/r/<token>` | banda da Vercel; tira anúncios e bloqueia pop-ups |

Por que duas rotas: o Edge da Vercel só alcança as portas 80 e 443 (outra porta é descartada e a conexão vai para a
porta padrão), e a maioria das fontes de IPTV usa portas como 8081, 25461 ou 14432.

## Cascata do canal

1. Fontes do canal, em ordem: `LIVE_SOURCES_JSON` → semente (pacote `lib/liveSources.packed.js`) → fontes achadas nas listas `.m3u`.
2. Cada fonte é testada de verdade (`lib/liveProbe.js`): playlist, variante, **último segmento** (confere MPEG-TS/fMP4).
   Playlist que responde 200 com segmento 403 é descartada. Criptografado (AES/DRM) também.
3. A primeira que toca vence. Páginas de player só entram se nenhum HLS tocar.
4. Se uma fonte boa no servidor falhar no navegador (geobloqueio, token preso ao IP), o player avisa e o servidor
   entrega a próxima (até 4 por tentativa; `bad`/`skip` na URL).
5. Cache de saúde: 3 min para o que tocou, 12 min para o que falhou. Um teste em segundo plano roda enquanto alguém usa a aba.

As listas `.m3u` (iptv-org/br, gistpad, pastebin) são varridas a cada 6 h e cada entrada é ligada ao canal pelo nome
normalizado (`ESPN` não casa com `ESPN 2`). Xtream sem extensão (`.../11006`) ganha a variante `.m3u8`.

## Variáveis (todas opcionais; ver `.env.example`)

| Variável | Para quê |
| --- | --- |
| `LIVE_SOURCES_JSON` | `{"sportv":["https://..."]}` soma fontes antes da semente, sem mexer no código |
| `LIVE_CATALOG_URLS` | listas `.m3u` extras |
| `LIVE_SCAN_CATALOGS=0` | desliga a varredura das listas |
| `LIVE_WARM=0` | desliga o teste em segundo plano |
| `LIVE_PAGE_HOSTS` | hosts de páginas de player entregues pelo AdShield (os de fábrica vêm no pacote de fontes) |
| `PROXY_SECRET` | igual no Render e nas Vercels (assina os links; se não definir vale o embutido do repositório) |

## Área para nerds (só administrador)

No fim da aba **TV ao vivo** aparece **🤓 Área para nerds (administrador)**. Só existe no modo admin (a senha do painel, guardada em
`fdsflix.adminKey`); visitante comum não vê nem coleta nada disso.

- **Painéis ao vivo (1 s):** velocidade de cada baixada (Mbps), consumo do vídeo, buffer, qualidade (resolução e kbps), quadros
  perdidos, atraso ao vivo, total baixado e a internet do aparelho (`navigator.connection`).
- **Gráfico da internet:** últimos 90 s com a velocidade da baixada (verde), o bitrate do vídeo (amarelo tracejado) e o buffer (azul).
  Baixada abaixo do bitrate, ou buffer caindo a zero, explica o travamento.
- **Navegador (ao vivo):** log colorido igual ao dos filmes (`abrir`, `servidor`, `hls`, `falhou`, `tocando`, `diagnostico`). Quando a
  playlist falha, o navegador repete o pedido e anota o HTTP e o texto que a Vercel/fonte devolveu.
- **Servidor:** vem de `GET /api/live/diag` (senha de admin, `x-stats-key`): totais, config, Vercels do pool, canais e eventos
  (`teste`, `cascata`, `entrega`, `vercel`, `navegador`, `aquecimento`, `retestar`). **Detalhar: canal** abre todas as fontes dele com
  tipo, tempo, https/porta/CORS, idade do teste e motivo da falha. **Retestar canal** ignora o cache.
- **📋 Copiar logs:** busca os dados frescos do servidor e copia tudo (navegador + servidor) para colar no chat. Horas em UTC.

**Segredos:** por padrão as URLs saem mascaradas (usuário/senha de painéis Xtream e tokens viram `…`). **URLs inteiras** mostra tudo,
inclusive credenciais; não cole em lugar público. Os eventos do servidor ficam só em memória (últimos 300; zeram quando o Render reinicia).

## Entrega pela Vercel é conferida antes

Para fontes HTTP/sem CORS, o servidor não confia só no `?cap=1`: abre a playlist assinada pela Vercel (poucos KB, não gasta o vídeo do Render) e
exige `200` + `#EXTM3U`. Se a Vercel recusar (por exemplo `403 URL não assinada ou vencida`, host bloqueado, fonte fora do ar para ela),
o evento `vercel` registra o motivo e o servidor tenta a próxima Vercel (até 3 conferências) antes de dizer "sem sinal".

## MPEG-TS cru (ESPN 2, SporTV 3, Premiere, Combate...)

Fontes que entregam o fluxo MPEG-TS direto (sem playlist) agora tocam: se nenhum HLS funciona, o servidor usa o TS cru vivo como
último recurso e entrega **sempre pela Vercel** (`/live/np`, função Node; o Edge não serve para stream longo). O navegador carrega o
`mpegts.js` só nesse momento (CDN jsDelivr com SRI; cópia local de reserva em `public/vendor/mpegts.min.js`, que só pesa no Render se o CDN
falhar). A Vercel corta streams longos (~5 min): o player reconecta sozinho (até 30 vezes) e a banda é contada no medidor das Vercels.

## Plano B: AdShield (funciona SEM redeploy das Vercels)

As Vercels já publicadas não têm as rotas `/live/*`, e a rota genérica do AdShield (`/_adshield/r/<token>`) entrega HLS e TS mas **sem CORS**,
então o site (outro domínio) não conseguiria ler a resposta. A solução é um **player servido pela própria Vercel**:

1. O servidor (Render) gera um token do AdShield para a fonte e outro para a página `GET /api/live/player?p=<token>&k=hls|ts` (≈5 KB de HTML,
   `lib/livePlayer.js`; o vídeo nunca passa pelo Render). O endereço público vem de `RENDER_EXTERNAL_URL` (o Render define sozinho).
2. O navegador abre um iframe em `https://<vercel>/_adshield/r/<token da página>`. O AdShield busca a página no Render, reescreve o script
   do hls.js/mpegts.js (CDN) para passar por ele e entrega.
3. Dentro do iframe, o player busca o vídeo em `/_adshield/r/<token da fonte>` do **mesmo domínio**: sem CORS. Playlists têm os segmentos
   reescritos pelo AdShield. O TS cru reconecta sozinho quando a Vercel corta o stream (~60 s).
4. O player avisa o site por `postMessage` (tocando, erro, bytes, buffer, velocidade); é daí que vêm a banda contada e a área nerd.

O servidor confere de ponta a ponta antes de entregar (abre a playlist, ou lê o primeiro pacote do TS, por `/_adshield/r/`). Ordem de entrega
para fonte HTTP/sem CORS: rotas `/live/*` (se a Vercel as tem e aceita a assinatura) e, senão, este plano B. Custo: o AdShield é função Node,
então conta também a cota de Fast Origin Transfer (10 GB no Hobby); as rotas `/live/hls` (Edge) são mais baratas, mas exigem redeploy.

## Assinatura das Vercels

O link `/live/hls` e `/live/np` é assinado pelo Render e conferido pela Vercel; o AdShield usa a mesma cadeia de segredo
(`PROXY_SECRET` > `SESSION_SECRET` > embutido em `adproxy/lib/secret.js`). Se uma Vercel tiver segredo próprio (o caso da `fdsflix-mu` em
produção, que recusa até o segredo embutido), a assinatura do Render dá `403 URL não assinada` / `Token de recurso inválido`.

- **Render:** tenta o segredo dele e, se for diferente do embutido, o embutido; lembra qual cada Vercel aceita.
- **Vercel que recusa tudo:** sai da entrega por 5 min (evento `vercel` no log) em vez de gastar 12 s por fonte, e o erro mostrado ao usuário
  passa a ser o motivo real ("Nenhuma Vercel conseguiu entregar esta fonte: ...").
- **Vercel nova (com redeploy):** passa a conferir o link com o segredo próprio **e** com o embutido (`getSecrets` em `adproxy/lib/liveHls.mjs`).
  Aceitar o embutido significa que quem lê o repositório consegue gerar links para a rota; se isso incomodar, use o mesmo `PROXY_SECRET`
  no Render e nas Vercels.

## Programação (EPG) e visual

A aba mostra o que passa em cada canal, no estilo da área de filmes: destaque "Agora na TV", fileiras com cartões 16:9 (programa atual,
horário, classificação indicativa e barra de progresso) e, ao assistir, o programa no ar com sinopse, o próximo e a grade das próximas 24 h.

- **Fonte:** guias XMLTV gratuitos da comunidade (`limaalef/BrazilTVEPG` no GitHub: `claro.xml` e `epg.xml`), sem chave e sem env nova.
  Ficam fixos em `lib/liveEpg.js` (`FEEDS`). O mapeamento canal do fdsFlix -> nome no guia está em `NAMES` do mesmo arquivo.
- **Custo:** o servidor baixa o guia (cerca de 14 MB) ao subir e a cada 6 h; é tráfego de ENTRADA, não conta nos 5 GB de saída do Render.
  Guarda só os canais do fdsFlix para as próximas 48 h (alguns KB) e responde ao navegador com JSON pequeno.
- **Rotas:** `GET /api/live/epg` (agora e próximo de todos os canais) e `GET /api/live/epg?ch=<id>` (grade do canal).
- **Melhor esforço:** se o guia sair do ar ou ficar velho, a TV funciona igual, só sem os títulos (o último guia baixado é mantido).
  Os horários vêm do guia (Brasília) e aparecem no fuso do aparelho. Canais sem programa no guia (Fox Sports, TBS, Syfy, abertas pequenas)
  aparecem só com o nome.
- **Novo canal:** acrescente o id e os nomes em `NAMES` (nomes em minúsculas, sem acento).
- **Logos das emissoras:** cada cartão mostra a logo do canal (catálogo público do iptv-org), sobre um fundo claro se a logo é escura e
  escuro se ela é clara. O navegador baixa a imagem direto do host de origem (imgur, Wikimedia...), então não gasta banda do Render.
  Elas ficam em `lib/liveLogos.json`, gerado por `node scripts/live-logos.js` (usa ffmpeg para medir a cor; roda na sua máquina, não no
  servidor). Canal novo: coloque o id do catálogo em `IDS` do script e rode de novo. Canal sem logo (ou imagem que não carregou) mostra o
  nome sobre um cinza sóbrio.
- **Visual:** a aba reaproveita as classes globais do site (`.hero`, `.row`, `.card`, `.modal`...), então segue o mesmo estilo dos filmes.
  Clicar num canal abre um modal (como o de filmes) com o player, o programa no ar, a grade completa de 24 h e a lista "Outros canais".
  O destaque e as fileiras vêm do guia; "Assistir agora" e "Ver programação" abrem o modal do canal em destaque. Esc fecha o modal e depois a TV.

## Adult Swim, geobloqueio e AES-128

- **Grupo "Adult Swim":** o canal (fontes IPTV da comunidade) e cinco canais 24 h da CDN da Turner (Rick and Morty, Metalocalypse, Toonami,
  Samurai Jack, Eric Andre). Listas de varredura acrescentadas: `iptv-org .../countries/us.m3u` e duas listas de pastebin/gist.
- **Hosts só para os EUA** (`turner.com`, `warnermediacdn.com`, regra `GEO_FENCED` em `lib/liveTv.js`): do Brasil dão 403. Os nós da Wasmer
  saem de Ashburn (EUA), então para esses hosts a sonda do servidor e a entrega ao navegador passam SEMPRE por um nó (AdShield), nunca direto.
  Se nenhum nó estiver configurado, o canal aparece "fora do ar" com o motivo. Essa regra existe só para o que a própria emissora publica de graça nos EUA.
- **AES-128:** a sonda agora aceita HLS com AES-128 de chave clara (baixa a chave de 16 bytes, decifra o início do segmento e confere que é vídeo).
  SAMPLE-AES e DRM continuam recusados. O hls.js e o Safari decifram sozinhos, e as duas rotas dos nós já reescrevem o endereço da chave.
- **Resposta da origem não derruba o nó:** o AdShield repassa o status da origem (ex.: 403 de geobloqueio, marcado com `x-adshield-version`); isso
  não tira mais o nó da rotação nem faz trocar de assinatura.
- **Logos:** `scripts/live-logos.js` inclui os canais do grupo (todos com a logo do Adult Swim).

## Imagem e fontes que não tocam

- **Só áudio:** o probe lê a tabela de programas (PMT) do segmento MPEG-TS e as variantes (`CODECS`/`RESOLUTION`) do HLS mestre;
  fonte sem vídeo é descartada ("só áudio"). Se mesmo assim tocar 9 s sem imagem (`0x0`, como HEVC que o navegador não decodifica),
  o navegador descarta a fonte e o servidor a tira da rotação por 6 h.
- **Fonte "direta" que o navegador não abre** (CORS ou bloqueio de rede, `Failed to fetch`): o servidor passa a entregar a MESMA fonte
  pela Vercel/AdShield por 30 min, em vez de pular de fonte.

## Cascata mais rápida

Os testes de fontes rodam em paralelo e a resposta sai assim que o primeiro HLS provado aparece (antes esperava o lote de 5 inteiro, preso
no timeout de 7 s das fontes mortas: 30 s a frio, agora ~7 s). A varredura das listas `.m3u` não segura mais o primeiro espectador (espera
no máximo 4 s e termina em segundo plano). O aquecimento testa primeiro as fontes nunca testadas.

## Publicar

1. Render: é só o deploy normal.
2. **Cada Vercel do pool precisa ser reimplantada** para ganhar `/live/hls`, `/live/np` e a validade nos links:
   `bash deploy-vercel.sh` (ou `npx vercel deploy --prod --yes` dentro de `adproxy/`). Vercel antiga continua tocando
   filmes, mas a TV ao vivo a ignora (o Render pergunta `?cap=1` a cada 10 min).
3. As fontes que são HTTPS com CORS tocam sem nenhuma Vercel.

## Limites

- **MPEG-TS cru** (URL sem playlist, como `http://host:14432/Espn`): detectado, mas não toca (o hls.js lê só HLS).
  Hoje isso deixa sem sinal canais que só têm fonte assim. Tocar exigiria mpegts.js no navegador e um fluxo contínuo
  pela Vercel (limite de duração por requisição), então ficou de fora.
- Fontes de IPTV de terceiros morrem e mudam o tempo todo; o painel mostra o que está no ar naquele minuto.
- Geobloqueio: o servidor testa de um IP e o navegador usa outro. O aviso `bad` cobre isso trocando de fonte.
- Páginas de player: só dá para saber que a página abre, não que o vídeo toca dentro dela.
- **Fontes no repositório:** as URLs (algumas com usuário, senha ou token de contas de terceiros) ficam em
  `lib/liveSources.packed.js`, que é JSON compactado em base64: não aparecem em busca nem a olho nu, mas isso é só
  ofuscação, não segurança (quem tem o código decodifica). O texto puro fica em `lib/live-sources.plain.json`, que o
  `.gitignore` deixa de fora. Para editar: `node scripts/live-pack.js --unpack`, altere o JSON e rode
  `node scripts/live-pack.js` de novo.
- `LIVE_ALLOW_PRIVATE_HOSTS=1` existe só para teste local com fonte em 127.0.0.1. Não ligue em produção.
