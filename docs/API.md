# fdsFlix API

API HTTP para buscar filmes/séries (TMDB) e obter uma URL de vídeo pronta para
tocar (HLS em H.264 ou arquivo direto).

- **Base:** `https://SEU-BACKEND` (Render/Railway/Fly/VPS)
- **Produção atual:** <https://fdsflix.onrender.com> (interface + API no mesmo host)
- **CORS:** liberado (`Access-Control-Allow-Origin: *`)
- **Formato:** JSON
- **Autenticação:** opcional — se o backend tiver `API_KEY`, envie
  `x-api-key: SUA_CHAVE` (ou `?key=SUA_CHAVE`) em `/api/search`, `/api/popular`
  e `/api/stream`. As URLs de mídia usam tokens aleatórios e não exigem a chave.

> Documentação viva: `GET /api` devolve a lista de endpoints com exemplos já
> com a URL base correta.

## Endpoints

### `GET /api/health`

Status do servidor. Bom para "acordar" o Render.

```json
{ "ok": true, "ffmpeg": true, "tmdb": true, "sessions": [] }
```

### `GET /api/popular`

Títulos em alta (cache de 30 min).

```json
{
  "results": [
    { "id": 603, "title": "Matrix", "year": "1999", "type": "movie", "poster": "/lDqMDI3xpbB9UQRyeXfei0MXhqb.jpg", "overview": "..." }
  ]
}
```

### `GET /api/search?q=matrix`

Busca no TMDB (filmes e séries).

```json
{
  "results": [
    { "id": 603, "title": "Matrix", "year": "1999", "type": "movie", "poster": "/lDqMDI3xpbB9UQRyeXfei0MXhqb.jpg", "overview": "..." }
  ]
}
```

### `GET /api/stream`

Resolve o vídeo e devolve uma **URL absoluta** pronta para tocar.

| Parâmetro | Obrigatório | Descrição |
| :--- | :--- | :--- |
| `id` | sim | ID do TMDB |
| `type` | sim | `movie` ou `tv` |
| `s` / `e` | para séries | temporada / episódio (padrão 1) |
| `res` | não | `360`, `480`, `720`, `1080` ou vazio (auto) |
| `hevc` | não | `1` se o cliente toca HEVC nativo; `0`/vazio força H.264 |
| `start` | não | segundo inicial (ex.: `600` = 10 min) |

**Resposta no modo `hls`** (quando precisa transcodificar):

```json
{
  "mode": "hls",
  "url": "https://SEU-BACKEND/hls/7acb5f2618c0fc85/index.m3u8",
  "sessionId": "7acb5f2618c0fc85",
  "quality": 480,
  "codec": "h264",
  "sourceCodec": "hevc",
  "transcoded": true,
  "provider": "VidLink Pro",
  "captions": [
    { "label": "Português", "srclang": "pt", "default": true, "url": "https://SEU-BACKEND/api/subtitle?t=..." }
  ],
  "note": "O provedor entrega HEVC e seu navegador não decodifica..."
}
```

**Resposta no modo `direct`** (cliente toca HEVC ou a fonte já é H.264):

```json
{
  "mode": "direct",
  "url": "https://SEU-BACKEND/api/proxy?t=snCV46u735EHthgp1Gq3_Gvo",
  "quality": 1080,
  "codec": "h264",
  "transcoded": false,
  "captions": []
}
```

Reprodução:

- `mode: "hls"` → use o `hls.js` (ou Safari nativo) com `url`.
- `mode: "direct"` → `<video src="url">`.

## Exemplos

### curl

```bash
curl "https://SEU-BACKEND/api/stream?id=603&type=movie&res=480&hevc=0"
```

### JavaScript (navegador ou Node 18+)

```js
const API = 'https://SEU-BACKEND';
const headers = { 'x-api-key': 'SUA_CHAVE' }; // só se API_KEY estiver definida

const res = await fetch(`${API}/api/stream?id=603&type=movie&res=480&hevc=0`, { headers });
const data = await res.json();

console.log(data.mode, data.url); // ex.: hls https://.../index.m3u8
```

### Player com hls.js

```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<video id="v" controls></video>
<script>
  const API = 'https://SEU-BACKEND';

  async function play(id) {
    const res = await fetch(`${API}/api/stream?id=${id}&type=movie&res=480&hevc=0`);
    const data = await res.json();
    const video = document.getElementById('v');

    if (data.mode === 'hls' && window.Hls && Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(data.url);
      hls.attachMedia(video);
    } else {
      video.src = data.url; // modo direct
    }
    video.play();
  }

  play(603);
</script>
```

### Legenda

```js
const pt = data.captions.find((c) => c.srclang === 'pt');
const track = document.createElement('track');
track.kind = 'subtitles';
track.label = pt.label;
track.srclang = pt.srclang;
track.src = pt.url; // já é WebVTT
video.appendChild(track);
```

> Para faixas `<track>` de outra origem, o `<video>` precisa de
> `crossorigin="anonymous"` (o backend já responde com CORS).

## Observações

- **HEVC:** o provedor entrega HEVC. Navegadores que não decodificam precisam
  de `hevc=0` (transcodificação H.264, mais CPU e alguns segundos de espera).
- **Sessões HLS:** cada `/api/stream` no modo `hls` cria uma sessão; ela é
  encerrada após 5 min sem requisições. Não reaproveite a URL depois disso.
- **Render Free:** 0.1 CPU / 512 MB — o cold start leva ~1 min e a
  transcodificação pode não acompanhar em tempo real. Para uso sério, use um
  plano com pelo menos 1 CPU ou outro host (Railway/Fly/VPS).
- **Abuso:** esta API faz proxy de vídeo e inicia ffmpeg. Se for divulgar,
  defina `API_KEY` e/ou coloque um rate limit na frente (Cloudflare, etc.).

## Ajuste de sincronia da legenda

A URL devolvida em `captions[].url` já inclui o deslocamento automático quando
`start` é usado (o vídeo começa em 0, mas a legenda é do arquivo original).

Para ajuste manual, acrescente `&shift=` em segundos (positivo = legenda mais
tarde, negativo = mais cedo):

```bash
curl "https://fdsflix.onrender.com/api/subtitle?t=TOKEN&shift=1.5"
```

O player faz isso pela barra **Sincronia da legenda** e salva o valor por título
no `localStorage`. O ajuste vale para todas as línguas daquele título.
