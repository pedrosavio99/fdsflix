# Relay de mídia (Node) — tira o vídeo da banda do Render

**Problema:** o Render Free só inclui **5 GB/mês** de saída ([docs](https://render.com/docs/outbound-bandwidth)) e o
CDN do provedor de vídeo recusa a rede da Cloudflare (o Worker recebe HTTP 427). Resultado: os bytes do filme
saem pelo Render.

**Solução:** o Render continua achando o filme e só **assina um token** (~1 KB). Quem baixa do CDN e entrega ao
player é este relay, numa VM com muita banda (Oracle Cloud Always Free: ~10 TB/mês de saída). Ele roda o **mesmo
código do Worker** (`../cloudflare-worker/worker.js`), então o protocolo é idêntico.

O player continua decodificando no navegador. Isso não muda.

## Avisos honestos

- **Não está provado que o CDN aceita o IP da Oracle.** O servidor testa com 1 byte antes de usar o relay; se o
  CDN recusar, o vídeo volta a sair pelo Render e a faixa de status mostra o motivo.
- A Oracle pode recuperar VMs ociosas (CPU baixa por 7 dias) e há relatos de contas encerradas sem explicação.
  Veja as regras atuais no console deles.
- **Não use Cloudflare Tunnel/Worker para vídeo no plano grátis:** a [política da Cloudflare](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)
  restringe isso.

## Passo a passo (VM Ubuntu da Oracle)

Siga `docs/DEPLOY-ORACLE.md` até criar a VM e liberar as portas 80/443 (Security List). Depois:

```bash
# Node 20 + Caddy (HTTPS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs git caddy
git clone <seu-repo> ~/fdsflix && cd ~/fdsflix

# serviço (troque a chave por uma sua, longa e aleatória)
sudo tee /etc/systemd/system/fdsflix-relay.service >/dev/null <<UNIT
[Unit]
Description=fdsFlix media relay
After=network.target
[Service]
WorkingDirectory=$HOME/fdsflix/deploy/media-relay
Environment=RELAY_KEY=TROQUE_ESTA_CHAVE
ExecStart=/usr/bin/node server.mjs
Restart=always
User=$USER
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl enable --now fdsflix-relay

# HTTPS (domínio DuckDNS apontando para a VM)
printf 'relay.SEU-DOMINIO.duckdns.org {\n\treverse_proxy 127.0.0.1:8787\n}\n' | sudo tee /etc/caddy/Caddyfile
sudo systemctl restart caddy
curl https://relay.SEU-DOMINIO.duckdns.org/      # deve responder {"ok":true,...,"keyConfigured":true}
```

## No Render (Environment)

```
MEDIA_RELAY_URL=https://relay.SEU-DOMINIO.duckdns.org
MEDIA_RELAY_KEY=TROQUE_ESTA_CHAVE        # igual ao RELAY_KEY da VM
```

`VIDEO_RELAY_URL`/`VIDEO_RELAY_KEY` (Worker) ficam como estão: continuam servindo as consultas aos provedores.

## Como saber se funcionou

Abra um filme. A faixa de status diz, em uma linha, por onde o vídeo chega:

- `📡 O vídeo chega por um relay externo (Cloudflare ou sua VM) — não gasta a banda do Render`
- `📡 O vídeo chega pelo Render ... (provedor HTTP 427)` — o relay não alcança o CDN; me mande essa linha.
