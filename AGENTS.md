# fdsFlix — notas para agentes

Player de filmes, séries e TV ao vivo (Node/Express + front estático em `public/`). Backend no Render, vídeo fora do Render.

## Regras do dono (valem sempre)

- **O público só vê o vídeo.** Visitante comum (sem a senha admin) escolhe filme, episódio e legenda, e só. Nada de servidor, Render, Vercel, fonte, ffmpeg, banda, nome de provedor ou motivo técnico de falha. Vale para filmes **e** para o modo TV.
- **Detalhe técnico só para o admin (senha `118111`).** No front: elementos com a classe `.admin-only` e o filtro "seguro por padrão" (`publicText`/`PUBLIC_OK` em `public/index.html`, `publicMsg` em `public/livetv.js`). Na API: só quando `statsKeyOK(req)` for verdadeiro.
- **Admin entra sem engrenagem visível:** `Ctrl+Shift+L`, `#admin` na URL, ou segurar o logo por 2 s (celular). Botões de admin: Acessos, Carga, Site, Pix, Configs, Outras fontes, Sair.
- Texto novo para o usuário final: escreva neutro. Se for técnico, é `.admin-only`.

## Capacidade estimada (PENDENTE de teste de carga real)

Medido localmente em 2026-11-14 (servidor sozinho, sem o vídeo real) e cruzado com os limites oficiais. **Nada disso foi testado no Render nem com o pool de Vercels/Worker reais.**

Hardware assumido: Render **Free** = 512 MB RAM e **0,1 CPU** (o `render.yaml` diz `plan: free`). Dorme após ~15 min sem tráfego; acordar leva ~1 min.

| Medida (local) | Valor |
|---|---|
| RAM do Node em repouso / sob carga de 35 mil plays | ~170 MB / oscila 190–320 MB. Com heap limitado a 96 MB não estourou e não houve vazamento. Não inclui o CinePro (processo filho só existe no Docker; RAM dele **não medida**) |
| CPU por chamada leve (`/api/health`, `/api/site/status`) | ~1 ms |
| CPU por abertura de `/` (index.html 298 KB, gzip a cada pedido) | **~20 ms** (era o ponto fraco) |
| Visita nova completa (html + livetv.js + demais) | ~35 ms de CPU, ~110 KB de banda |
| CPU por play (`/api/stream`, caminho feliz, nó da Vercel simulado) | **~6–12 ms** (antes do `streamGuard`). Mesmo título com 100 simultâneos: **~1 ms** (depois) |

`lib/streamGuard.js` (ligado em `/api/stream`, sem variável de ambiente): junta pedidos idênticos em voo (nada fica guardado depois da resposta; o "↻ Recarregar" faz busca nova) e limita 30 buscas simultâneas (excedente espera até 30 s e depois roda mesmo assim, nunca é recusado). Admin (senha) nunca é juntado nem enfileirado. Estatísticas em `/api/health` (admin): `streamGuard`. Testes: `test/streamGuard.test.js`.

Estimativa (a CPU local é mais rápida que 0,1 CPU do Render; trate como ordem de grandeza). Correções importantes: tokens de legenda vivem 4 min (`TOKEN_TTL_MS`), então **memória não é gargalo por causa das legendas**; e o Worker da Cloudflare **provavelmente nem carrega o vídeo** (o CDN principal recusa a rede da Cloudflare, ver `deploy/media-relay/README.md`; o vídeo do Vidsrc sai pelas Vercels).

- **Só o Render (CPU), com o vídeo saindo por fora e a banda resolvida com mais fallbacks/Vercels:** ~300 a 500 espectadores simultâneos. Cada espectador faz poucas chamadas leves (aviso de uso a cada 20 s, status do site a cada 45 s, EPG da TV a cada 60 s) e um play a cada 30–120 min.
- **Chegada de visitantes novos:** ~3 a 5 por segundo sustentados (CPU do gzip do HTML) até o cache do HTML (próximo passo 1). Visita que volta recebe 304 e custa quase nada.
- **Manada no mesmo título (lançamento):** resolvida pelo `streamGuard` (1 busca para todos). Manada em **títulos diferentes**: ~5–15 plays/s no 0,1 CPU.
- **Incógnitas que seguem abertas:** (a) RAM do CinePro dentro dos 512 MB; (b) custo do `/api/stream` quando o Vidsrc cai e a cascata percorre as outras fontes (com o CinePro raspando no mesmo CPU); (c) banda de saída do Render (o código assume 5 GB/mês; confira no painel).
- **Limites de entrega de vídeo (resolvidos por quem adiciona mais nós, não pelo Render):** Vercels do pool (Hobby: 100 GB/mês por conta, ~40–55 sessões de filme/conta/mês); ffmpeg no Render (`ALLOW_RENDER_VIDEO=1`: `MAX_SESSIONS=1`, **1 espectador**; mantido bloqueado); Worker grátis só se o teste de 1 byte passar para o provedor (100 mil req/dia, 1.000 req/min).
- Players alternativos ("Opção N", embeds de terceiros) não gastam nada nosso.

Fontes dos limites: docs da Render (free: 512 MB / 0,1 CPU, spin-down 15 min), docs da Cloudflare Workers (Free: 100k req/dia, 1.000 req/min, 10 ms de CPU), docs da Vercel (Hobby: 100 GB de Fast Data Transfer, uso não comercial). Confirme os números de banda antes de decidir plano.

## Próximos passos (o dono vai fazer depois dos testes)

1. **Pré-comprimir e cachear** `index.html` e os JS grandes (hoje o `compression` recomprime a cada pedido): ~20 ms → ~1 ms por visita e `Cache-Control` de 5–10 min. Maior ganho pelo menor esforço.
2. **Servir o site por host estático** (Cloudflare Pages ou Vercel) com `API_ONLY=1` (já suportado em `server.js`; `FRONTEND_URL` redireciona quem abrir a URL do Render). O Render fica só com a API.
3. **Teste de carga no Render real** antes de divulgar: página, `/api/stream`, e um filme tocando de verdade com o pool configurado. Medir também a RAM com o CinePro de pé. Registrar aqui os números reais e trocar a estimativa acima.
4. Conferir **quantas Vercels há no pool** e por qual caminho o vídeo sai (Diagnóstico do admin: Vercel, Worker, AdFallback ou embed).
5. Se o CinePro não for fonte de reserva necessária, `CINEPRO_EMBEDDED=0` libera RAM e CPU (decisão do dono; não foi mexido).
6. Se o teste mostrar CPU no limite: Render Starter (0,5 CPU). Rodízio de várias APIs no front (hoje há um `apiBase` só) só se ainda for preciso depois do cache do HTML.

## Tela "Carga" (admin): o servidor está aguentando?

Botão **Carga** na barra do admin (`#loadOpen`, `public/load.js`; servidor em `lib/loadMonitor.js`; rota `GET /api/admin/load`, só com a senha). Mostra ao vivo (3 s com a tela aberta): online agora (visitantes vistos no último minuto; cada aba aberta avisa a API a cada ~45 s), assistindo, plays/min com tempo p50/p95 e falhas, **CPU em % do limite do plano**, atraso do servidor (event loop), memória do contêiner (com a parte do CinePro), fila do `streamGuard`, **teto estimado de gente online** (projeção pela CPU de agora, só com 8+ online) e gráficos dos últimos 30 min. Com a tela fechada, o ponto no botão muda de cor (a cada 15 s), o título da aba ganha 🟡/🔴 e, quando piora, aparece um aviso no topo. Transições também vão para o log do Render (`[carga] ...`).

- **Sem variável de ambiente:** o limite real (Render Free = 0,1 CPU / 512 MB) é lido do cgroup (`/sys/fs/cgroup`); fora do Docker usa a máquina inteira. O "throttle" (tempo que o Render segurou o servidor por falta de CPU) é o sinal mais claro de saturação.
- **Limiares** (`evaluate()` em `lib/loadMonitor.js`): CPU 70% amarelo / 90% vermelho; throttle 20% / 50%; atraso p99 200 ms / 600 ms; memória 75% / 90%; abrir filme p95 6 s / 15 s; plays com falha 20% / 50% (só com 5+ plays no minuto); fila do `streamGuard` 1+ / 15+; disjuntor do Vidsrc aberto = amarelo.
- O atraso do servidor desconta o piso de 20 ms do medidor do Node. Histórico só em memória (zera quando o Render dorme/reinicia).
- Para o **teste de carga no Render real** (próximo passo 3): deixe esta tela aberta durante o teste; ela já mostra a RAM do CinePro e a CPU real, que eram as incógnitas.

## Fontes de vídeo (onde mexer)

A cascata é `ALL_PROVIDERS` em `lib/fallbackCascade.js`: cada provedor é uma função
`(id, type, s, e, title, { note })` que devolve `{ url, provider, quality, isHls, ... }` ou `null`.
Para desligar um provedor de teste, use `FALLBACK_ORDER` (só afeta a ordem/ lista exibida) ou a
variável própria dele.

- **TokyVideo** (`lib/tokyoVideo.js`, `TOKYOVIDEO_ENABLED=0` desliga): busca por título no
  tokyvideo.com, casa pelos nomes do TMDB e **confirma pela duração** contra o runtime (é o que
  separa filme inteiro de trailer/clipe). Só filmes (`type=movie`); em série devolve `null` sem
  requisição, porque as "series" do site não têm temporada/episódio confiáveis. Fica por último na
  cascata e só age quando nada mais entregou. O MP4 vem assinado (vale ~24 h, não é preso ao IP) e
  o CDN aceita qualquer origem: devolve `browserDirect: true` e o `/api/stream` responde
  `mode:"direct", via:"direct"` — **0 byte no Render e 0 conversão**. Não use `ffprobe` nesse
  acervo: os arquivos têm o `moov` no fim e a sonda lê dezenas de MB (o codec sai de um `Range`
  de 2 KB no `ftyp`). Teste: `test/tokyoVideo.test.js`.
- **Busca: o acervo vem dos CANAIS, não da busca do site.** A busca do tokyvideo devolve
  clipe/música para quase tudo ("um sonho de liberdade" → 69 resultados, nenhum o filme), então
  `lib/tokyoVideo.js` monta um índice com `/user/<canal>` (dá o id) + `/channel/<id>/videos?offset=N`
  (24 por página, com título e duração), guarda 6 h na memória, aquece no boot (`prewarm()`) e casa
  localmente por título + duração. Canais em `TOKYOVIDEO_CHANNELS` (padrão `matrizoculta,cinetel`;
  hoje ~202 vídeos, quase todos filmes). Busca direta (sem relay, ~3x mais rápida) com o relay de
  reserva. Canal que não responde encurta o cache para 10 min.
- **O CDN do acervo recusa Referer de fora (403) e o Chrome bloqueia os `Range` sem CORS (ORB).**
  Por isso: (a) as páginas HTML saem com `Referrer-Policy: no-referrer` (header em `server.js` +
  `<meta name="referrer">` no `index.html`) — decisão de app inteiro, avalie se algum provedor
  passar a exigir Referer; (b) o `<video>` precisa de `crossorigin="anonymous"` (o `#nativePlayer`
  já tinha; o do painel ganhou). **Não use redirect 302 para o CDN**: o Chrome perde o `Origin`
  nos `Range` depois do redirect e o vídeo morre com `MissingAllowOriginHeader`.
- **MGEB** (`lib/mgeb.js`, `MGEB_ENABLED=0` desliga): fonte **por ID do TMDB, sem busca** —
  `https://mgeb.lat/embed/<tmdbId>` devolve um MP4 direto (`zip` de CDN tipo
  `www-fontedecanais-bz.<hash>.com`). É um dos 6 players que o **redecanais** usa
  (`/wp-json/dooplayer/v1/<post>/movie/<n>` → `embed_url`); todos os seis são por id do TMDB, ou
  seja, para esses provedores não existe "refinar busca": o id já está no app. O MP4 é
  **faststart** (moov no começo, começa na hora), H.264, aceita Range e não exige Referer.
  **O mgeb.lat está atrás do Cloudflare e desafia IP de datacenter (403/"Just a moment"):** por isso
  `lib/mgeb.js` tenta direto e, se não sair MP4, **refaz pelo relay** (`VIDEO_RELAY_URL`) — o Worker
  passa. Sem esse retry a fonte não funciona no Render (foi o que fez "nada funcionar" nos testes).
  O CDN **não manda `Access-Control-Allow-Origin`**, então o resultado vem com `cors: false` e o
  `/api/stream` repassa isso; o front tira o `crossorigin` do `<video>` (TokyVideo, que exige CORS,
  vem com `cors: true`). Série: `/embed/<tmdbId>/<temporada>/<episódio>` (o seletor da página só troca o
  caminho; conferido: GoT S1E2 → 94049.mp4, S2E5 → 94062.mp4). Teste: `test/mgeb.test.js`.
- **Buscar na web** (`lib/websearch.js`, `WEBSEARCH_ENABLED=0` desliga): é o plano B quando
  nenhuma fonte de API entrega. Faz duas coisas: (a) **busca dentro dos sites** — hoje o
  `redecanais` (`/search/<título>/` → `/filme/<slug>/` → `data-post` + `/wp-json/dooplayer/v1/
  <post>/movie/<n>` → 6 `embed_url`, todos por id do TMDB, e o servidor 6 vem com `ds_lang=pt`);
  **A busca do site (`/search/...`) é a ÚNICA página barrada pelo Cloudflare** (403 de qualquer
  UA; `/filme/<slug>/` e `/wp-json/dooplayer/...` respondem 200 até de datacenter — medido pelo
  Worker). Por isso o caminho principal é **adivinhar o slug**: nomes do TMDB (pt-BR, original,
  inglês) → `slugVariants()` (com/sem artigo, com/sem ano) → `GET /filme/<slug>/` → confere o ano
  no `<title>` → `data-post`/`data-nume` → 6 `embed_url`. Só cai na busca do site se nenhum slug
  casar. A API do Dooplay **rate-limita** (429 / "error code: 1015") em rajada: `serversOf()` vai
  devagar (250 ms entre chamadas), para no primeiro 1015 e guarda 10 min de cache.
  (b) **busca no DuckDuckGo HTML + Bing** com as consultas "assistir <título> <ano> online
  grátis dublado", sonda as páginas e tira delas `data-tipo="dublado|legendado"` + `data-url`,
  `<iframe>`, `.m3u8/.mp4` e `data-post` do Dooplay. Sites de catálogo/crítica/loja (AdoroCinema,
  JustWatch, Filmelier, Disney+, Prime, YouTube…) são **excluídos** — não são fonte. Rota
  `GET /api/admin/websearch?title=&year=&type=&s=&e=` (admin). O DDG rate-limita (HTTP 202) às
  vezes; o Bing é o que segura. Resultado só entra se tiver **as palavras do título** em
  `matchesTitle()` (2+ palavras exigem 2) — sem isso o Bing devolve Baidu/calculadora para título
  ambíguo ("A Odisseia") ou pacote de viagem para "A Viagem de Chihiro".
  **Tudo aqui tenta direto e cai no relay** (`fetchText` → `fetchOnce(relay)`), porque no Render o
  IP de datacenter é barrado. Medido pelo relay: **Bing passa, mgeb.lat passa, redecanais NÃO**
  (403/challenge — o Worker também é barrado). Ou seja: busca por buscador funciona no Render,
  busca dentro do redecanais só de IP residencial. O painel mostra o motivo por site
  (`HTTP 403`) em vez de só "sem vídeo".
- **Saída de rede (máscara de IP): `lib/extractFetch.js`.** A extração (mgeb, redecanais, busca na
  web) tenta **direto → relay residencial (`EXTRACT_RELAY_URL`) → Worker (`VIDEO_RELAY_URL`)**.
  Motivo: os sites ficam atrás do Cloudflare e desafiam IP de datacenter; máscara pública não
  resolve (r.jina.ai, allorigins, corsproxy, codetabs, thingproxy, corsfix — todas testadas,
  todas barradas). O relay residencial é o `deploy/media-relay` rodando em casa e exposto por
  `cloudflared` — passo a passo em `docs/RELAY-RESIDENCIAL.md`. O painel mostra a cadeia em uso
  e tem **Testar relay** (`GET /api/admin/relay/test`), que mede cada saída contra redecanais e
  mgeb e diz `ok`/`challenge`/`HTTP n` — é o teste que decide se o relay que você subiu serve.
  Relay pronto para Wasmer Edge/Worker/Deno/Bun: `deploy/edge-relay/worker.js` (`?u=` + `x-senha`,
  `?probe=1` para diagnóstico, `RELAY_KEY` no ambiente).
- **Extensão como saída de rede (v1.1.0).** `extension/background.js` ganhou a ponte
  `fdsflix-ext-fetch`: o painel pede uma URL (`postMessage` → content script → background) e a
  extensão busca **pelo IP do navegador do admin** (residencial), devolvendo o HTML. É o que faz o
  painel funcionar no Render quando o servidor leva 403: o conteúdo chega do IP do dono. Só vale em
  páginas do fdsFlix e só para hosts de extração (`EXTRACT_HOSTS`), sem cookies. O painel mostra
  `redecanais (seu navegador)` quando a ponte responde; se não responder, cai na rota do servidor.
  **Ao atualizar a extensão, recarregue em `chrome://extensions` (↻).**
- **Idioma do áudio** (`lib/audioLang.js`): o painel lê a faixa de áudio com `ffprobe`
  (`stream_tags=language`) e mostra **🇧🇷 dublado** quando aparece `por`. É a diferença entre
  "o site diz dublado" e "o arquivo é dublado". Best-effort: sem ffprobe, não mostra o selo.
- **Painel "Outras fontes" do admin** (`public/tokyo.js`, botões `#tokyoOpen` na barra e
  `#tokyoFindBtn` nos controles do player, diálogo `#tokyoDialog`): a parte de cima é o **teste de
  todas as fontes** — `GET /api/admin/sources/test?id=&type=&s=&e=&title=` roda a cascata inteira em
  paralelo (teto de 15 s por fonte), devolve por fonte `ok/kind(mp4|hls)/quality/ms/url/cors` e o
  painel lista "X de 14 entregaram", com ▶ para tocar ali mesmo (mp4 no `<video>`; HLS via hls.js,
  que já vem na página). A parte de baixo é a busca no acervo do TokyVideo.
  O vídeo toca num `<video>` dentro do painel (não mexe no player nem nas estatísticas).
  Falha de fonte mostra o **motivo** (`tempo esgotado`, `HTTP 403`, `sem stream`) — é o que
  permite diagnosticar o Render sem abrir o log.
  Com um título aberto, `#tokyoFindBtn` chama `window.fdsFlixTokyo.openFor({id, type, title})`:
  a busca então usa os nomes do TMDB em vários idiomas (pt-BR primeiro) e a duração do filme, e
  marca "✅ confere" no resultado cuja duração bate com o runtime — é assim que se acha a versão
  em pt-BR do acervo. Sem contexto (aberto pela barra), é busca livre.
  **Os players dos sites tocam DENTRO do painel** (iframe `#tkFrame`, botão ▶ em cada servidor/opção):
  é o caminho para quem trava o token no IP do espectador. O `vidsrc.sh` (servidor 6 do redecanais,
  `?ds_lang=pob,pt,en` = dublado) usa `data-api` próprio, `apiToken` **preso ao IP** e
  `stream_urls` cifrado em ChaCha20 via WebAssembly (`vsdec.js`); descriptografei no Node, mas o
  `.m3u8` só abre para o IP que pediu o token — por isso embed/iframe, não extração. Rotas `GET /api/admin/tokyo/search?q=`,
  `GET /api/admin/tokyo/play?id=` e `GET /api/admin/sources/test` exigem `requireApiKey` + `requireStatsKey`; tudo (botão, diálogo,
  CSS `.tk-*`) é `.admin-only` e o módulo não roda sem `html.is-admin`. Texto vindo do site entra
  sempre por `textContent`. A busca reordena pelo título e marca "🎬 filme" a partir de 40 min;
  o checkbox "só filme" filtra na tela.

## Como rodar e testar

- `npm start` (porta `PORT`, padrão 3000) · `npm test` (236 testes, `node --test test/*.test.js`).
- Manutenção/"mudamos de URL": tela "Site" do admin (`lib/siteStatus.js`, `public/sitegate.js`, `public/site.js`; tabela `pix_settings` no Supabase).
- Docs: `docs/DEPLOY-RENDER.md`, `docs/VERCEL-POOL.md`, `docs/TV-AO-VIVO.md`, `docs/VISITANTES.md`, `docs/API.md`.
