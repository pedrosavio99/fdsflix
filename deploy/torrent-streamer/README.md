# fdsFlix · torrent streamer (SnapDeploy free)

Nó que baixa o torrent e serve o vídeo por HTTP (Range). O navegador toca num `<video>` normal —
funciona em **qualquer** navegador, sem WebRTC.

## Deploy no SnapDeploy (free, sem cartão)

1. Crie a conta em https://snapdeploy.dev/register (e-mail ou GitHub).
2. Monte a imagem para **ARM64** (o SnapDeploy roda em Graviton):

```bash
docker buildx create --use
docker buildx build --platform linux/arm64 -t fdsflix-torrent-streamer . --load
docker save fdsflix-torrent-streamer -o fdsflix-torrent-streamer.tar
```

3. SnapDeploy → **Deploy a Container** → fonte **tarball** → suba o `.tar`.
4. **Porta 8080**, health check `/ping`, plano **Free**.
5. Copie a URL (`https://….containers.snapdeploy.app`) e cole no campo **URLs dos nós** do fdsFlix
   (uma por linha; até 4 nós na mesma conta).

## Rotas

- `GET /ping` → `ok` (o fdsFlix usa para acordar o nó)
- `GET /health` → `{ engines, uptime }`
- `GET /stream/<infoHash>?magnet=<magnet>` → vídeo (Range/206)

## Limites do free (SnapDeploy)

- **4 containers por conta**, 512 MB / **0,25 vCPU** cada.
- **100 container-horas/mês** somadas; dorme após **15 min** sem tráfego e acorda na visita (~60 s).
- **10 deploys/dia**; tarball até **2 GB**; sem disco persistente; sem WebSocket no free.
- Sem cartão, sem expiração.

## Cache

`/tmp/fdsflix-torrent` (some ao dormir/redeploy). `MAX_ENGINES` (padrão 4) e `IDLE_MS` (padrão 20 min).
