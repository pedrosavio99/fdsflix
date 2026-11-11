#!/usr/bin/env bash
# Sobe este projeto (adproxy) na conta Vercel em que você está logado.
# NÃO precisa configurar variável de ambiente nenhuma: PROXY_SECRET e TARGET_ORIGIN
# já vêm embutidos em lib/config.js. Rode uma vez por conta.
#
#   npx vercel logout     # se estava em outra conta
#   npx vercel login
#   bash deploy-vercel.sh
set -euo pipefail
cd "$(dirname "$0")"

VERCEL=(npx --yes vercel@latest)

echo "==> Conta Vercel ativa:"
"${VERCEL[@]}" whoami

echo "==> Criando/ligando o projeto nesta conta"
"${VERCEL[@]}" link --yes

echo "==> Publicando em produção"
OUT="$("${VERCEL[@]}" deploy --prod --yes 2>&1)" || { echo "$OUT" >&2; exit 1; }
echo "$OUT" | tail -n 8
URL="$(echo "$OUT" | grep -Eo 'https://[a-zA-Z0-9.-]+\.vercel\.app' | tail -n 1)"

echo
echo "==> Endereços de produção (o que vai no Render é o curto, sem hash):"
"${VERCEL[@]}" inspect "$URL" 2>&1 | grep -Eo 'https://[a-zA-Z0-9.-]+\.vercel\.app' | sort -u || true

echo
echo "Teste (deve responder JSON com status 200 nas etapas):"
echo "  curl -s \"https://SEU-DOMINIO.vercel.app/vidsrc/probe?tmdb=603\""
echo
echo "Se vier uma página HTML pedindo login: Project > Settings > Deployment Protection > desligue para Production."
echo "Depois: cole a URL de produção em VIDSRC_PROXY_URLS no Render (veja POOL-MANUAL.md)."
