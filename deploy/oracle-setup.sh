#!/usr/bin/env bash
#
# Prepara uma VM Ubuntu (Oracle Cloud Ampere A1 / ARM64) para rodar o fdsFlix:
#   - instala Docker + git + curl
#   - libera as portas 80/443 no firewall local da imagem Oracle
#   - instala o Caddy e configura HTTPS para o domínio informado
#   - clona o repositório em /opt/fdsflix (se a URL for passada)
#
# Uso:
#   sudo bash deploy/oracle-setup.sh SEU-DOMINIO [URL_DO_REPOSITORIO]
#
# Exemplo:
#   sudo bash deploy/oracle-setup.sh fdsflix.duckdns.org https://github.com/USER/fdsflix.git
#
# Obs.: as portas 80/443 também precisam ser liberadas na Security List da VCN
# no console da Oracle (isso não dá para fazer por aqui).

set -euo pipefail

DOMAIN="${1:-}"
REPO_URL="${2:-}"
APP_DIR="/opt/fdsflix"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Rode com sudo: sudo bash deploy/oracle-setup.sh SEU-DOMINIO [REPO]"
  exit 1
fi

if [[ "$(uname -m)" != "aarch64" && "$(uname -m)" != "arm64" ]]; then
  echo "Aviso: esta VM não é ARM64 ($(uname -m)). O script funciona mesmo assim."
fi

echo "==> Atualizando pacotes"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y

echo "==> Instalando dependências"
apt-get install -y ca-certificates curl git gnupg iptables-persistent

echo "==> Instalando Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
# O usuário 'ubuntu' (ou seu usuário) passa a rodar docker sem sudo após relogar.
if id ubuntu >/dev/null 2>&1; then
  usermod -aG docker ubuntu || true
fi

echo "==> Liberando portas 80/443 no firewall da imagem Oracle"
for port in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "${port}" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT -p tcp --dport "${port}" -j ACCEPT
  fi
done
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4
systemctl enable netfilter-persistent 2>/dev/null || true
systemctl restart netfilter-persistent 2>/dev/null || true

# Se a imagem tiver ufw ativo, libera também.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi

echo "==> Instalando Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

if [[ -n "${DOMAIN}" ]]; then
  echo "==> Configurando Caddy para ${DOMAIN}"
  cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	reverse_proxy 127.0.0.1:3000
	header {
		-Server
	}
}
EOF
  systemctl enable caddy
  systemctl restart caddy
  echo "    Caddy vai pedir o certificado Let's Encrypt assim que o DNS apontar para esta VM."
else
  echo "==> Sem domínio informado: HTTPS não configurado."
  echo "    Rode de novo passando o domínio, ou use 'cloudflared tunnel'."
fi

if [[ -n "${REPO_URL}" ]]; then
  echo "==> Clonando o repositório em ${APP_DIR}"
  if [[ -d "${APP_DIR}/.git" ]]; then
    git -C "${APP_DIR}" pull --ff-only
  else
    git clone "${REPO_URL}" "${APP_DIR}"
  fi

  if [[ ! -f "${APP_DIR}/.env" ]]; then
    cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
    chmod 600 "${APP_DIR}/.env"
  fi

  # Facilita a edição do .env pelo usuário comum.
  if id ubuntu >/dev/null 2>&1; then
    chown -R ubuntu:ubuntu "${APP_DIR}" || true
  fi

  echo ""
  echo "Próximos passos:"
  echo "  1) edite ${APP_DIR}/.env (TMDB_API_KEY, VIDLINK_KEY_HEX, PUBLIC_BASE_URL)"
  echo "  2) cd ${APP_DIR} && docker compose up -d --build"
  echo "  3) curl https://${DOMAIN:-SEU-DOMINIO}/api/health"
else
  echo ""
  echo "Próximos passos:"
  echo "  1) git clone <seu-repo> ${APP_DIR}"
  echo "  2) cp ${APP_DIR}/.env.example ${APP_DIR}/.env && nano ${APP_DIR}/.env"
  echo "  3) cd ${APP_DIR} && docker compose up -d --build"
fi

echo ""
echo "==> Concluído."
