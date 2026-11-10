# Deploy do backend no Render + frontend na Vercel

Caminho mais simples: **Vercel** serve o frontend estático e o **Render** roda o
Node + ffmpeg. O repositório já tem tudo pronto (`Dockerfile`, `render.yaml`,
`compose.yaml`, `vercel.json`).

> **Aviso honesto sobre o Render Free:** o plano gratuito é **0.1 CPU / 512 MB**
> ([specs](https://render.com/docs/compute-plans)). Ele roda o app, mas a
> conversão HEVC → H.264 em tempo real **provavelmente não acompanha**. O
> `render.yaml` já configura `MAX_TRANSCODE_HEIGHT=360` e `MAX_SESSIONS=1` para
> tentar. Se engasgar, as saídas são:
> - **o navegador de quem assiste decodifica o HEVC sozinho** (player canvas,
>   `public/cv/`, em WebAssembly): funciona em qualquer navegador moderno, sem
>   ffmpeg e sem o vídeo passar pelo Render — o servidor só entrega o endereço.
>   Para os bytes também não passarem pelo Render, configure o Worker da Cloudflare
>   (`deploy/cloudflare-worker/README.md`, variáveis `VIDEO_RELAY_URL`/`VIDEO_RELAY_KEY`).
>   O ffmpeg do servidor só entra se o aparelho for lento demais (cai para 360p e,
>   se ainda assim não acompanhar, usa o servidor). `?hevc=wasm` na URL força o
>   player canvas, mesmo em navegadores que tocam HEVC (útil para testar);
> - usar um navegador que toca HEVC (Safari ou Chrome no Windows com o codec) —
>   aí o backend só faz proxy, sem converter;
> - subir para **Starter (0.5 CPU)** ou **Standard (1 CPU / 2 GB)**;
> - trocar por Railway/Fly.io/VPS.

## 1. Subir o código no GitHub

O Render precisa do repositório no GitHub/GitLab. Confirme que `.env` **não** foi
commitado (`git status`) e que existe um `.env.example`.

## 2. Criar o serviço no Render (Blueprint, mais fácil)

1. Entre em <https://dashboard.render.com> e conecte sua conta do GitHub.
2. **New → Blueprint**.
3. Selecione o repositório do fdsFlix.
4. O Render vai ler o `render.yaml` e pedir as variáveis marcadas com
   `sync: false`:

| Variável | Valor |
| :--- | :--- |
| `TMDB_API_KEY` | sua chave do TMDB |
| `VIDLINK_KEY_HEX` | sua chave do VidLink |

5. Clique em **Apply / Create**. O primeiro build baixa a imagem Node e instala o
   ffmpeg — leva alguns minutos.
6. Quando o status virar **Live**, copie a URL:
   `https://fdsflix-xxxx.onrender.com`.

### Alternativa: criar manualmente (sem Blueprint)

**New → Web Service** → conecte o repositório:

| Campo | Valor |
| :--- | :--- |
| Language / Runtime | **Docker** |
| Plan | **Free** |
| Region | a mais próxima (ex.: Oregon) |
| Dockerfile Path | `./Dockerfile` |
| Health Check Path | `/api/health` |

Em **Environment**, adicione:

| Nome | Valor |
| :--- | :--- |
| `TMDB_API_KEY` | sua chave |
| `VIDLINK_KEY_HEX` | sua chave |
| `VIDLINK_API_URL` | `https://vidlink.pro/api/b` |
| `MAX_TRANSCODE_HEIGHT` | `360` |
| `MAX_SESSIONS` | `1` |
| `NODE_ENV` | `production` |

`PUBLIC_BASE_URL` **não é necessária**: o app usa o `RENDER_EXTERNAL_URL`
automático do Render.

## 3. Testar o backend

```bash
curl https://fdsflix-xxxx.onrender.com/api/health
```

Esperado:

```json
{ "ok": true, "ffmpeg": true, "tmdb": true, "sessions": [] }
```

Se demorar ~1 min na primeira chamada, é o cold start do Free (o app avisa na
tela quando o frontend está apontando para ele).

Teste também o stream:

```bash
curl "https://fdsflix-xxxx.onrender.com/api/stream?id=603&type=movie&res=360&hevc=0"
```

## 4. Apontar a Vercel para o Render

Na Vercel, **Settings → Environment Variables**:

| Nome | Valor |
| :--- | :--- |
| `API_BASE_URL` | `https://fdsflix-xxxx.onrender.com` |
| `API_KEY` | (só se você ativou no Render) |

Depois **Deployments → Redeploy**. O `vercel.json` gera o
`public/config.js` com essa URL no build.

Abra o site da Vercel e pronto — o aviso de "Acordando o servidor" aparece
quando o Render estiver dormindo.

## 5. Ajustes e manutenção

- **Atualizar o código:** `git push` → Render redeploya sozinho (`autoDeploy`).
- **Logs:** dashboard do Render → **Logs** (ou `docker logs` se rodar local).
- **Mudar a qualidade:** `MAX_TRANSCODE_HEIGHT` (`240`, `360`, `480`, `720`).
  Menor = menos CPU.
- **Concorrência:** `MAX_SESSIONS` (1 no Free; 2+ em planos maiores).
- **Plano:** Settings → Instance Type. Starter = 0.5 CPU; Standard = 1 CPU/2 GB.

## 6. Limitações do Render Free

| Limite | Valor |
| :--- | :--- |
| CPU / RAM | 0.1 CPU / 512 MB |
| Spin down por inatividade | ~15 min |
| Cold start | ~50 s–1 min |
| Disco | efêmero (o `.tmp-hls` some ao reiniciar) |
| Largura de banda | 100 GB/mês |

O disco efêmero não é problema: o `.tmp-hls` é temporário por natureza e as
sessões são recriadas a cada play.

## 7. Troubleshooting

| Sintoma | Causa / solução |
| :--- | :--- |
| Build falha no Render | veja os logs; o `Dockerfile` instala `ffmpeg` via apt |
| 502 / "service unavailable" | app não subiu; veja os logs e confirme `PORT` (o Render injeta) |
| Health check falhando | `/api/health` precisa responder 200; teste a URL pública |
| Vídeo engasga | CPU do Free; use `MAX_TRANSCODE_HEIGHT=240/360`, feche outras abas, ou faça upgrade |
| Primeira requisição lenta | cold start do Free (~1 min) — normal |
| Legenda não aparece | precisa de HTTPS e CORS (já configurados); veja o console do navegador |
| API devolve URL `http://` | defina `PUBLIC_BASE_URL=https://...` (ou confie no `RENDER_EXTERNAL_URL`) |

## Checklist

- [ ] repositório no GitHub sem `.env`
- [ ] Blueprint criado no Render com as duas chaves
- [ ] `/api/health` → `ffmpeg: true`
- [ ] Vercel com `API_BASE_URL` do Render + redeploy
- [ ] vídeo tocando (480p/360p no Chrome; direto no Safari/Windows)
