#!/usr/bin/env bash
# Pull the latest code and restart. Run on the server: bash deploy/update.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "Pulling"
git pull

say "Dependencies"
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

say "Config check"
node src/check-config.js || echo "   (see above — the bot will still start)"

say "Registering slash commands"
# New commands only appear in Discord after this runs.
npm run deploy

say "Restarting"
# `systemctl cat` exits non-zero when the unit does not exist, and it asks
# systemd directly instead of grepping a table whose formatting is not a
# contract. The previous check scraped `list-unit-files` for a line starting
# with the unit name; on Ubuntu 24.04 that quietly stopped matching, so every
# deploy pulled new code, said the service was not installed, and left the old
# process running — the worst kind of failure, because it looks like a success.
if systemctl cat staffbot.service >/dev/null 2>&1; then
  sudo systemctl restart staffbot
  sleep 3
  sudo systemctl --no-pager --lines=25 status staffbot || true
  echo
  echo "Live logs:  journalctl -u staffbot -f"
else
  echo "   No staffbot service installed yet — run: bash deploy/install.sh"
fi
