#!/usr/bin/env bash
# Runs once, when the codespace is created.
#
# Deliberately NOT `set -e`. Postgres is a bonus here, not a prerequisite: the
# app falls back to its in-process store, which behaves correctly in a codespace
# because there is a single long-lived server rather than many serverless
# instances. A failed database install must not fail the whole codespace.
set -uxo pipefail

cd /workspaces/realtime-chat-app

npm install

if sudo apt-get update -y; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib || true
fi

if command -v pg_ctlcluster >/dev/null 2>&1 || [ -x /etc/init.d/postgresql ]; then
  sudo service postgresql start || true
  sudo -u postgres psql -c "CREATE ROLE chat LOGIN PASSWORD 'chat' SUPERUSER;" || true
  sudo -u postgres createdb -O chat chat || true
fi

echo "setup complete"
