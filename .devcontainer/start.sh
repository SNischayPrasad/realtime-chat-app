#!/usr/bin/env bash
# Runs on every codespace boot, including resumes from idle.
set -uxo pipefail

cd /workspaces/realtime-chat-app

sudo service postgresql start || true

export DATABASE_URL="postgres://chat:chat@localhost:5432/chat?sslmode=disable"
export AUTH_SECRET="codespace-development-secret-not-for-production"

# Deps may be missing on a resumed codespace whose volume was rebuilt.
[ -d node_modules ] || npm install

# setsid detaches into a new session so the server outlives this setup shell,
# and the explicit 0.0.0.0 bind is what the port forwarder needs to reach it.
setsid nohup npm run dev -- -H 0.0.0.0 -p 3000 > /workspaces/realtime-chat-app/dev.log 2>&1 < /dev/null &
