#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

ENVIRONMENT="${1:-local}"
ENABLE_TUNNEL="${2:-}"
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

ENV_FILE_SELECTED="$(resolve_env_file "$ENVIRONMENT")"
if [[ ! -f "$ENV_FILE_SELECTED" ]]; then
  echo "Env file not found: $ENV_FILE_SELECTED" >&2
  exit 1
fi

export ENV_FILE="$ENV_FILE_SELECTED"

# Create/update symlink for Docker Compose to use .env (extract base env name from Laravel env file)
# E.g., .env.kitchntabs.local -> .env.kitchntabs for compose
DOCKER_ENV_FILE=".env.${ENVIRONMENT%.*}"
if [[ ! -f "$DOCKER_ENV_FILE" ]]; then
  echo "Docker env file not found: $DOCKER_ENV_FILE" >&2
  exit 1
fi

rm -f .env
ln -s "$DOCKER_ENV_FILE" .env

echo "Using ENV_FILE=$ENV_FILE"
echo "Using Docker Compose env: $DOCKER_ENV_FILE"
echo "Working directory: $PROJECT_DIR"

echo "[1/7] docker compose down -v"
docker compose down -v

echo "[2/7] docker compose up -d"
docker compose up -d

echo "Waiting $STARTUP_DELAY_SECONDS second(s) before migrations..."
sleep "$STARTUP_DELAY_SECONDS"

echo "[3/7] docker compose exec app php artisan migrate"
docker compose exec app php artisan migrate --force

open_terminal_window() {
  local title="$1"
  local command="$2"
  local retries=3

  # Open a new Terminal window and run the command while preserving ENV_FILE.
  # Retry on timeout since Terminal can be slow to respond
  while [ $retries -gt 0 ]; do
    osascript <<EOF 2>/dev/null && break
  tell application "Terminal"
    activate
    do script "cd '$PROJECT_DIR'; export ENV_FILE='$ENV_FILE_SELECTED'; printf 'Using ENV_FILE=%s\\n' \"\$ENV_FILE\"; echo 'Running: $command'; $command"
    set custom title of front window to "$title"
  end tell
EOF
    retries=$((retries - 1))
    if [ $retries -gt 0 ]; then
      sleep 2
    fi
  done

  if [ $retries -eq 0 ]; then
    echo "Warning: Failed to open Terminal window for '$title'. You can run this manually:"
    echo "  cd '$PROJECT_DIR' && export ENV_FILE='$ENV_FILE_SELECTED' && $command"
  fi
}

echo "[4/7] Opening Reverb terminal window"
open_terminal_window "dash-backend-docker | Reverb" "docker compose exec app php artisan reverb:start"
sleep "$WINDOW_DELAY_SECONDS"

echo "[5/7] Opening Horizon terminal window"
open_terminal_window "dash-backend-docker | Horizon" "docker compose exec app php artisan horizon"
sleep "$WINDOW_DELAY_SECONDS"

echo "[6/7] Opening Laravel log tail terminal window"
open_terminal_window "dash-backend-docker | Laravel logs" "docker compose exec app tail -f /var/www/dash/storage/logs/laravel.log"
sleep "$WINDOW_DELAY_SECONDS"

echo "[7/7] Opening Core tests terminal window"
open_terminal_window "dash-backend-docker | Core tests" "docker compose exec app php artisan test --testsuite=Core --log-junit /var/www/dash/reports/core_results.xml"

echo "Done. Reverb, Horizon, log tail, and tests are running in separate Terminal windows."

if [[ "$ENABLE_TUNNEL" == "--tunnel" ]]; then
  echo ""
  echo "Starting Cloudflare Tunnel..."
  sleep 2
  open_terminal_window "dash-backend-docker | Cloudflare Tunnel" "node ./scripts/cloudflare-tunnel.js"
fi
