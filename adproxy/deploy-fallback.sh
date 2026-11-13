#!/usr/bin/env bash
# Sobe o nó do AdFallback (proxy de mídia dos filmes) na conta Vercel em que você está logado.
# Não precisa configurar variável nenhuma: MEDIA_PROXY=1 e a chave de mídia já vêm embutidos
# em lib/config.js (este arquivo veio do .zip gerado pelo fdsFlix). Rode uma vez por conta.
#
#   npx vercel logout     # se estava em outra conta
#   npx vercel login
#   bash deploy-fallback.sh
set -euo pipefail
cd "$(dirname "$0")"

VERCEL=(npx --yes vercel@latest)

echo "==> Conta Vercel ativa:"
"${VERCEL[@]}" whoami

echo "==> Criando/ligando o projeto"
"${VERCEL[@]}" link --yes

echo "==> Publicando em produção"
OUT="$("${VERCEL[@]}" deploy --prod --yes 2>&1)" || { echo "$OUT" >&2; exit 1; }
echo "$OUT" | tail -n 8
URL="$(echo "$OUT" | grep -Eo 'https://[a-zA-Z0-9.-]+\.vercel\.app' | tail -n 1)"

KEY="$(grep -oE "MEDIA_KIT = \{ enabled: true, key: '[^']+'" lib/config.js 2>/dev/null | sed -E "s/.*key: '([^']+)'.*/\1/" || true)"

echo
echo "==> Endereços de produção (o que vai no Render é o curto, sem hash):"
"${VERCEL[@]}" inspect "$URL" 2>&1 | grep -Eo 'https://[a-zA-Z0-9.-]+\.vercel\.app' | sort -u || true

echo
echo "Cole no Render (fdsFlix -> Environment):"
echo "  ADSHIELD_FALLBACK_URLS=<a URL curta acima>"
echo "  ADSHIELD_FALLBACK_KEY=${KEY:-<(a chave está no LEIA-ME.txt)>}"
echo
echo "Teste (1 KB de mídia pelo nó):"
echo "  curl -s -H \"x-media-key: ${KEY:-SUA-CHAVE}\" \"https://SEU-DOMINIO/_adshield/media/prepare?u=https%3A%2F%2Fexemplo.com%2Fmaster.m3u8\""
echo
echo "Se vier uma página HTML pedindo login: Project > Settings > Deployment Protection > desligue para Production."
echo "Para somar outro nó no rodízio, repita numa conta nova e separe as URLs por vírgula em ADSHIELD_FALLBACK_URLS."
