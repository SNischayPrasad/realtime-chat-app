#!/usr/bin/env bash
# Runs on every codespace boot, including resume from idle.
set -uxo pipefail

cd /workspaces/realtime-chat-app

sudo service postgresql start >/dev/null 2>&1 || true

# Only claim a database if one actually answers; otherwise leave DATABASE_URL
# unset so the app takes its in-process store instead of failing every query.
if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  export DATABASE_URL="postgres://chat:chat@localhost:5432/chat?sslmode=disable"
fi
export AUTH_SECRET="codespace-development-secret-not-for-production"

[ -d node_modules ] || npm install

# setsid detaches it from this setup shell so it is not reaped; the explicit
# 0.0.0.0 bind is what the port forwarder needs to reach it.
setsid nohup npm run dev -- -H 0.0.0.0 -p 3000 > /workspaces/realtime-chat-app/dev.log 2>&1 < /dev/null &

echo "start invoked"
