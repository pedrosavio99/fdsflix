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
- `GET /prepare/<infoHash>?magnet=<magnet>` → espera os metadados (até 45 s) e devolve **sempre HTTP 200**
  com `{ ready, name, size, remux, wires, reason }`. O fdsFlix chama antes de tocar: se `ready:false`, o
  `reason` diz o motivo real (sem peers, sem vídeo…). Sem isso o `<video>` só mostra "Format error".
- `GET /status/<infoHash>?magnet=<magnet>` → instantâneo: `{ ready, wires, speedKBs, downloadedMB, warm }`. O fdsFlix
  consulta a cada 2 s e só monta o `<video>` quando `warm.done` (começo + `moov` baixados), mostrando o progresso no log.
- `GET /diag` → testa DNS, TCP e **UDP de saída** do nó e diz se só os trackers HTTP valem.
- `GET /stream/<infoHash>?magnet=<magnet>` → vídeo (Range/206). `.mkv`/`.avi` saem como MP4 fragmentado
  (vídeo copiado, áudio → AAC), sem Content-Length e sem Range (não dá para avançar no tempo).

## Se der "Format error" / "sem peers"

1. Abra `<url-do-nó>/diag`. `udp_tracker_*: ok:false` = a plataforma bloqueia UDP; o nó já soma trackers
   HTTP(S) ao magnet, então ainda deve achar peers por TCP (só peers que aceitam TCP).
2. `<url-do-nó>/health` mostra `wires` (peers conectados) por torrent. `0` por minutos = ninguém respondeu.
3. Torrent com poucos seeds (ou só peers WebRTC) pode não abrir; escolha outro resultado.

## Limites do free (SnapDeploy)

- **4 containers por conta**, 512 MB / **0,25 vCPU** cada.
- **100 container-horas/mês** somadas; dorme após **15 min** sem tráfego e acorda na visita (~60 s).
- **10 deploys/dia**; tarball até **2 GB**; sem disco persistente; sem WebSocket no free.
- Sem cartão, sem expiração.

## Cache

`/tmp/fdsflix-torrent` (some ao dormir/redeploy). `MAX_ENGINES` (padrão 4) e `IDLE_MS` (padrão 20 min).

## Velocidade (o que o nó faz sozinho)

- **Mais peers:** sem UDP/DHT só os trackers HTTP entregam peers. O nó pede 200 peers a vários deles, conecta
  todos (`engine.connect`) e repete aos 8/20/45/90 s enquanto houver menos de 40 conectados. Medido só-TCP: ~10 peers, 0,5–1 MB/s.
- **Aquecimento:** lê as caixas do MP4 para achar o `moov`. No começo (YIFY é assim) já vem junto com os primeiros 6 MB;
  no fim (MP4 comum), baixa só esse trecho. Depois o Chrome lê do disco do nó (início em ~40 ms).
- `TCP_ONLY=1` simula plataforma sem UDP (teste local); `HEAD_BYTES` muda o tanto de começo aquecido (padrão 6 MB).
