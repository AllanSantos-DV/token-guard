#!/usr/bin/env bash
# scripts/verify-daemon-security.sh
#
# Checklist MANUAL (F4/D5) — NÃO faz parte de `npm test`. Confirma, contra um
# daemon token-guard já vivo, que o socket Unix ficou com permissão 0700
# (dono-apenas) e não herdou permissões mais abertas do diretório pai.
#
# Uso: com um daemon token-guard já rodando nesta máquina,
#   bash scripts/verify-daemon-security.sh [/path/to/socket]

set -euo pipefail

SOCKET_PATH="${1:-}"

if [ -z "$SOCKET_PATH" ]; then
  RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
  SOCKET_PATH=$(find "$RUNTIME_DIR" -maxdepth 1 -name "token-guard-*.sock" 2>/dev/null | head -n1 || true)
  if [ -z "$SOCKET_PATH" ]; then
    echo "Nenhum socket 'token-guard-*.sock' encontrado em $RUNTIME_DIR. Suba o daemon primeiro (node adapters/daemon-server.cjs)." >&2
    exit 1
  fi
  echo "Socket detectado automaticamente: $SOCKET_PATH"
fi

if [ ! -S "$SOCKET_PATH" ]; then
  echo "FALHOU: '$SOCKET_PATH' não é um socket Unix." >&2
  exit 1
fi

echo "Verificando permissões de: $SOCKET_PATH"
echo ""

if command -v stat >/dev/null 2>&1; then
  if stat -c '%a %U' "$SOCKET_PATH" >/dev/null 2>&1; then
    # GNU stat
    read -r MODE OWNER <<< "$(stat -c '%a %U' "$SOCKET_PATH")"
  else
    # BSD/macOS stat
    read -r MODE OWNER <<< "$(stat -f '%Lp %Su' "$SOCKET_PATH")"
  fi
else
  echo "FALHOU: comando 'stat' não disponível." >&2
  exit 1
fi

CURRENT_USER=$(id -un)

echo "  modo:  $MODE"
echo "  dono:  $OWNER"
echo "  esperado: 700 / $CURRENT_USER"
echo ""

FAILED=0

if [ "$MODE" != "700" ]; then
  echo "SUSPEITO: modo do socket é $MODE, esperado 700 (dono-apenas)." >&2
  FAILED=1
fi

if [ "$OWNER" != "$CURRENT_USER" ]; then
  echo "SUSPEITO: dono do socket é '$OWNER', esperado '$CURRENT_USER'." >&2
  FAILED=1
fi

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "FALHOU: revisar permissões do socket (D5, docs/PLAN-daemon-unico.md)." >&2
  exit 1
else
  echo "OK: socket restrito a 0700 e de posse do usuário atual."
  exit 0
fi
