#!/usr/bin/env bash
# Runs once when the codespace is created.
#
# Postgres lives in the same container as the app rather than in a second
# compose service: a single-container devcontainer keeps the standard Codespaces
# bootstrap (including SSH), which a custom compose stack does not get.
set -euxo pipefail

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib
sudo service postgresql start

# Idempotent: re-running setup must not fail on an existing role or database.
sudo -u postgres psql -c "CREATE ROLE chat LOGIN PASSWORD 'chat' SUPERUSER;" || true
sudo -u postgres createdb -O chat chat || true

cd /workspaces/realtime-chat-app
npm install
