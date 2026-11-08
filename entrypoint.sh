#!/bin/sh
# Railway volume root egaligida ulanadi. Papkani "node" foydalanuvchisiga beramiz
# va ilovani root huquqlarisiz ishga tushiramiz.
set -e

DATA_DIR="$(dirname "${DB_PATH:-/data/visa-admin.db}")"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups -- node --disable-warning=ExperimentalWarning /app/server.js
  fi
  echo "[entrypoint] OGOHLANTIRISH: setpriv topilmadi, root sifatida ishlamoqda" >&2
fi

exec node --disable-warning=ExperimentalWarning /app/server.js
