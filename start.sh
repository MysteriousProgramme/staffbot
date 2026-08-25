#!/usr/bin/env bash
# Keeps the bot running and restarts it if it crashes.
cd "$(dirname "$0")"
while true; do
  npm start
  echo "Bot stopped. Restarting in 10s (Ctrl+C to quit)..."
  sleep 10
done
