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

1. Fontes do canal, em ordem: `LIVE_SOURCES_JSON` → semente (`lib/liveChannels.js`) → fontes achadas nas listas `.m3u`.
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
| `LIVE_PAGE_HOSTS` | hosts de páginas de player entregues pelo AdShield (já vem `sinalpublico.com`) |
| `PROXY_SECRET` | igual no Render e nas Vercels (assina os links; se não definir vale o embutido do repositório) |

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
- `lib/liveChannels.js` tem URLs com usuário/senha/token de contas de terceiros. Se o repositório for público, essas
  URLs ficam públicas: prefira `LIVE_SOURCES_JSON` no Render para listas privadas.
- `LIVE_ALLOW_PRIVATE_HOSTS=1` existe só para teste local com fonte em 127.0.0.1. Não ligue em produção.
