#!/usr/bin/env bash
# Run inside a dedicated Terminal window, opened automatically at login by
# ~/Library/LaunchAgents/com.dashbackenddocker.pm2monit.plist (see
# scripts/launchd/com.dashbackenddocker.pm2monit.plist for the template and
# PM2_AUTOMATION.md for the full setup). Waits for the pm2 daemon to actually
# be responsive first — right after boot it may not be up yet — then execs
# `pm2 monit`, replacing this shell so Ctrl-C/closing the window behaves like
# quitting monit normally.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

until pnpm exec pm2 ping > /dev/null 2>&1; do
  echo "Waiting for pm2 daemon..."
  sleep 2
done

exec pnpm exec pm2 monit
