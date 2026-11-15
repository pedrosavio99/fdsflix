# fdsFlix — notas para agentes

Player de filmes, séries e TV ao vivo (Node/Express + front estático em `public/`). Backend no Render, vídeo fora do Render.

## Regras do dono (valem sempre)

- **O público só vê o vídeo.** Visitante comum (sem a senha admin) escolhe filme, episódio e legenda, e só. Nada de servidor, Render, Vercel, fonte, ffmpeg, banda, nome de provedor ou motivo técnico de falha. Vale para filmes **e** para o modo TV.
- **Detalhe técnico só para o admin (senha `118111`).** No front: elementos com a classe `.admin-only` e o filtro "seguro por padrão" (`publicText`/`PUBLIC_OK` em `public/index.html`, `publicMsg` em `public/livetv.js`). Na API: só quando `statsKeyOK(req)` for verdadeiro.
- **Admin entra sem engrenagem visível:** `Ctrl+Shift+L`, `#admin` na URL, ou segurar o logo por 2 s (celular). Botões de admin: Acessos, Site, Pix, Configs, Sair.
- Texto novo para o usuário final: escreva neutro. Se for técnico, é `.admin-only`.

## Capacidade estimada (PENDENTE de teste de carga real)

Medido localmente em 2026-11-14 (servidor sozinho, sem o vídeo real) e cruzado com os limites oficiais. **Nada disso foi testado no Render nem com o pool de Vercels/Worker reais.**

Hardware assumido: Render **Free** = 512 MB RAM e **0,1 CPU** (o `render.yaml` diz `plan: free`). Dorme após ~15 min sem tráfego; acordar leva ~1 min.

| Medida (local) | Valor |
|---|---|
| RAM do Node em repouso / após carga | ~170 MB / ~210 MB (não é gargalo) |
| CPU por chamada leve (`/api/health`, `/api/site/status`) | ~1 ms |
| CPU por abertura de `/` (index.html 298 KB, gzip a cada pedido) | **~20 ms** (era o ponto fraco) |
| Visita nova completa (html + livetv.js + demais) | ~35 ms de CPU, ~110 KB de banda |

Estimativa (a CPU local é mais rápida que 0,1 CPU do Render; trate como ordem de grandeza):

- **Só o Render (CPU/RAM), com o vídeo saindo por fora:** ~300 espectadores simultâneos (faixa 100–500). Cada espectador faz poucas chamadas leves (aviso de uso a cada 20 s, status do site a cada 45 s, EPG da TV a cada 60 s).
- **Chegada de visitantes novos:** ~3 a 5 por segundo sustentados (CPU do gzip do HTML). Visita que volta recebe 304 e custa quase nada.
- **Teto prático hoje: ~50–150 simultâneos (média ~100)**, porque quem limita é a entrega do vídeo, não o Render:
  - **Worker da Cloudflare (plano grátis):** 100 mil requisições/dia e **1.000 req/min** de pico. Cada trecho HLS (4–6 s) conta uma requisição; um espectador faz ~10–15 req/min, então ~70–100 simultâneos no Worker, e ~55–80 filmes inteiros por dia.
  - **Vercels do pool (Hobby):** 100 GB/mês cada. Um filme de 2 h em 720p gasta ~1,8–2,7 GB, então ~40–55 sessões de filme por conta por mês. Total = nº de contas × isso.
  - **ffmpeg no Render (`ALLOW_RENDER_VIDEO=1`):** `MAX_SESSIONS=1`, 360p → **1 espectador**. Mantido bloqueado por padrão.
  - **Banda de saída do Render:** o código assume 5 GB/mês (fontes na web divergem; confira no painel) → ~40 mil visitas novas/mês só de páginas.
- Players alternativos ("Opção N", embeds de terceiros) não gastam nada nosso.

Fontes dos limites: docs da Render (free: 512 MB / 0,1 CPU, spin-down 15 min), docs da Cloudflare Workers (Free: 100k req/dia, 1.000 req/min, 10 ms de CPU), docs da Vercel (Hobby: 100 GB de Fast Data Transfer, uso não comercial). Confirme os números de banda antes de decidir plano.

## Próximos passos (o dono vai fazer depois dos testes)

1. **Pré-comprimir e cachear** `index.html` e os JS grandes (hoje o `compression` recomprime a cada pedido): ~20 ms → ~1 ms por visita e `Cache-Control` de 5–10 min. Maior ganho pelo menor esforço.
2. **Servir o site por host estático** (Cloudflare Pages ou Vercel) com `API_ONLY=1` (já suportado em `server.js`; `FRONTEND_URL` redireciona quem abrir a URL do Render). O Render fica só com a API.
3. **Teste de carga no Render real** antes de divulgar: página, `/api/stream`, e um filme tocando de verdade com o pool/Worker configurados. Registrar aqui os números reais e trocar a estimativa acima.
4. Conferir **quantas Vercels há no pool** e se o vídeo está saindo pelo Worker ou pelo pool (`EDGE_MEDIA`, `MEDIA_RELAY_URL`); isso define o teto real de simultâneos.
5. Se passar de ~100 simultâneos: Worker pago (ou relay próprio em `deploy/media-relay`) e Render Starter (0,5 CPU).

## Como rodar e testar

- `npm start` (porta `PORT`, padrão 3000) · `npm test` (183 testes, `node --test test/*.test.js`).
- Manutenção/"mudamos de URL": tela "Site" do admin (`lib/siteStatus.js`, `public/sitegate.js`, `public/site.js`; tabela `pix_settings` no Supabase).
- Docs: `docs/DEPLOY-RENDER.md`, `docs/VERCEL-POOL.md`, `docs/TV-AO-VIVO.md`, `docs/VISITANTES.md`, `docs/API.md`.
