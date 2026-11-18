# fdsFlix · torrent streamer (Koyeb free)

Nó que baixa o torrent e serve o vídeo por HTTP (Range). O navegador toca num `<video>` normal —
funciona em **qualquer** navegador, sem WebRTC.

## Deploy no Koyeb (free)

1. Crie a conta em https://app.koyeb.com/auth/signup (e-mail, Google ou GitHub).
2. **Create Service → Docker / GitHub** e suba esta pasta (ou o repositório com ela).
3. O Koyeb detecta o `Dockerfile`; mantenha a porta **8080**.
4. Depois do deploy, copie a URL pública (`https://SEU-APP.koyeb.app`).
5. No fdsFlix, Admin → Outras fontes → Torrents, cole a URL no campo do nó e use “tocar aqui”.

## Rotas

- `GET /ping` → `ok` (o fdsFlix usa para acordar o nó)
- `GET /health` → `{ engines, uptime }`
- `GET /stream/<infoHash>?magnet=<magnet>` → vídeo (Range/206)

## Limites do free

- 512 MB RAM / 0,1 vCPU / 2 GB SSD; dorme após 1 h ocioso.
- Cache em `/tmp` (some ao reiniciar); `MAX_ENGINES` (padrão 4) e `IDLE_MS` (padrão 20 min) controlam.
- 100 GB/mês de saída (~60 filmes 720p).
