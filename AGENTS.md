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
- **Internet Archive** (`lib/archiveOrg.js`, `ARCHIVEORG_ENABLED=0` desliga): **a fonte que o Render
  consegue usar quando redecanais/mgeb.lat barram o datacenter** (403 para Render e Worker).
  archive.org não fica atrás de Cloudflare, tem API pública (`advancedsearch.php` + `/metadata/<id>`),
  MP4 estável (sem token nem IP preso) e aceita `Range`. Só filmes, vem depois do TokyVideo. Acha
  pelos nomes do TMDB, exige **título igual** (`sameTitle`: "Toy Story 2" não vale para "Toy Story"),
  **duração do arquivo = runtime do TMDB** e descarta 10-bit/HEVC/mkv. Prefere `language: por`
  ("R4BR", "dublado"). O `/download` dá 302 para `dnNNN.*.archive.org`: resolvemos o redirect aqui;
  o servidor final **não manda CORS** (`cors:false`, `browserDirect:true` → 0 byte no Render).
  Cobertura depende do título (Chihiro dublado pt-BR 125 min, Clube da Luta sim; Poderoso Chefão,
  Pulp Fiction não têm filme inteiro). Teste: `test/archiveOrg.test.js`.
- **MGEB: a cota do CDN do fontedecanais estourou ("Limite de 10 TB atingido", HTTP 403 para qualquer
  IP, medido em 2026-11-15)** — não é bloqueio de IP. A página lista `var sources = [...]` com
  outras opções (MP4 hospedado fora, HLS); `lib/mgeb.js` agora testa todas as opções MP4 (com ou sem
  `token`), exige `ftyp` e, nas sem token, duração de filme (≥40 min; episódio ≥8 min).
  Ex.: Chihiro (129) → "Opção 3", MP4 no bitchute, 125 min, áudio `por`. Poucos títulos têm essa opção
  (1 de 96 populares). A **página** do mgeb ainda é barrada de datacenter (Render/Worker 403): isso
  segue exigindo saída residencial/BR (`docs/RELAY-RESIDENCIAL.md`).
- **Catálogo de links** (`lib/catalog.js`, `lib/catalogHarvest.js`, `scripts/harvest.js`, `CATALOG_ENABLED=0`
  desliga): **a saída para sites que barram datacenter.** BitChute (API) e mgeb ficam atrás de Cloudflare,
  mas o MP4 que apontam (`seedNNN.bitchute.com/.../id.mp4`) é **estável, sem token e abre de qualquer IP**.
  O resultado `tmdbId → MP4` fica **no Supabase** (tabela `pix_settings`, uma linha por filme:
  `catalog:<tmdbId>`; "procurei e não achei" em `catalogmiss:<tmdbId>`, refeito após 7 dias). O servidor
  lê tudo na memória (renova a cada 5 min) e `data/catalog.json` é só semente/reserva (sem Supabase a
  gravação vai para o arquivo, que some quando o Render reinicia). Link morto é descartado na hora
  (`Range` cacheado); só entra URL sem token/assinatura (`isStableUrl`).
  **Colher pelo painel:** Admin → Outras fontes → cartão "Catálogo" (Colher agora / Parar / Adicionar link à
  mão / Remover). Rotas (admin): `GET /api/admin/catalog` (status + andamento), `POST .../harvest`
  (`{ids,lists,pages,force,delay}`), `POST .../stop`, `POST .../add` (`{id,url,audioLang,title}`),
  `DELETE .../:id`. A colheita roda no servidor, uma por vez, com pausa mínima de 2,5 s entre títulos, e
  para sozinha após 4 desafios seguidos do Cloudflare. As buscas do BitChute saem por
  `extractFetch.postJsonSmart` (direto → relay residencial/Wasmer `EXTRACT_RELAY_URL` → Worker), então do
  Render o relay entra automaticamente se estiver configurado. **Não rode em rajada** (uma varredura de
  ~300 chamadas fez o Cloudflare desafiar o IP de casa por horas). Pelo terminal: `npm run harvest --
  --pages=3 --delay=4000` (mesmo job; grava no Supabase se o `.env` tiver as chaves). Testes:
  `test/catalog.test.js`, `test/catalogStore.test.js`. **Ainda não medido:** se o Render consegue colher
  direto do BitChute (do PC de casa passa; do Render depende do Cloudflare/relay) — veja `relay` no status.
- **BitChute ao vivo** (`lib/bitchute.js`, `BITCHUTE_ENABLED=0` desliga): `POST api.bitchute.com/api/beta/
  search/videos` (`sort` válido: `new|old|views`; **`relevance` dá HTTP 400**) + `/api/beta/video/media`
  (devolve o MP4). Do Render o Cloudflare costuma desafiar; por isso existe o catálogo.
- **PeerTube** (`lib/peertube.js`, `PEERTUBE_ENABLED=0` desliga): SepiaSearch (busca federada) +
  `/api/v1/videos/<uuid>` da instância; MP4 com CORS aberto e `language.id` (pt ⇒ dublado). Aberto, sem
  Cloudflare, mas filme recente quase não existe lá (2 de 116 populares).
- **Descartadas (medido):** Dailymotion (busca aberta, mas o manifesto responde 403 `E005` — trava
  deliberada, não contornar), Odysee (busca aberta; CDN exige Referer do site e devolve 429), ok.ru
  (login), Rumble (sem resposta).
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

## Cascata em paralelo (abrir o vídeo o mais rápido possível)

`getFallbackStream` (`lib/fallbackCascade.js`) **não é mais em série**: as fontes leves partem juntas; as pesadas
(`HEAVY`: CinePro, CineWinx, Stream-Winx, Consumet, MegaMoviesLibre, API5, KekikStream — poupam os 0,1 CPU) só
entram aos 3 s ou quando as leves acabam sem nada. A ordem de `ALL_PROVIDERS` segue sendo a prioridade: vence a
de maior prioridade que entregar; se uma menor entregar antes, as maiores ainda têm 3 s (`PRIORITY_GRACE_MS`) para
chegar. Teto geral 40 s. Antes eram ~13 s só para chegar nas fontes novas (Vidsrc 8 s + Embed.su 2 s + …).
- **`accept` / `onReject`**: o `/api/stream` veta DENTRO da corrida a fonte que gastaria a banda do Render
  (`renderBound`) e a guarda em `boundCandidates` para o AdFallback — sem reiniciar a cascata (antes reiniciava e
  refazia tudo). Com o disjuntor do Vidsrc aberto + AdFallback configurado, `onReject` devolve `'stop'` e vai direto ao resgate.
- **`lib/providerMiss.js`**: fonte que respondeu "sem resultado" (nunca erro) fica 25 s marcada, e a etapa seguinte
  (opções → stream) pula a busca repetida. `?fresh=1` ignora (o "↻ Recarregar" manda isso).
- **Legendas de companhia**: `/api/stream` dispara `companionCaptions` (VidLink, cache 20 min) junto com a cascata e
  anexa a qualquer fonte que venha sem legenda (Internet Archive, BitChute, TokyVideo, catálogo…). Sem isso o
  original ficava sem legenda. No front, **dublado começa sem legenda** (só se a pessoa nunca escolheu; não grava
  isso como escolha) e **original liga a legenda** (pt-BR primeiro).
- `/api/stream/options` só oferece versão que o `/api/stream` realmente entrega (filtra `renderBound`; o front manda
  os mesmos `hevc`/`direct`). Orçamento 6 s (`BUDGET_MS`) + 2,5 s de tolerância; o front desiste da checagem em 8 s
  e segue a cascata normal. Testes: `test/parallelCascade.test.js`. Gancho de teste: `_setProviders()`.
- **`lib/matchGuard.js` — "este upload é MESMO este filme?"** (BitChute, Internet Archive, PeerTube). Título parecido +
  duração parecida NÃO bastam (caso real: "La Odisea", minissérie de 1997 publicada em 2023, casou com "A Odisseia",
  2026). Regras: publicado antes do lançamento (−14 dias) ⇒ não é; ano diferente no título ⇒ não é; ano do filme
  no título/descrição ⇒ vale (e ganha +20 de preferência); sem ano nenhum ⇒ só se o título for EXATAMENTE o nome
  principal do TMDB (pt-BR/original/inglês, nunca nome alternativo de outro país) e a duração bater em ±4%.
  Cada entrada do catálogo guarda o `label` (título do upload) e o painel o mostra para o admin conferir/remover.
  O Catálogo entra sempre na lista de fontes (não depende de já ter carregado do Supabase).
- `catalog.reachable`: tempo esgotado **não** mata o link (CDN do BitChute chega a demorar 10 s+ para 2 bytes);
  só resposta HTTP de erro conta como morto.

## "Outra versão" (botão do player) e troca automática

Botão **🔀 Outra versão** (`#switchSrcBtn`, público, texto neutro) ao lado de "↻ Recarregar". Serve para o filme errado ou que
não toca: descarta a versão em uso e busca a próxima (normalmente o AdFallback/outra fonte), retomando do mesmo ponto.
- A resposta do `/api/stream` traz dois ids OPACOS (o público não pode ver nome de provedor): `src` (fonte) e `sv`
  (arquivo de vídeo, hash de host+caminho). O front guarda os já descartados por título (`state.triedSrc`) e manda
  `?skip=<ids>&fresh=1`. O servidor tira as fontes pelo `src` e recusa o MESMO arquivo vindo por outra fonte pelo
  `sv` (ex.: Catálogo e BitChute ao vivo apontando para o mesmo MP4). Sem outra versão: avisa e libera as descartadas.
- **Troca automática**: o `/api/stream` manda `expectMin` (duração do TMDB, filmes). No `loadedmetadata`, se a duração do
  vídeo difere mais de `max(15 min, 20%)`, o front chama `switchVersion(true)` (até 2x por título).
- Troca pula a checagem dublado/original (`state.noOptions`) e vai direto à cascata.

**Legenda quebrada ⇒ português traduzido sozinho.** O failover só rodava com `!state.subUserChose`, e essa flag virava
`true` por qualquer legenda salva do título (inclusive a que o próprio player escolheu). Agora `subUserChose` só vale para o
que a pessoa mexeu na sessão. Ficou "ruim" quando: vazia, caracteres corrompidos (servidor e conferência local do texto
carregado: `�`, `Ã£`, `â€`…), poucas falas (< 1 a cada 75 s), termina antes de 80% ou depois de 130% do vídeo, ou a faixa
não carrega. A troca prefere "Português (Brasil) · tradução automática", depois pt, en e o resto.

**Casamento por título (TokyVideo)**: `titleScore` agora exige 3+ letras depois de normalizar e "contém" só por palavra inteira
(o nome russo "Гладiатор" virava "i" e casou "Gladiador" com "Pulp Fiction"); ano diferente (folga ±1) recusa o candidato.

## Aparelhos (admin): canal Roku

> **Vai criar app para outra TV (Android TV, Samsung, LG…)?** Leia antes `docs/AGENTE-NOVAS-TVS.md`: contrato da API, padrão de ligação com o admin, como testar e as armadilhas já pagas no Roku.

Botão **Aparelhos** (ícone de TV, `#devOpen`, `public/devices.js`, diálogo `#devDialog`) na barra do admin: um cartão por aparelho com o
**zip para baixar** e o **manual de instalação** (Roku é o único por enquanto). Rotas (admin, `requireStatsKey`): `GET /api/admin/devices`
e `GET /api/admin/devices/roku.zip` (monta na hora com `lib/rokuKit.js`, embute o endereço público do servidor em `config.json` e um
`build_version` novo). Visual igual ao do site (mesmas variáveis `--brand`, `--panel`, `cfg-card`; o app Roku usa as mesmas cores e o logo
"fds" vermelho + "Flix" branco, ver `roku/images/`).
- **Por que app nativo e não "launcher que mostra o site":** o Roku não tem WebView/navegador para canal, então não dá para renderizar o
  site e repassar o controle. O app (`roku/`, BrightScript/SceneGraph) é um **cliente fino da API**: `/api/home`, `/api/row`, `/api/details`,
  `/api/season`, `/api/search`, `/api/stream/options` (dublado/original), `/api/stream`, `/api/live/channels`, `/api/live/stream`. Toda a
  lógica (fontes, matchGuard, troca de versão, legenda) continua no servidor, então **quase nunca precisa reinstalar** — só se a interface do
  app mudar. Para Android TV/Fire TV um launcher com WebView seria possível (não feito).
- Recursos no app: abas Início/Filmes/Séries/TV ao vivo/Buscar; detalhe com temporadas/episódios; escolha dublado/original; tecla `*`
  (options) = "Outra versão" (usa `skip`/`src`/`sv` como no site, retoma a posição); troca sozinha se o vídeo errar ou a duração diferir de
  `expectMin`; TV ao vivo pula fonte `mode:"page"` (página de player, que o Roku não renderiza).
- Legenda: o app pede `/api/subtitle.srt` (o Roku lê SRT externo; o servidor converte o WebVTT com `vttToSrt` em `lib/subtitles.js`).
- **Design do app (pesquisado nas diretrizes do Roku):** 1280x720; zona segura de ação 64,35 → 1216,685 (nada importante fora dela; textos a
  96 px da borda nas telas de detalhe); texto de 20–22 px no mínimo, títulos 44–46 px, fonte **Inter** (a do site, TTF convertido de
  `@fontsource/inter`, `roku/fonts/`, licença OFL); cores = variáveis do site (`#0b0b10`, `#14141d`, `#a9a9bd`, `#e50914`). Padrão da home =
  **painel de destaque do título em foco** (fundo = backdrop do item com gradiente `overlay_hero.png`, título/ano/nota/gêneros/sinopse que mudam
  ao navegar, backdrop com debounce de 0,45 s) + UMA fileira de pôsteres 160x240 por vez, título da fileira desenhado por nós (não pelo RowList).
  Componentes próprios: `NavBar` (abas: atual sublinhada, foco em pílula vermelha), `PillButton`, `PosterItem`, `LiveItem` (cartão de canal),
  `EpisodeItem` (miniatura + título + sinopse), `SearchScreen` (MiniKeyboard + resultados ao digitar, com atraso de 0,8 s). Painel escuro atrás da
  lista de episódios (o backdrop claro deixava o texto ilegível). Simulação do layout (HTML com as mesmas coordenadas) conferida; NÃO foi vista numa TV.
- **Diagnóstico na tela:** o zip do admin sai com `"debug": true` em `config.json` e, se uma chamada falhar, o app mostra `[erro · status · URL]`
  (`failText` em `api.brs`). Para um build público use `buildKit({ debug:false })`: o público nunca vê detalhe técnico. Tela vazia/"não foi possível
  carregar" quase sempre é endereço errado no `config.json`. **Baixado de `localhost`, o zip embute o IP do PC na rede (`resolveApi`)**; a TV precisa
  estar no mesmo Wi-Fi e o servidor ligado. O mais seguro é baixar pelo site publicado (https).
- Texto do app é neutro (regra do público só vê o vídeo; teste em `test/roku.test.js` varre as frases do app).
- **Bugs que só o emulador mostrou (v1 do app, "não carregou nada"):** (1) `LoadConfig` usava `type(parsed.api)="roString"` e caía no endereço
  padrão (`fdsflix.onrender.com`, **suspenso**: HTTP 503 "Service Suspended"; o endereço atual do backend é `https://fdsflix-80ya.onrender.com`, que agora é o padrão do app); (2)
  `scene.setFocus(true)` no `main.brs` tirava o foco da barra de abas: tela abria e o controle não fazia nada; (3) `Dialog.message = [texto]`
  (no `Dialog` clássico é texto) → erro em qualquer mensagem; (4) logo de canal é objeto `{u,a,d}`, não texto. Corrigidos, com testes de
  regressão em `test/roku.test.js`. Rode o app no emulador antes de entregar (ver `roku/LEIA-ME.md`). Com `debug:true` o app mostra no rodapé
  "servidor: <endereço> · config ok" — se aparecer "CONFIG NAO LIDO", o `config.json` não foi lido.
- **Validação feita:** `bsc` (BrighterScript 0.73.8) compila o pacote sem erro (`bsc --rootDir roku --files "manifest" "source/**/*"
  "components/**/*" "config.json" --createPackage false --copyToStaging false`), e o zip gerado também. **NÃO foi executado num Roku**
  (sem aparelho), mas foi **executado no emulador `brs-node`** (home, detalhe, séries/episódios, busca, TV ao vivo, pedido de vídeo; sem erros no log). Incertezas a conferir na TV: nome do campo de legenda externa (`SubtitleTracks`
  + `subtitleTrack`), `streamFormat "ts"` na TV ao vivo e o visual do 9-patch de foco (`roku/images/focus.9.png`).
- Instalar: modo desenvolvedor da TV (Home×3, ↑↑, →←→←→), `http://IP-DA-TV` (usuário `rokudev`) → Upload → Install. Só um canal de
  desenvolvedor por vez (instalar substitui o anterior).

## Dublado ou original (escolha antes de tocar)

- `GET /api/stream/options?id&type&s&e&title` (`lib/streamOptions.js`): roda as fontes **em paralelo**
  (leves primeiro; CinePro/CineWinx/etc. só se as leves não acharem nada, por causa dos 0,1 CPU),
  classifica cada achado em `dub` (áudio pt: `audioLang`/`dubbed`/provedor "Dublado PT"/faixa `por` por
  ffprobe em MP4) ou `orig`, e devolve o melhor de cada. Cada opção traz um `pick` (token de 8 min no
  `registry`). Para quando tem as duas; com uma só, espera no máximo 3 s ou até as fontes "de dublagem"
  (`DUBBERS`) terminarem. Cache 10 min (2 min se vazio). Público não recebe nome de fonte (`provider`
  só com a senha admin). Erro/timeout ⇒ `{options: []}` e o front segue a cascata normal.
- `GET /api/stream?...&pick=<token>` reaproveita o link achado na 1ª tentativa (nada é procurado de
  novo); se for fonte que gastaria o Render, cai no fluxo normal (AdFallback etc.).
- Front (`public/index.html`, `chooseLanguage()` chamado em `renderPlayer()` antes do `/api/stream`):
  etapa `lang` do overlay com frases divertidas; **duas versões** ⇒ `#langPick` (dois cards animados
  no mesmo espaço do player, só aparecem quando as duas existem); **uma** ⇒ vai direto; **nenhuma** ⇒
  cascata normal. A escolha vale para o título nesta sessão (próximo episódio/recarregar não perguntam);
  `#langSwitch` ("🎧 Dublado · trocar") reabre os cards. O aviso "Acordando o servidor…" não aparece
  durante a checagem nem com os cards na tela.
- Legenda: falha de carregamento da faixa (`error` na `<track>`) ou legenda nativa ruim sem escolha
  manual ⇒ vai direto para **"Português (Brasil) · tradução automática"** (`translated:true`), antes de
  pt/en/resto. Só existe se a fonte tiver alguma legenda de outro idioma para traduzir.
- Testes: `test/streamOptions.test.js`. Verificado no Firefox (Playwright) em desktop e 390 px.

## Como rodar e testar

- `npm start` (porta `PORT`, padrão 3000) · `npm test` (289 testes, `node --test test/*.test.js`).
- Manutenção/"mudamos de URL": tela "Site" do admin (`lib/siteStatus.js`, `public/sitegate.js`, `public/site.js`; tabela `pix_settings` no Supabase).
- Docs: `docs/DEPLOY-RENDER.md`, `docs/VERCEL-POOL.md`, `docs/TV-AO-VIVO.md`, `docs/VISITANTES.md`, `docs/API.md`.
