# Guia para agentes: criar o app do fdsFlix para outra TV

Leia primeiro o `AGENTS.md` da raiz (regras do dono valem aqui). Este arquivo é o roteiro para
**adicionar mais um aparelho** (Android TV/Fire TV, Samsung, LG, Apple TV…) ao lado do Roku, que já
está pronto e funcionando (`roku/`, `lib/rokuKit.js`, aba **Aparelhos** do admin).

## 1. Regras que não mudam

- **O público só vê o vídeo.** Nada de servidor, Render, provedor, fonte, ffmpeg ou motivo técnico na tela.
  Texto técnico só existe com `debug:true` no `config.json` do zip **baixado pelo admin** (senha `118111`).
  O teste `test/roku.test.js` varre as frases do app; faça um igual para o app novo.
- **Cliente fino.** O app só desenha telas e chama a API. Fontes, `matchGuard`, "Outra versão", legenda,
  dublado/original: tudo fica no servidor. Assim o app quase nunca precisa de reinstalação.
- **Mesmo visual do site e do Roku:** fundo `#0b0b10`, painel `#14141d`, texto secundário `#a9a9bd`,
  destaque `#e50914`, fonte Inter, logo "fds" vermelho + "Flix" branco (arquivos em `roku/images/` e `roku/fonts/`).
- Textos neutros e em português ("versão", não "fonte"; "Assistir"; "Outra versão").

## 2. Endereço do servidor

O backend atual é `https://fdsflix-80ya.onrender.com` (o antigo `fdsflix.onrender.com` está suspenso).
O zip/pacote **embute o endereço** de quem o gerou (`resolveApi` em `lib/rokuKit.js`: baixado de `localhost`
vira o IP do PC na rede). O app lê um `config.json` `{ "api", "key", "debug" }`; sem ele cai no padrão.
No diagnóstico (`debug:true`) mostre no rodapé `servidor: <endereço> · config ok`: foi isso que achou o bug
do endereço errado em minutos.

## 3. Contrato da API que o app usa (todas `GET`, JSON)

| Tela | Rota |
|---|---|
| Início / fileiras | `/api/home` (`hero`, `rows[]`), `/api/row?id=trending\|popular-movies\|popular-tv` |
| Detalhe | `/api/details?id=&type=movie\|tv`, `/api/season?id=&n=` |
| Busca | `/api/search?q=` (o app espera ~0,8 s depois da última tecla) |
| Dublado/original | `/api/stream/options?id&type&s&e&hevc=0&title=` → `options[]` (cada uma com `pick`); vazio = segue direto |
| Tocar | `/api/stream?id&type&s&e&hevc=0&title=` + opcionais `pick=`, `skip=<ids>`, `fresh=1` |
| Legenda | URL em `captions[]`; para quem só lê SRT, `/api/subtitle.srt` (converte WebVTT) |
| TV ao vivo | `/api/live/channels`, `/api/live/stream?ch=` |

Detalhes que já custaram tempo:

- Resposta de `/api/stream` traz `src` e `sv` (ids **opacos**). "Outra versão" = guardar os já descartados por
  título e mandar `skip=<ids>&fresh=1`, retomando do mesmo ponto. `expectMin` (filmes): se a duração do vídeo
  difere mais de `max(15 min, 20%)`, troca sozinho (até 2x por título).
- `mode:"page"` em TV ao vivo é uma página de player: TV sem navegador não renderiza; tente a próxima fonte.
- `logo` de canal é objeto `{ u, a:[cores], d }`, não texto. Logos são feitos para fundo claro: use `a[0]` como fundo do cartão.
- Servidor no plano grátis dorme após ~15 min: a primeira chamada pode levar ~1 min. Mostre "carregando", não erro.
- Resposta 5xx do Render às vezes é HTML: não presuma JSON.

## 4. Como o Roku foi ligado ao admin (copie o padrão)

1. `lib/<aparelho>Kit.js`: monta o pacote na hora (reuse `createZip` de `lib/poolKit.js`), injeta
   `config.json` e um `build_version` novo. Veja `lib/rokuKit.js` (`buildKit`, `resolveApi`, `kitAvailable`).
2. `server.js`: acrescente o aparelho em `GET /api/admin/devices` e crie `GET /api/admin/devices/<id>.<ext>`,
   ambas com `requireApiKey, requireStatsKey` (só admin).
3. `public/devices.js`: um cartão por aparelho (botão de baixar + manual "Como instalar" + "Bom saber").
   Tudo que vem da API entra por `textContent`. Tudo é `.admin-only`.
4. `test/<aparelho>.test.js`: conteúdo do pacote, config injetado, `debug:false` sem texto técnico,
   todos os arquivos referenciados existem, texto público neutro.
5. Atualize `AGENTS.md` (seção "Aparelhos") e a contagem de testes.

## 5. Opções por plataforma (pesquisa de memória: CONFIRME na documentação oficial antes de começar)

| Aparelho | Caminho provável | Observações |
|---|---|---|
| **Android TV / Google TV / Fire TV** | APK com `WebView` carregando o próprio site (ou app nativo cliente da API) | O mais barato: o site já funciona e o D-pad vira setas. Instalar por `adb install` ou "Downloader" no Fire TV. Precisa de foco por controle remoto (`tabindex`, `:focus`) e `crossorigin`/CORS como no site. Tela cheia + `keepScreenOn`. |
| **Samsung (Tizen)** | App web (HTML/JS) empacotado `.wgt` | Modo desenvolvedor na TV + Tizen Studio ou CLI. Navegação por teclas via `tvinput`/`keydown`. Há restrições de HTTP/Mixed content: use sempre `https`. |
| **LG (webOS)** | App web `.ipk` (CLI `ares-*`) | Modo desenvolvedor pelo app "Developer Mode" da LG (expira, precisa renovar). Mesma ideia do Tizen. |
| **Apple TV (tvOS)** | App nativo (Swift/TVUIKit) cliente da API | Exige conta de desenvolvedor paga; não há WebView. Só vale se o dono quiser. |
| **Chromecast** | Não é app: "enviar" de celular/PC | Fora do escopo, a menos que o dono peça. |

Antes de escolher, **pergunte ao dono qual aparelho ele tem** para testar. Sem aparelho, a validação é só emulador.

Se for WebView/web app, o front que já existe (`public/index.html`) pode servir; o trabalho real é
**navegação por controle remoto** (foco visível, ordem de setas, tecla Voltar/Play/Pause) e testar em 1920x1080 a 2 m de distância
(textos de 22 px ou mais, zona segura ~5% nas bordas).

## 6. Como testar (a lição mais cara deste projeto)

**Compilar não basta.** O app do Roku passou no `bsc` e mesmo assim não fazia nada: `config.json` ignorado,
foco perdido por uma linha em `main.brs`, `Dialog.message` com tipo errado, logos com formato errado. Tudo isso só
apareceu **executando**. Então, antes de entregar:

1. Rode o app num emulador/simulador do aparelho (Roku: `brs-node`, ver `roku/LEIA-ME.md`: precisa de Node 22,
   teclas por ECP `POST :8060/keypress/Down`, print por `-s arquivo.png` + Ctrl+S via pseudo-terminal).
   Outros: emulador do Android Studio (Android TV), Tizen Studio emulator, webOS TV simulator.
2. Faça o fluxo inteiro com as teclas do controle: início → abrir título → Assistir → (dublado/original) → tocar;
   série (temporadas/episódios); TV ao vivo; busca; Voltar em cada tela.
3. **Olhe o print real**, não só o log. Layout simulado em HTML não substitui.
4. Aponte para o servidor real (`https://fdsflix-80ya.onrender.com`) e para um local; confira `STATUS 200` nas chamadas.
5. Procure `ERROR` no log do emulador: o objetivo é zero.
6. Diga ao dono, sem enfeitar, o que **não** foi visto (ex.: o vídeo tocando, a legenda, o visual numa TV de verdade).

## 6b. Requisitos de player que TODO app novo precisa ter (o dono pediu no Roku)

1. **Menu de opções no player** com: **Legenda**, **Outra versão**, **Ir para o início**, **Continuar**. Abra por uma tecla que EXISTA em
   todos os controles (no Roku o `*` falta no Voice Remote Lite: use também a seta para baixo) e mostre uma dica de ~7 s ao iniciar o vídeo.
   Pause o vídeo com o menu aberto; fechar o menu sem escolher continua de onde parou.
2. **Legenda:** nunca ligue "a primeira da lista" (a API devolve dezenas de idiomas e a primeira pode ser árabe). Ordem:
   português do arquivo, português traduzido (`translated:true`), inglês, espanhol, resto. Só mostre no menu rótulos que a fonte da TV
   desenha (alfabeto latino) e limite a ~6. Dublado começa sem legenda; original liga a em português. A escolha da pessoa vale para o título
   inteiro e sobrevive à "Outra versão".
3. **Outra versão:** guarde `src` e `sv` da resposta e mande `skip=<ids>&fresh=1`; retome da mesma posição; se não houver outra, avise e
   libere as descartadas. Troque sozinho se o vídeo errar ou a duração fugir de `expectMin`.
4. **Sair sem sofrer:** Voltar tem que funcionar **em qualquer estado**. Em especial durante o "Carregando…" (a busca da fonte leva até
   40 s): Voltar CANCELA e respostas que chegarem depois são ignoradas (número de pedido/token por requisição). Ao sair do vídeo o foco volta
   para a lista/tela de onde veio (em TV ao vivo, a lista de canais, não a de filmes) e existe um atalho direto **Ir para o início**.
   Um app que "abre o vídeo por cima da tela errada" ou "fica sem resposta ao apertar Voltar" está reprovado.
5. Teste no emulador: Voltar durante o carregamento, menu → cada item, Voltar com o menu aberto, TV ao vivo → sair → mover pelo controle.

## 6c. Legenda: o que deu errado no Roku e como fazer certo (leia antes de implementar)

- **O link da legenda tem que durar o filme inteiro.** A TV só baixa a faixa quando a pessoa a escolhe, às vezes no meio do filme. O token
  valia 4 min e a faixa dava 404 "Legenda expirada" enquanto o menu dizia "(ativa)". Agora vale 3 h (`SUBTITLE_TTL_MS`). **Teste sempre
  escolhendo a legenda depois de mais de 4 minutos** (ou meça: pegue um `captions[].url`, espere e baixe de novo).
- **Prefira desenhar a legenda no próprio app** (baixar o `.srt`, ler as falas, mostrar a da posição atual) quando a TV só aceitar legenda
  externa em formatos/modos que você não consegue testar sem o aparelho. No Roku, MP4 com legenda externa é TTML na documentação e o
  `globalCaptionMode` altera a configuração global do aparelho. O leitor de SRT/VTT pronto está em `roku/components/srt.brs`
  (testado contra a legenda real, igual a uma contagem em Python) e pode ser portado.
- **Mostre o estado:** "Carregando legenda…" (a tradução automática demora) e, se falhar, "Não consegui carregar esta legenda." Nunca marque
  uma faixa como ativa antes de ela estar carregada.
- **Teste de legenda no emulador:** como o emulador não toca vídeo, simule a posição (cópia do app com a posição fixa em 125 s) e confira no
  print: fala certa, 2 linhas, troca de idioma, "Sem legenda". Diga ao dono que o sincronismo com vídeo real não foi visto.

## 6d. Tela de detalhe

- Precisa de **botão para voltar ao menu inicial** (filme: ao lado de "Assistir"; série: item da lista de temporadas, porque listas dão a
  volta com a seta para cima e um botão fora delas fica inalcançável). Teste a navegação por TODAS as setas, não só o caminho feliz.

## 7. Armadilhas conhecidas

- Dar `setFocus` na cena inteira tira o foco do componente que devia receber os botões (Roku). A exceção é de propósito: durante o "Carregando…" o foco vai para a cena para o Voltar cancelar (ver 6b).
- Foco numa lista **invisível** deixa o controle morto: ao devolver o foco, use a lista que está na tela.
- BrightScript: `pos` é palavra reservada (o emulador deixa passar, a TV não); comparar dois nós com `=` falha no emulador (use um marcador booleano). **O erro do emulador não contém a palavra ERROR**: varra o log por `mismatch|error|exception|cannot|can't be`, senão você acha que está limpo e não está.
- Servidor de teste local: antes de subir, confira se a porta está livre (`curl localhost:PORTA/api/health` já responder = tem servidor ANTIGO ali; o seu nem subiu e você testa código velho). Use uma porta nova.
- Em BrightScript, `type()` de valores vindos de `ParseJson` engana; leia o campo direto e teste `invalid`.
- Percent-encoding de títulos com acento: o Roku não faz sozinho; veja `urlEnc` em `roku/components/api.brs`.
- Não use redirect 302 para o CDN do vídeo: o Chrome perde o `Origin` nos `Range` (ver `AGENTS.md`). TVs com navegador baseado em Chromium herdam isso.
- `Referrer-Policy: no-referrer` é de app inteiro; um WebView que mande Referer pode quebrar o CDN do acervo.
- Não rode varreduras em rajada contra sites de terceiros (o Cloudflare desafia o IP).
- Um único canal de desenvolvedor por vez no Roku; instalar outro substitui o anterior.

## 8. Checklist de entrega

- [ ] Pacote gerado pela aba **Aparelhos**, com endereço embutido e `debug:true` (admin) / `debug:false` (público).
- [ ] Manual "Como instalar" no cartão do aparelho, em passos curtos e com as teclas em `[colchetes]`.
- [ ] Teste automático do pacote + varredura de texto público.
- [ ] Fluxo completo no emulador com prints conferidos e `ERROR` = 0.
- [ ] `npm test` verde; `AGENTS.md` e este guia atualizados.
- [ ] Commit só quando o dono pedir (o push dispara o deploy automático no Render).
