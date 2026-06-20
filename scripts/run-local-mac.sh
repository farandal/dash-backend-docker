#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

ENVIRONMENT="${1:-local}"
STARTUP_DELAY_SECONDS="${STARTUP_DELAY_SECONDS:-4}"
WINDOW_DELAY_SECONDS="${WINDOW_DELAY_SECONDS:-3}"

resolve_env_file() {
  local env_input="$1"
  if [[ "$env_input" == .env || "$env_input" == .env.* ]]; then
    printf "%s" "$env_input"
    return
  fi

  printf ".env.%s" "$env_input"
}

# The Laravel app env file to mount inside the container (e.g. .env.local).
APP_ENV_FILE="$(resolve_env_file "$ENVIRONMENT")"
if [[ ! -f "$APP_ENV_FILE" ]]; then
  echo "Env file not found: $APP_ENV_FILE" >&2
  exit 1
fi

# Export ENV_FILE so it overrides the value in .env during Docker Compose
# variable substitution (shell env has higher precedence than --env-file / .env).
# Docker Compose auto-loads .env for Compose-level variables such as
# DOMAIN_PATH, DASH_IMAGE, and port mappings.  We must NOT pass .env.local as
# --env-file because that would replace .env as the substitution source and
# lose DOMAIN_PATH, causing the domain mount to fall back to the default
# ../dash-backend-domain placeholder.
export ENV_FILE="$APP_ENV_FILE"

echo "Using APP_ENV_FILE=$APP_ENV_FILE (Laravel app env, mounted into container)"
echo "Using .env (Docker Compose config — provides DOMAIN_PATH, DASH_IMAGE, ports)"
echo "Working directory: $PROJECT_DIR"

echo "[1/8] docker compose up -d"
docker compose up -d

echo "Waiting $STARTUP_DELAY_SECONDS second(s) before migrations..."
sleep "$STARTUP_DELAY_SECONDS"

echo "[2/8] docker compose exec app php artisan migrate"
docker compose exec app php artisan migrate

echo "[3/8] generate API docs"
pnpm docs:generate

open_terminal_window() {
  local title="$1"
  local command="$2"

  # Open a new Terminal window and run the command while preserving ENV_FILE.
  osascript <<EOF
  tell application "Terminal"
    activate
    do script "cd '$PROJECT_DIR'; export ENV_FILE='$APP_ENV_FILE'; echo 'Using ENV_FILE=$APP_ENV_FILE'; echo 'Running: $command'; $command"
    set custom title of front window to "$title"
  end tell
EOF
}

echo "[4/8] Opening Reverb terminal window"
open_terminal_window "dash-backend-docker | Reverb" "docker compose exec app sh -lc 'ps aux | grep reverb:start | grep -v grep >/dev/null && echo Reverb is already running on port 25001 || php artisan reverb:start --debug'"
sleep "$WINDOW_DELAY_SECONDS"

echo "[5/8] Opening Horizon terminal window"
open_terminal_window "dash-backend-docker | Horizon" "docker compose exec app php artisan horizon"
sleep "$WINDOW_DELAY_SECONDS"

echo "[6/8] Opening Laravel log tail terminal window"
open_terminal_window "dash-backend-docker | Laravel logs" "docker compose exec app tail -f /var/www/html/storage/logs/laravel.log"
sleep "$WINDOW_DELAY_SECONDS"

echo "[7/7] Opening tests terminal window (Core+Domain)"
open_terminal_window "dash-backend-docker | Tests" "docker compose exec app php artisan test --testsuite=Core,Domain --log-junit /var/www/html/reports/test_results.xml --no-ansi"

if [[ "$ENVIRONMENT" == "tunnel" ]]; then
  echo "[8/8] Opening Cloudflare tunnel terminal window"
  open_terminal_window "dash-backend-docker | Cloudflare Tunnel" "pnpm cloudflare:tunnel"
fi

echo "Done. Reverb, Horizon, log tail, and tests are running in separate Terminal windows. Tests run in a single Core+Domain command."
