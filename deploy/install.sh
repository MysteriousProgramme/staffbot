#!/usr/bin/env bash
# Staffbot installer for a fresh EC2 box (Amazon Linux 2023, Ubuntu, Debian).
# Run from inside the project folder:  bash deploy/install.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(id -un)"
NODE_MAJOR=22

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "Staffbot installer"
echo "   directory : $DIR"
echo "   user      : $USER_NAME"
echo "   arch      : $(uname -m)"

# ---------------------------------------------------------------- Node
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then
  say "Node already present: $(node -v)"
else
  say "Installing Node ${NODE_MAJOR}"
  if command -v dnf >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | sudo bash -
    sudo dnf install -y nodejs
  elif command -v apt-get >/dev/null 2>&1; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    die "No dnf or apt-get found. Install Node ${NODE_MAJOR} manually, then re-run."
  fi
  echo "   installed: $(node -v)"
fi

# ---------------------------------------------------------------- deps
say "Installing dependencies"
cd "$DIR"
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---------------------------------------------------------------- .env
if [ ! -f "$DIR/.env" ]; then
  say ".env is missing"
  cat <<'MSG'
   Create it now, then re-run this script:

     nano .env

   with these three lines (no quotes, no spaces around the "="):

     DISCORD_TOKEN=your_token
     CLIENT_ID=your_application_id
     GUILD_ID=your_server_id
MSG
  exit 1
fi
chmod 600 "$DIR/.env"   # the token is in here

# ---------------------------------------------------------------- config check
say "Checking config"
node src/check-config.js || echo "   (fix the items above, then: sudo systemctl restart staffbot)"

# ---------------------------------------------------------------- commands
say "Registering slash commands"
npm run deploy

# ---------------------------------------------------------------- service
say "Installing the systemd service"
NODE_BIN="$(command -v node)"
sed -e "s|__USER__|${USER_NAME}|g" \
    -e "s|__DIR__|${DIR}|g" \
    -e "s|/usr/bin/node|${NODE_BIN}|g" \
    "$DIR/deploy/staffbot.service" | sudo tee /etc/systemd/system/staffbot.service >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable staffbot
sudo systemctl restart staffbot

sleep 3
say "Status"
sudo systemctl --no-pager --lines=20 status staffbot || true

cat <<'DONE'

Done. Useful commands:

  sudo systemctl status staffbot     is it running
  journalctl -u staffbot -f          live logs
  sudo systemctl restart staffbot    after editing config.js
  sudo systemctl stop staffbot       stop it

It now starts automatically on boot and restarts if it crashes.
DONE
