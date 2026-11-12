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
