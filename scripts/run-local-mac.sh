#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

PROJECT="${1:-kitchntabs}"
ENVIRONMENT="${2:-local}"
STARTUP_DELAY_SECONDS="${STARTUP_DELAY_SECONDS:-4}"
WINDOW_DELAY_SECONDS="${WINDOW_DELAY_SECONDS:-3}"

# Compose-level config (DOMAIN_PATH, STORAGE_PATH, DASH_IMAGE, ports) lives in
# one file per project (.env.<project>). Docker Compose only auto-loads a
# literal `.env`, so this is always passed explicitly via --env-file below.
COMPOSE_ENV_FILE=".env.${PROJECT}"
if [[ ! -f "$COMPOSE_ENV_FILE" ]]; then
  echo "Compose env file not found: $COMPOSE_ENV_FILE" >&2
  echo "Create it (e.g. copy .env.example) with DOMAIN_PATH=../${PROJECT}-backend-domain" >&2
  exit 1
fi

resolve_env_file() {
  local env_input="$1"
  if [[ "$env_input" == .env || "$env_input" == .env.* ]]; then
    printf "%s" "$env_input"
    return
  fi

  printf ".env.%s.%s" "$PROJECT" "$env_input"
}

# The Laravel app env file to mount inside the container (e.g. .env.kitchntabs.local).
APP_ENV_FILE="$(resolve_env_file "$ENVIRONMENT")"
if [[ ! -f "$APP_ENV_FILE" ]]; then
  echo "Env file not found: $APP_ENV_FILE" >&2
  exit 1
fi

# Export ENV_FILE so it overrides the value in $COMPOSE_ENV_FILE during Docker
# Compose variable substitution (shell env has higher precedence than
# --env-file). We must NOT pass $APP_ENV_FILE itself as --env-file, since that
# would replace $COMPOSE_ENV_FILE as the substitution source and lose
# DOMAIN_PATH, causing the domain mount to fall back to the default
# ../dash-backend-domain placeholder.
export ENV_FILE="$APP_ENV_FILE"

# Docker Compose resolves which running containers belong to "app" by project
# label, not just container name. That label comes from COMPOSE_PROJECT_NAME,
# which is normally only sourced from a literal `.env` (no longer present) or
# --env-file. Exporting it here makes every subsequent `docker compose exec`
# in this script AND child processes (pnpm docs:generate) resolve to the same
# project as the `up -d` call above, instead of falling back to the directory
# name and reporting "service app is not running".
COMPOSE_PROJECT_NAME="$(grep -E '^COMPOSE_PROJECT_NAME=' "$COMPOSE_ENV_FILE" | tail -1 | cut -d= -f2-)"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dash_image}"

compose() {
  docker compose --env-file "$COMPOSE_ENV_FILE" "$@"
}

echo "Project:            $PROJECT"
echo "Using APP_ENV_FILE=$APP_ENV_FILE (Laravel app env, mounted into container)"
echo "Using COMPOSE_ENV_FILE=$COMPOSE_ENV_FILE (Docker Compose config — provides DOMAIN_PATH, DASH_IMAGE, ports)"
echo "Working directory: $PROJECT_DIR"

echo "[1/8] docker compose up -d"
compose up -d

echo "Waiting $STARTUP_DELAY_SECONDS second(s) before migrations..."
sleep "$STARTUP_DELAY_SECONDS"

echo "[2/8] docker compose exec app php artisan migrate"
compose exec app php artisan migrate

echo "[3/8] generate API docs"
pnpm docs:generate

open_terminal_window() {
  local title="$1"
  local command="$2"

  # Open a new Terminal window and run the command while preserving ENV_FILE.
  osascript <<EOF
  tell application "Terminal"
    activate
    do script "cd '$PROJECT_DIR'; export ENV_FILE='$APP_ENV_FILE'; export COMPOSE_PROJECT_NAME='$COMPOSE_PROJECT_NAME'; echo 'Using ENV_FILE=$APP_ENV_FILE'; echo 'Running: $command'; $command"
    set custom title of front window to "$title"
  end tell
EOF
}

echo "[4/8] Opening Reverb terminal window"
open_terminal_window "dash-backend-docker | $PROJECT | Reverb" "docker compose exec app sh -lc 'ps aux | grep reverb:start | grep -v grep >/dev/null && echo Reverb is already running on port 25001 || php artisan reverb:start --debug'"
sleep "$WINDOW_DELAY_SECONDS"

echo "[5/8] Opening Horizon terminal window"
open_terminal_window "dash-backend-docker | $PROJECT | Horizon" "docker compose exec app php artisan horizon"
sleep "$WINDOW_DELAY_SECONDS"

echo "[6/8] Opening Laravel log tail terminal window"
open_terminal_window "dash-backend-docker | $PROJECT | Laravel logs" "docker compose exec app tail -f /var/www/html/storage/logs/laravel.log"
sleep "$WINDOW_DELAY_SECONDS"

echo "[7/7] Opening tests terminal window (Core+Domain)"
open_terminal_window "dash-backend-docker | $PROJECT | Tests" "docker compose exec app php artisan test --testsuite=Core,Domain --log-junit /var/www/html/reports/test_results.xml --no-ansi"

if [[ "$ENVIRONMENT" == "tunnel" ]]; then
  echo "[8/8] Opening Cloudflare tunnel terminal window"
  # CF_TUNNEL_* config lives in the Compose-level file, not the Laravel app
  # env file, so the tunnel script needs its own explicit --env-file too.
  open_terminal_window "dash-backend-docker | $PROJECT | Cloudflare Tunnel" "node ./scripts/cloudflare-tunnel.js --env-file '$COMPOSE_ENV_FILE'"
fi

echo "Done. Reverb, Horizon, log tail, and tests are running in separate Terminal windows. Tests run in a single Core+Domain command."
