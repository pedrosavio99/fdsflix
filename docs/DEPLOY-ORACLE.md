# Deploy do backend na Oracle Cloud Always Free (ARM / Ampere A1)

Guia para hospedar **o backend Node + ffmpeg** de graça na Oracle Cloud e apontar
a Vercel para ele.

> **Atualização importante (2026):** o Always Free da Oracle **não são mais
> 4 OCPUs / 24 GB**. A documentação oficial agora dá **1.500 OCPU-horas + 9.000
> GB-horas por mês**, o que equivale a **2 OCPUs e 12 GB de RAM** rodando 24/7
> ([docs oficiais](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)).
> Ainda é de longe a melhor VM gratuita que existe — e dá conta do ffmpeg em
> 480p.

## O que você ganha

| Recurso | Always Free |
| :--- | :--- |
| VM ARM (A1 Flex) | **2 OCPUs + 12 GB** (1 VM, ou 2 de 1 OCPU) |
| 2 VMs AMD micro | 1/8 OCPU, 1 GB cada |
| Disco | 200 GB no total (boot de 50 GB por padrão) |
| Tráfego de saída | 10 TB/mês |
| Load balancer | 1 flexível, 10 Mbps |

Para o fdsFlix: a VM ARM de 2 núcleos roda o Docker, o Node e o `ffmpeg` em
480p tranquilamente. O tráfego de vídeo (480p ≈ 1,5 GB por filme de 2 h) cabe
muito bem nos 10 TB.

## 1. Criar a conta

1. Acesse <https://cloud.oracle.com> e clique em **Sign Up**.
2. Escolha a **home region** com cuidado: ela é **permanente** e os recursos
   Always Free só existem nela. No Brasil, `Brazil East (São Paulo)` ou
   `Brazil Southeast (Vinhedo)`.
3. Use dados reais (nome igual ao do cartão, endereço real), **sem VPN** e com
   e-mail não descartável. O cartão é só para verificação de identidade — o
   Always Free não cobra.
4. A conta pode levar de minutos a algumas horas para ser provisionada.

> Se o cadastro for recusado, não fique tentando em sequência: espere e tente de
> novo com outro navegador/rede. A Oracle não explica o motivo.

## 2. Gerar a chave SSH (se ainda não tem)

No seu PC:

```bash
ssh-keygen -t ed25519 -C "fdsflix" -f ~/.ssh/fdsflix
cat ~/.ssh/fdsflix.pub
```

Guarde o conteúdo do `.pub` — você vai colar no console da Oracle.

## 3. Criar a VM

No console: **Menu → Compute → Instances → Create instance**.

| Campo | Valor |
| :--- | :--- |
| Name | `fdsflix` |
| Availability Domain | tente o AD-1; se der capacidade, tente AD-2/AD-3 |
| Image | **Canonical Ubuntu 24.04** (aarch64, "Always Free eligible") |
| Shape | **Ampere → VM.Standard.A1.Flex** |
| OCPUs / Memory | **2 OCPUs / 12 GB** |
| Boot volume | 50 GB (padrão) |
| Networking | criar VCN com subnet pública e **public IPv4** |
| SSH keys | colar o conteúdo do `fdsflix.pub` |

Clique em **Create** e espere o estado **RUNNING**. Anote o **public IP**.

```bash
ssh -i ~/.ssh/fdsflix ubuntu@SEU_IP
```

> **"Out of host capacity"** é comum em A1. Tente outro Availability Domain,
> espere e tente de novo, ou faça upgrade para **Pay As You Go** (os recursos
> Always Free continuam $0 e você ganha prioridade de capacidade).

## 4. Liberar as portas 80 e 443 na VCN

No console: **Networking → Virtual Cloud Networks → sua VCN → Security Lists →
Default Security List → Add Ingress Rules**.

Adicione uma regra (ou duas):

| Source | IP Protocol | Destination Port Range |
| :--- | :--- | :--- |
| `0.0.0.0/0` | TCP | `80,443` |

A porta 22 já vem liberada.

## 5. Preparar a VM (Docker + firewall + Caddy)

Dentro da VM:

```bash
# baixe o script do seu repositório (ou clone antes)
git clone https://github.com/SEU_USUARIO/fdsflix.git ~/fdsflix
sudo bash ~/fdsflix/deploy/oracle-setup.sh fdsflix.duckdns.org https://github.com/SEU_USUARIO/fdsflix.git
```

O script:
- atualiza o Ubuntu;
- instala Docker, git, curl e iptables-persistent;
- **libera 80/443 no iptables** (as imagens da Oracle bloqueiam tudo por padrão);
- instala e configura o **Caddy** para o domínio informado;
- clona o repo em `/opt/fdsflix` e cria o `.env`.

> Sem domínio? Rode o script sem o primeiro argumento e use HTTP só para testar
> localmente. Para a Vercel você **precisa de HTTPS** (senão o navegador bloqueia
> por mixed content).

## 6. Domínio grátis com DuckDNS

1. Entre em <https://www.duckdns.org>, faça login e crie um subdomínio
   (ex.: `fdsflix`).
2. Copie o **token** e rode (no seu PC ou na VM):

```bash
curl "https://www.duckdns.org/update?domains=fdsflix&token=SEU_TOKEN&ip=SEU_IP_PUBLICO"
# resposta esperada: OK
dig +short fdsflix.duckdns.org   # deve mostrar o IP da VM
```

3. O Caddy pega o certificado Let's Encrypt sozinho assim que o DNS apontar
   para a VM e as portas 80/443 estiverem abertas.

Se preferir configurar na mão:

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
fdsflix.duckdns.org {
	reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl reload caddy
```

Teste:

```bash
curl -I https://fdsflix.duckdns.org
```

## 7. Configurar e subir o backend

```bash
cd /opt/fdsflix
nano .env
```

```env
PORT=3000
TMDB_API_KEY=sua_chave_tmdb
VIDLINK_KEY_HEX=sua_chave_hex
VIDLINK_API_URL=https://vidlink.pro/api/b

# importante para a API devolver URLs https
PUBLIC_BASE_URL=https://fdsflix.duckdns.org

# opcional: protege a API
# API_KEY=uma_chave_forte
```

Suba o container:

```bash
cd /opt/fdsflix
sudo docker compose up -d --build
```

Testes:

```bash
curl http://127.0.0.1:3000/api/health
curl https://fdsflix.duckdns.org/api/health
```

O retorno deve ser `{"ok":true,"ffmpeg":true,...}`.

## 8. Apontar a Vercel para o backend

Na Vercel, **Settings → Environment Variables**:

| Nome | Valor |
| :--- | :--- |
| `API_BASE_URL` | `https://fdsflix.duckdns.org` |
| `API_KEY` | (só se você ativou no backend) |

Depois faça **Redeploy**. O `vercel.json` gera o `public/config.js` com essa URL
no build.

## 9. Atualizações e logs

```bash
cd /opt/fdsflix
git pull
sudo docker compose up -d --build
sudo docker compose logs -f
```

## 10. Evitar que a Oracle recolha a VM ociosa

A Oracle pode recolher instâncias Always Free consideradas ociosas. A regra
oficial: em uma janela de 7 dias, **CPU p95 < 20%**, **rede < 20%** e
**memória < 20%** (para A1). Um servidor de uso pessoal pode se encaixar nisso.

Opções:
- **Upgrade para Pay As You Go** (recomendado): os recursos Always Free
  continuam **US$ 0**, mas a política de recolhimento deixa de valer e você ganha
  prioridade de capacidade. Crie **budget alerts** e não crie nada fora do
  Always Free.
- Manter a máquina realmente em uso (outros serviços, monitoramento etc.).

## 11. Performance esperada

- 2 OCPUs ARM: **480p** roda com folga; **720p** pode ficar no limite.
- O app já usa 480p por padrão no modo automático e tem teto de 720p.
- Acompanhe com `sudo docker stats` e `htop`.
- Se o vídeo engasgar, use `res=360` no player (seletor de qualidade).

## 12. Troubleshooting

| Sintoma | Causa provável / solução |
| :--- | :--- |
| `Out of host capacity` ao criar a VM | outro Availability Domain, tentar mais tarde ou upgrade PAYG |
| `https://...` não abre | DNS do DuckDNS ainda não aponta; portas 80/443 fechadas na VCN **ou** no iptables; `sudo journalctl -u caddy -f` |
| 502 no Caddy | container parado: `sudo docker compose ps` e `sudo docker compose logs` |
| Erro de mixed content na Vercel | `API_BASE_URL` tem que ser `https://...` |
| `ffmpeg` não encontrado | o Dockerfile já instala; confira `sudo docker compose exec fdsflix ffmpeg -version` |
| Vídeo engasga | 2 núcleos ARM: use 480p/360p; confira `docker stats` |
| API responde URL `http://` | defina `PUBLIC_BASE_URL=https://seu-dominio` e recrie o container |
| iptables volta após reboot | rode `sudo netfilter-persistent save` (o script já faz) |

## Alternativa: Cloudflare Tunnel (sem abrir portas)

Se você tem um domínio na Cloudflare, dá para expor a VM sem abrir 80/443 e sem
Caddy:

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared
chmod +x cloudflared
./cloudflared tunnel --url http://localhost:3000
```

Para um túnel com URL fixa, crie um **named tunnel** no painel da Cloudflare e
aponte um subdomínio para ele. Para testes rápidos, o `--url` gera um
`https://algo.trycloudflare.com` temporário (muda ao reiniciar).

## Checklist final

- [ ] VM A1 2 OCPU / 12 GB rodando
- [ ] portas 80/443 abertas na VCN e no iptables
- [ ] DuckDNS apontando para o IP
- [ ] `https://SEU-DOMINIO/api/health` → `ffmpeg: true`
- [ ] `PUBLIC_BASE_URL` configurada
- [ ] Vercel com `API_BASE_URL=https://SEU-DOMINIO` e redeploy
- [ ] vídeo tocando no navegador
