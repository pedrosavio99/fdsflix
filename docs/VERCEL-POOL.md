# Pool de Vercels: somar a banda e acompanhar o consumo

O vídeo do Vidsrc passa pela Vercel (o CDN amarra o token ao IP dela; ver
[adproxy/VERCEL.md](../adproxy/VERCEL.md)). Cada conta Hobby tem uma cota mensal de
transferência. Este guia mostra como colocar **várias Vercels** no fdsFlix e como ler
a barra de consumo.

## Como funciona

```text
Render (fdsFlix)  --/api/stream-->  escolhe a Vercel MENOS usada da pool
navegador (hls.js) <-- segmentos --  essa Vercel (um filme inteiro sai da mesma)
navegador  --a cada 20 s-->  Render /api/usage   (quantos bytes recebeu de cada Vercel)
Render  -->  barras "Consumo das Vercels" abaixo do player
```

- **Escolha:** por filme/episódio, o servidor ordena as Vercels da que tem **mais cota
  sobrando** para a mais cheia. Vercel que passou de **98 %** vai para o fim da fila (não é descartada: a estimativa pode estar errada).
- **Fallback:** se a escolhida falhar (404, 5xx, Vidsrc fora, playlist inválida), tenta
  a próxima, até 3. O painel "Diagnóstico" mostra cada tentativa.
- **Um filme fica numa Vercel só.** Não troca no meio da reprodução.

## Antes de começar: a cota é POR CONTA

A cota de transferência do plano Hobby vale para a **conta**, não para o projeto.
Vários projetos na mesma conta **não somam nada**. Para somar, cada Vercel precisa
estar em **uma conta diferente**.

> Aviso: o plano Hobby é de uso pessoal e não comercial. Abrir várias contas só para
> acumular cota pode ferir os termos da Vercel e levar à suspensão das contas. A decisão
> e o risco são seus; este guia não esconde isso.

Contas por GB (valores aproximados; confirme em *Usage* na sua conta; vale para Vercels **no Edge**, veja a
seção "Edge × função Node" abaixo: uma Vercel antiga rende 10 GB):

| Vercels | Banda/mês | 1080p (≈ 2,2 GB/h) | Filmes de 2 h |
| --- | --- | --- | --- |
| 1 | 100 GB | ≈ 45 h | ≈ 22 |
| 3 | 300 GB | ≈ 135 h | ≈ 68 |
| 5 | 500 GB | ≈ 225 h | ≈ 113 |

### Edge (100 GB) × função Node (10 GB): por que reenviar o kit

O plano Hobby tem **dois** limites de banda: *Fast Data Transfer* (100 GB, o que sai para o navegador) e
*Fast Origin Transfer* (10 GB, o que passa por uma **função**). Quando o vídeo passa por uma função Node,
cada byte conta nos dois, e o de 10 GB trava primeiro: a conta rende **10 GB, não 100**. Se estourar, a
Vercel pausa o projeto.

O kit atual entrega o vídeo pelo **Edge runtime** (`api/hls.js`, ligado por `vercel.json`), que **não conta**
Fast Origin Transfer (medido: 300 MB pelo Edge, FOT = 0). Assim a conta usa os 100 GB.

- **Nada quebra com Vercels antigas.** A URL assinada tem o mesmo formato, então uma Vercel antiga (função Node)
  e uma nova (Edge) convivem na mesma pool. Cada uma é classificada sozinha: o Render pergunta
  `GET <vercel>/vidsrc/hls?cap=1` (a nova responde `{"adproxy":"edge"}`) a cada 10 min e usa a cota certa:
  **100 GB** para Edge e **10 GB** para a antiga (`VERCEL_FOT_QUOTA_GB`, padrão 10). Enquanto não sabe, usa 10.
- **Para liberar os 100 GB de uma Vercel antiga:** `bash deploy-vercel.sh` (ou `npx vercel deploy --prod --yes`)
  com o kit novo, na conta dela. A URL não muda; em até 10 min o Render passa a tratá-la como Edge.
- Na página, cada barra mostra `· Edge` ou `· função Node` ao lado do nome.

Existe um segundo limite: **chamadas de função**. Cada segmento é uma chamada (um filme
de 2 h ≈ 1.700). Confira o limite de *Function Invocations* em *Usage*; ele pode apertar
antes da banda.

> **Atalho:** o botão **⚙ Configs** da página mostra a banda total e o tutorial completo, e baixa um kit
> `.zip` (projeto `adproxy` + `deploy-vercel.sh` + `POOL-MANUAL.md`). `PROXY_SECRET` e `TARGET_ORIGIN` vêm
> **embutidas** no código (`adproxy/lib/config.js`): cada conta nova é `npx vercel login` +
> `bash deploy-vercel.sh`, sem configurar variável nenhuma. O passo a passo abaixo é a versão manual.

## Passo a passo: criar cada Vercel extra

Faça isto **uma vez por conta**. O caminho mais confiável é pela linha de comando, porque
o GitHub costuma aceitar ligação com uma conta Vercel só.

1. **Crie a conta** em vercel.com (e-mail diferente para cada uma) e confirme o e-mail.
2. **Entre na conta no terminal** (se já estava logado em outra: `npx vercel logout`):
   ```bash
   cd adproxy
   npx vercel login
   ```
3. **Publique em produção:**
   ```bash
   npx vercel deploy --prod --yes
   ```
   Na primeira vez ele cria o projeto `adproxy` nessa conta. Anote a URL de produção
   (`https://adproxy-xxxx.vercel.app`; use a **de produção**, não a de um deploy específico).
4. **Segredo de assinatura:** nada a fazer. Vem embutido em `adproxy/lib/config.js` (a variável
   `PROXY_SECRET` na Vercel, se existir, manda mais que o embutido).
5. **Deixe o projeto público.** Se o teste devolver uma página HTML pedindo login, vá em
   *Project → Settings → Deployment Protection* e desligue a proteção para produção.
6. **Teste essa Vercel sozinha** (deve ficar tudo 200):
   ```bash
   curl -s "https://adproxy-xxxx.vercel.app/vidsrc/probe?tmdb=603"
   ```

Repita 1–6 para cada conta. **Atualizar o código depois:** rode o passo 3 (`deploy --prod`)
em cada conta (`logout` / `login` entre elas).

## Ligar a pool no Render

Em *Environment* do fdsFlix:

```env
VIDSRC_PROXY_URLS=https://adproxy-aaa.vercel.app,https://adproxy-bbb.vercel.app,https://adproxy-ccc.vercel.app
VERCEL_QUOTA_GB=100
USAGE_RESET_DAY=1
```

- Sem barra no fim, separadas por vírgula (espaço também serve).
- `VERCEL_QUOTA_GB`: a cota de uma Vercel que entrega pelo **Edge** (100 no Hobby). Vercels antigas (função
  Node) usam `VERCEL_FOT_QUOTA_GB` (padrão 10), detectado sozinho por Vercel.
- `USAGE_RESET_DAY`: dia do mês em que a cota renova. Veja em *Usage* na Vercel (o ciclo
  nem sempre começa no dia 1).
- `VIDSRC_PROXY_URL` (uma só) continua funcionando e entra na mesma pool.

Salve, espere o redeploy e confira, **do seu PC**:

```bash
npm run pool:check
# ✅ https://adproxy-aaa.vercel.app  master 200 · variante 200 · segmento 200 ...
# ❌ https://adproxy-bbb.vercel.app  HTTP 404 · falhou em "master" ...
```

`npm run pool:check -- https://a.vercel.app https://b.vercel.app` testa URLs avulsas antes de
colocá-las no Render. Exit code 1 se alguma falhar.

## Misturar outros provedores (Wasmer, etc.) na mesma pool

O mesmo kit `adproxy` (Express, `node server.js`) roda fora da Vercel. Esses provedores entram em
`VIDSRC_PROXY_URLS` junto com as Vercels, e a cota deles vai em **`VIDSRC_PROXY_QUOTAS`**:

```env
VIDSRC_PROXY_URLS=https://adproxy-aaa.vercel.app,https://adproxy-bbb.vercel.app,https://node-base-12ae3.wasmer.app
VIDSRC_PROXY_QUOTAS=https://node-base-12ae3.wasmer.app=150
```

- Formato: `URL=GB`, separados por vírgula, espaço ou `;`. Para **cada provedor novo**, some a URL em
  `VIDSRC_PROXY_URLS` e uma entrada em `VIDSRC_PROXY_QUOTAS`:
  `...app=150,https://outro.exemplo.dev=20`.
- Quem aparece em `VIDSRC_PROXY_QUOTAS` usa a cota informada (pode passar de `VERCEL_QUOTA_GB`) e **não** é
  classificado como Edge/função Node (isso só existe na Vercel). Na barra aparece `· cota fixa`.
- Quem **não** aparece continua como antes: Vercel Edge = `VERCEL_QUOTA_GB`, Vercel antiga = `VERCEL_FOT_QUOTA_GB`.
  Sem a variável, nada muda.
- URL sem `http(s)://`, GB inválido ou zero são ignorados em silêncio. Maiúscula e `/` no fim não importam.
- A escolha e o fallback são os mesmos: vence quem tem **mais cota sobrando** e, se falhar, tenta a próxima.
- `USAGE_RESET_DAY` é um só para todos. Se o ciclo do provedor renova em outro dia, o número da barra fica
  aproximado; acerte com `/api/usage/calibrate`.
- Valores de referência (conferir no painel do provedor): Wasmer Hobby = 150 GB/mês, 1 M requisições,
  6 h de CPU ativa, "uso pessoal e não comercial". Não confirmei se pede cartão nem o que acontece ao estourar.

## A barra de consumo

Abaixo do player aparece **"📶 Consumo das Vercels (cota mensal)"**, uma barra por Vercel e
uma **TOTAL** quando há mais de uma:

- **Azul / amarela (≥ 60 %) / vermelha (≥ 85 %)**: quanto da cota do ciclo já foi usado.
- **Verde**: a parte que **esta sessão** (esta aba) gastou.
- Texto: `usado / cota`, **quanto resta**, **quantas horas de vídeo ainda cabem** na média
  medida (GB por hora assistida; "estimada" em 2,2 GB/h até haver 10 min de dados) e o
  ritmo em GB/dia do ciclo.
- Rodapé: **quantos dias faltam para renovar**.

O botão **"Testar Vidsrc/Vercel"** do painel de diagnóstico testa todas as Vercels da pool
a partir do servidor e mostra o IP de saída e cada etapa.

### Histórico no Supabase (médias, previsão, sobrevive a reinício)

Sem Supabase o contador fica no disco do Render e some quando ele reinicia. Com o Supabase cada dia
e cada Vercel viram **uma linha** (`vercel_usage_daily`, ~30 linhas por Vercel por mês), e a página
passa a mostrar média por dia, ritmo dos últimos 7 dias, **previsão até a renovação**, quando a cota
esgota e quantas Vercels a mais o ritmo atual pede, mais um gráfico de 30 dias e CSV.

1. Supabase → *SQL Editor* → cole `supabase/usage-schema.sql` → *Run* (idempotente; o botão **Configs** copia o SQL).
2. No Render: `SUPABASE_URL` e `SUPABASE_SECRET_KEY` (a secret key só no servidor, nunca no git/página).
3. **Configs → Histórico → ⟳ Sincronizar agora**: o selo fica verde.

Como funciona por dentro: o servidor soma em memória e envia em lote (soma atômica por dia/Vercel, a
cada ~20 s quando há consumo); relê o banco a cada 10 min. Se o Supabase cair ou a tabela não existir,
nada se perde: as somas ficam na fila (e no arquivo local) e sobem quando voltar. A renovação da cota
**não zera nada**: o ciclo é uma janela de dias sobre o histórico, e a calibração grava só a diferença
como ajuste (`adjust_bytes`), então não distorce as médias (que usam só `measured_bytes`).

### Isto é uma estimativa. Calibre de vez em quando

Quem mede é o navegador (hls.js informa os bytes a cada 20 s e ao fechar a aba). Por isso:

- Quem fecha o navegador sem enviar perde alguns segundos de contagem.
- Se o Render reiniciar, o contador pode zerar (no plano gratuito o disco é apagado). Resolva com o
  Supabase (seção abaixo) ou um disco persistente do Render e `USAGE_FILE=/data/usage.json`.
- **A fonte da verdade é a Vercel** (*Usage → Fast Data Transfer*). Para acertar o contador:

```bash
# exige API_KEY definida no Render
curl -X POST https://SEU-FDSFLIX.onrender.com/api/usage/calibrate \
  -H "x-api-key: SUA_API_KEY" -H "Content-Type: application/json" \
  -d '{"base":"https://adproxy-aaa.vercel.app","usedGb":37.5}'
```

Dá para ver o JSON cru em `GET /api/usage`.

## Problemas comuns

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| `pool:check` mostra 404 "deployment not found" | URL errada ou projeto apagado | Copie a URL de produção do painel da Vercel |
| Probe devolve HTML de login / 401 | Deployment Protection ligada | Desligue para produção (passo 5) |
| `403 URL não assinada pelo proxy` ao tocar | `PROXY_SECRET` mudou entre deploys, com o player aberto | Recarregue o título; defina `PROXY_SECRET` fixo |
| Barra não anda | O servidor não recebe `/api/usage` | Veja se o Render roda o commit novo (painel mostra o `build`) |
| Barra diverge da Vercel | Estimativa | Calibre (acima) |
| Uma Vercel nunca é escolhida | Está ≥ 98 % ou falhando | Veja o trace no painel; rode `pool:check` |
| Todas esgotadas (≥ 98 %) | Cota do mês acabou | O fdsFlix ainda tenta as esgotadas por último (a estimativa pode estar alta: calibre). Se a Vercel realmente recusar/pausar o projeto, a requisição falha e a cascata segue para o VidLink. Espere a renovação ou adicione contas |
| Site dá 503 com a pool toda fora por ~1 min | Sem fonte entregável fora do Render (VidLink Pro é pulado) | Publique o **AdShield de fallback** (abaixo): o filme toca por um nó separado em vez de dar 503 |

## Quando a pool inteira cai

A pool é o único caminho de vídeo que não gasta a banda do Render. Se **todos** os nós falham ao
mesmo tempo (Vidsrc instável, 429/403 nos IPs das VMs, deploy no meio), a cascata não tem plano B:
o VidLink Pro e as outras fontes acham o filme, mas entregá-las passaria os bytes pelo Render, que
é bloqueado de propósito.

Para esse caso existe um **segundo AdShield** (nó separado, `MEDIA_PROXY=1`) que entrega a mídia
dessas outras fontes. Ele não entra no rodízio e só é chamado quando todo o resto falhou:

```env
# Render
ADSHIELD_FALLBACK_URLS=https://adfallback-a.vercel.app,https://adfallback-b.wasmer.app
ADSHIELD_FALLBACK_KEY=a-mesma-MEDIA_PROXY_KEY-do-nó
```

É um **rodízio** próprio: cada nó tem a própria cota (`ADSHIELD_FALLBACK_QUOTA_GB`, padrão 100;
`ADSHIELD_FALLBACK_QUOTAS=URL=GB` para Wasmer) e o filme inteiro sai de um nó só. O kit `.zip`
sai pronto no painel Configs → “2b · AdFallback”. Passo a passo e teste:
[adproxy/VERCEL.md](../adproxy/VERCEL.md#segundo-projeto-adfallback-rodízio-de-nós).
Ele não substitui a pool (não extrai Vidsrc e não soma cota do pool): é a rede de segurança para
o site não cair junto com ela.


## Voltar ao que era

Apague `VIDSRC_PROXY_URLS` e `VIDSRC_PROXY_URL` no Render. A cascata volta a começar pelo
VidLink e as barras somem sozinhas (não há pool configurada).

## Legendas

O Vidsrc quase nunca envia legendas. Quando não vêm, o servidor pega **só as legendas** do
VidLink Pro para o mesmo título (nenhum vídeo é baixado de lá). Se nem o VidLink tiver, o
painel mostra `legendas: 0 (nenhuma fonte tem para este título)`.
