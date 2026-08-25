#!/usr/bin/env bash
# Daily SQLite backup. The database is the one irreplaceable thing here.
#   crontab -e
#   0 4 * * * /home/ec2-user/staffbot/deploy/backup.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${DATA_DIR:-$DIR/data}/staffbot.sqlite"
DEST="$DIR/backups"
KEEP=14

[ -f "$SRC" ] || { echo "no database at $SRC"; exit 0; }
mkdir -p "$DEST"

STAMP="$(date +%Y-%m-%d)"
# .backup is the safe way — a plain cp of a live WAL database can be corrupt.
sqlite3 "$SRC" ".backup '$DEST/staffbot-$STAMP.sqlite'" 2>/dev/null \
  || node -e "
      const Database=require('$DIR/node_modules/better-sqlite3');
      new Database('$SRC',{readonly:true}).backup('$DEST/staffbot-$STAMP.sqlite')
        .then(()=>console.log('backed up'));
    "

ls -1t "$DEST"/staffbot-*.sqlite | tail -n +$((KEEP+1)) | xargs -r rm --
echo "backup: $DEST/staffbot-$STAMP.sqlite  ($(ls -1 "$DEST" | wc -l) kept)"
