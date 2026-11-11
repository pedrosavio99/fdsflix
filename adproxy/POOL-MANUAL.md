# Manual: Vercel extra para o pool do fdsFlix

> O mesmo tutorial está na página do fdsFlix, no botão **⚙ Configs** (ou no cantinho de banda do topo).

Cada conta Vercel (plano Hobby) tem a própria cota de transferência (~100 GB/mês).
Este kit é o projeto `adproxy` pronto para subir em **mais uma conta**: cada Vercel
nova entra no pool do fdsFlix e soma outra cota.

**Resumo de tudo:** suba o projeto em cada conta Vercel, copie a URL de produção de cada uma
e cole todas em `VIDSRC_PROXY_URLS` no Render. Não há variável nenhuma para configurar nas Vercels.

> **Aviso (leia):** o plano Hobby é de uso pessoal e não comercial. Abrir várias contas
> só para acumular cota pode ferir os termos da Vercel e levar à suspensão das contas.
> A decisão e o risco são seus.

## Como o pool escolhe a Vercel

Não é sorteio: para cada filme/episódio o fdsFlix ordena as Vercels da que tem **mais cota
sobrando** para a mais cheia e usa a primeira (sorteia só no empate). Se ela falhar, tenta a
próxima (até 3). Quem passou de 98 % vai para o fim da fila. Um filme inteiro sai de uma Vercel só.
Isso reparte a banda por igual, melhor que um sorteio puro.

## Nenhuma variável de ambiente nas Vercels

`PROXY_SECRET` e `TARGET_ORIGIN` estão **embutidas no código** (`lib/config.js`):

| Valor | Para quê |
| --- | --- |
| `TARGET_ORIGIN` = `https://vidlink.pro` | Site que o modo AdShield proxia (só a rota `/`). O pool de vídeo (`/vidsrc/*`) nem usa |
| `PROXY_SECRET` (64 hex, em `lib/config.js`) | Assina as URLs de vídeo que a Vercel emite |

- O mesmo valor vale em todas as contas, então nada a guardar nem a configurar.
- O segredo é público por decisão do dono: quem o souber consegue assinar URLs e usar a Vercel como
  proxy. Para trocar, defina `PROXY_SECRET` nas variáveis da Vercel (a variável manda mais que o
  embutido) ou mude `BUILTIN_PROXY_SECRET` em `lib/config.js` e publique de novo.
  Trocar o segredo só obriga a recarregar um filme que estava tocando.

## O que tem no zip

| Arquivo | Para quê |
| --- | --- |
| `deploy-vercel.sh` | Faz tudo na conta logada: cria o projeto e publica em produção |
| `lib/config.js` | Onde estão as duas variáveis embutidas |
| `api/`, `lib/`, `vercel.json`, `package.json` | O projeto |
| `POOL-MANUAL.md` | Este manual |

## Passo a passo (uma conta por vez)

Requisitos: Node 20+ e uma conta Vercel nova (e-mail diferente, e-mail confirmado).

```bash
unzip fdsflix-vercel-kit.zip
cd adproxy-kit

npx vercel logout          # se estava logado em outra conta
npx vercel login           # entra na conta DESTA vez
bash deploy-vercel.sh      # cria o projeto e publica em produção
```

Anote a **URL de produção** (`https://adproxy-kit.vercel.app` ou parecida; *Project → Domains*).
Use a curta do projeto, não a de um deploy avulso (com hash).

Teste essa Vercel sozinha:

```bash
curl -s "https://SEU-DOMINIO.vercel.app/vidsrc/probe?tmdb=603"
```

Se vier uma página HTML de login: *Project → Settings → Deployment Protection* e desligue
para **Production**.

Sem o script: dentro da pasta, `npx vercel link --yes` e depois `npx vercel deploy --prod --yes`.
(A ligação GitHub↔Vercel costuma aceitar uma conta só; por isso o caminho é pela linha de comando.)

## Ligar no fdsFlix (Render): as URLs novas

Em *Environment* do fdsFlix, a variável **`VIDSRC_PROXY_URLS`** recebe todas as URLs de produção,
separadas por vírgula, sem barra no fim:

```env
VIDSRC_PROXY_URLS=https://adproxy-kit.vercel.app,https://adproxy-kit-bbb.vercel.app,https://adproxy-kit-ccc.vercel.app
VERCEL_QUOTA_GB=100
USAGE_RESET_DAY=1
```

- Cada Vercel nova: **acrescente a URL dela no fim** da lista e salve (o Render faz redeploy).
- `VERCEL_QUOTA_GB` é a cota **de cada** Vercel. `USAGE_RESET_DAY` é o dia em que a cota
  renova (veja em *Usage* na Vercel).
- O botão **⚙ Configs** da página tem um campo que monta essa linha pronta a partir das URLs.
- Depois do redeploy, do seu PC (no repositório do fdsFlix): `npm run pool:check`.

## A banda é estimativa: como acertar

O cantinho de banda do topo é medido pelos navegadores. A fonte da verdade é a Vercel
(*Usage → Fast Data Transfer*). No **⚙ Configs → seção "A banda é estimativa"**, escolha a Vercel
e digite os GB que a Vercel mostra (exige `API_KEY` definida no Render).

## Atualizar o código depois

Baixe um kit novo e rode `bash deploy-vercel.sh` em cada conta (`logout`/`login` entre elas).

## Problemas comuns

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| `deployment not found` / 404 | URL errada ou projeto apagado | Copie a URL de produção em *Domains* |
| Probe devolve HTML de login / 401 | Deployment Protection ligada | Desligue para Production |
| `403 URL não assinada pelo proxy` | `PROXY_SECRET` mudou com o player aberto | Recarregue o título |
| Script falha em `link`/`deploy` | CLI antiga ou não logado | `npx vercel@latest login` e rode de novo |
| Uma Vercel nunca é escolhida | Está ≥ 98 % ou falhando | Veja o painel de diagnóstico e rode `pool:check` |
| Falta de função antes da banda | Limite de *Function Invocations* | Cada segmento é uma chamada (~1.700 por filme de 2 h): confira em *Usage* |
