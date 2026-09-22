#!/usr/bin/env bash
#
# Puts the Minecraft plugin's database on THIS machine.
#
# The usual arrangement is the other way round: the database lives with the game
# server and the bot dials out to it. That is fine until the game host firewalls
# its database node against datacenter addresses, which is a common anti-abuse
# default and not something you can talk your way around quickly. RaveNodes does
# exactly that — every port on their SQL node times out from EC2 while the game
# node answers fine.
#
# So the connection runs the other way instead. A plugin dialling out to an
# external database is ordinary and near-universally allowed, whereas a bot
# dialling in to a shared SQL node is what gets blocked. The bot then talks to
# 127.0.0.1, which is quicker anyway, and the database is never exposed beyond
# the one address that needs it.
#
# Run it on the EC2 box:
#
#   bash deploy/mysql-setup.sh [game-server-ip]
#
# Safe to run twice. It will not overwrite an existing database, and it rotates
# the password on a re-run only if you pass --new-password.

set -euo pipefail

GAME_IP="${1:-51.79.226.135}"
DB_NAME="tempest"
DB_USER="tempest"
ENV_FILE="$HOME/staffbot/.env"
NEW_PASSWORD=0

for arg in "$@"; do
  [ "$arg" = "--new-password" ] && NEW_PASSWORD=1
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as ubuntu, not root — it needs \$HOME to find .env." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
say "1. Installing MySQL"

if command -v mysqld >/dev/null 2>&1; then
  note "already installed — $(mysqld --version | head -1)"
else
  sudo apt-get update -qq
  # noninteractive so the package's own prompts do not block an unattended run.
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mysql-server
  note "installed"
fi

# ---------------------------------------------------------------------------
say "2. Listening for the game server"

# Ships bound to 127.0.0.1, which would refuse the plugin. Opened to all
# interfaces here because the real boundary is the AWS security group (step 5) —
# a bind address cannot express "this one remote host" and pretending otherwise
# just puts the restriction somewhere it is easy to believe and hard to verify.
CONF=/etc/mysql/mysql.conf.d/mysqld.cnf
if sudo grep -qE '^\s*bind-address\s*=\s*0\.0\.0\.0' "$CONF"; then
  note "already listening on all interfaces"
else
  sudo cp "$CONF" "$CONF.bak.$(date +%s)"
  sudo sed -i -E 's/^\s*bind-address\s*=.*/bind-address = 0.0.0.0/' "$CONF"
  # mysqlx is the X-protocol port, which nothing here uses.
  sudo sed -i -E 's/^\s*mysqlx-bind-address\s*=.*/mysqlx-bind-address = 127.0.0.1/' "$CONF"
  sudo systemctl restart mysql
  note "bind-address set to 0.0.0.0, config backed up"
fi

# ---------------------------------------------------------------------------
say "3. Database and user"

PASSWORD=""
if [ -f "$ENV_FILE" ] && [ "$NEW_PASSWORD" -eq 0 ]; then
  PASSWORD="$(grep -E '^TEMPEST_DB_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d "'\"" || true)"
fi

if [ -z "$PASSWORD" ]; then
  # Letters and digits only. The password crosses a .env file, a YAML file and a
  # shell, and every symbol worth having is special in at least one of them.
  PASSWORD="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
  note "generated a new password"
else
  note "reusing the password already in .env"
fi

sudo mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Two accounts, same name: MySQL identifies a user by name AND host, so the bot
-- on this machine and the plugin on the game server are separate grants. The
-- plugin's is pinned to its address, so a leaked password is not usable from
-- anywhere else even if the security group is later widened.
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${PASSWORD}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'${GAME_IP}' IDENTIFIED BY '${PASSWORD}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${PASSWORD}';
ALTER USER '${DB_USER}'@'${GAME_IP}' IDENTIFIED BY '${PASSWORD}';

GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'${GAME_IP}';
FLUSH PRIVILEGES;
SQL

note "database ${DB_NAME}, user ${DB_USER} from localhost and ${GAME_IP}"

# ---------------------------------------------------------------------------
say "4. Pointing the bot at it"

if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
  # Drop any existing TEMPEST_DB_* lines rather than appending beside them —
  # dotenv takes the FIRST occurrence, so a stale line above a new one silently
  # wins and the change appears not to have worked.
  grep -vE '^TEMPEST_DB_(HOST|PORT|USER|NAME|PASSWORD)=' "$ENV_FILE" > "$ENV_FILE.tmp"
  cat >> "$ENV_FILE.tmp" <<ENV

# --- Minecraft server database (local, see deploy/mysql-setup.sh) ------------
TEMPEST_DB_HOST=127.0.0.1
TEMPEST_DB_PORT=3306
TEMPEST_DB_USER=${DB_USER}
TEMPEST_DB_NAME=${DB_NAME}
TEMPEST_DB_PASSWORD='${PASSWORD}'
ENV
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  note "$ENV_FILE updated, previous version backed up"
else
  note "no $ENV_FILE — set these yourself:"
  note "  TEMPEST_DB_HOST=127.0.0.1"
  note "  TEMPEST_DB_USER=${DB_USER}"
  note "  TEMPEST_DB_NAME=${DB_NAME}"
fi

# ---------------------------------------------------------------------------
say "5. What the plugin needs"

cat <<DETAILS

  Host      $(curl -s --max-time 5 ifconfig.me || echo "this machine's public IP")
  Port      3306
  Database  ${DB_NAME}
  Username  ${DB_USER}
  Password  ${PASSWORD}

  Still to do by hand, in this order:

  1. AWS console -> EC2 -> Instances -> your instance -> Security tab ->
     the security group -> Inbound rules -> Edit -> Add rule:
       Type MySQL/Aurora, Port 3306, Source Custom, ${GAME_IP}/32
     Nothing else. Do NOT use 0.0.0.0/0 — that publishes the database.

  2. Import the old data, if you exported it from the panel:
       mysql -u ${DB_USER} -p ${DB_NAME} < ~/tempest-export.sql

  3. Put the details above into the plugin's database config, restart the
     Minecraft server, and check its console for a connection error.

  4. cd ~/staffbot && sudo systemctl restart staffbot && npm run tempest-check

DETAILS
