#!/usr/bin/env bash
# Запуск: ./start.sh [папка с pkg] [порт]
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="${1:-${PKG_DIR:-$HOME/Downloads/ps4-pkgs}}"
PORT="${2:-${PORT:-8000}}"

if ! command -v node >/dev/null 2>&1; then
  echo "Нужен Node.js: brew install node" >&2
  exit 1
fi

if [ ! -d "$PKG_DIR" ]; then
  echo "Папка не найдена: $PKG_DIR" >&2
  echo "Использование: ./start.sh <папка с pkg> [порт]" >&2
  exit 1
fi

# Мак не должен уснуть, пока PS4 качает пакет.
if command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -i node "$DIR/server.js" "$PKG_DIR" "$PORT"
fi
exec node "$DIR/server.js" "$PKG_DIR" "$PORT"
