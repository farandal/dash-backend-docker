#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# No default project: this repo is shared across all domain checkouts
# (vanexa, fablabos, reddorada, kitchntabs, ...), so the project must always
# be passed explicitly (via pnpm dash:<project>:<env> or DASH_PROJECT) rather
# than baked in here as a per-clone customization.
PROJECT="${1:-${DASH_PROJECT:-}}"
if [[ -z "$PROJECT" ]]; then
  echo "Project not specified. Usage: run-local-mac.sh <project> [environment]" >&2
  echo "Or set DASH_PROJECT=<project>." >&2
  exit 1
fi
ENVIRONMENT="${2:-local}"
STARTUP_DELAY_SECONDS="${STARTUP_DELAY_SECONDS:-4}"
WINDOW_DELAY_SECONDS="${WINDOW_DELAY_SECONDS:-3}"

# Off by default: `php artisan test`'s base TestCase uses RefreshDatabase,
# which runs `migrate:fresh` (drops every table) against whatever DB_DATABASE
# the process resolves to. Nothing isolates that to the test database on its
# own - see the DB_DATABASE_TEST override below - so this used to run
# unconditionally on every `dash:start` and silently wipe real dev data.
# Pass --tests (any position, after project/environment) to opt in.
RUN_TESTS=0
# Explicit flag rather than inferring from ENVIRONMENT == "tunnel": any
# environment (local, staging, production, ...) may need its Cloudflare
# tunnel opened, not just one literally named "tunnel". ENVIRONMENT still
# controls which .env.<project>.<environment> app env is mounted; this only
# controls whether the tunnel window opens alongside it. ENVIRONMENT ==
# "tunnel" still implies it too, for backward compatibility with existing
# `pnpm dash:start <project> tunnel` usage.
OPEN_TUNNEL=0
for arg in "$@"; do
  if [[ "$arg" == "--tests" ]]; then
    RUN_TESTS=1
  fi
  if [[ "$arg" == "--tunnel" ]]; then
    OPEN_TUNNEL=1
  fi
done
if [[ "$ENVIRONMENT" == "tunnel" ]]; then
  OPEN_TUNNEL=1
fi

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

# The Laravel app env file to mount inside the container (e.g. .env.vanexa.local).
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

# The database `php artisan test` must run against - same extraction pattern
# as COMPOSE_PROJECT_NAME above. Read from the COMPOSE env file (not the
# mounted Laravel .env) because it's the one place this is already correctly
# set PER PROJECT (pgsql_setup creates it there on every boot); the Laravel
# .env only carries DB_DATABASE, the dev database.
DB_DATABASE_TEST_VALUE="$(grep -E '^DB_DATABASE_TEST=' "$COMPOSE_ENV_FILE" | tail -1 | cut -d= -f2-)"

compose() {
  docker compose --env-file "$COMPOSE_ENV_FILE" "$@"
}

# Total varies with what actually runs below, so the [n/N] counter stays
# accurate instead of a stale hardcoded "/9" regardless of flags.
TOTAL_STEPS=7
[[ "$RUN_TESTS" == "1" ]] && TOTAL_STEPS=$((TOTAL_STEPS + 1))
[[ "$OPEN_TUNNEL" == "1" ]] && TOTAL_STEPS=$((TOTAL_STEPS + 1))
STEP=0
next_step() { STEP=$((STEP + 1)); }

echo "Project:            $PROJECT"
echo "Using APP_ENV_FILE=$APP_ENV_FILE (Laravel app env, mounted into container)"
echo "Using COMPOSE_ENV_FILE=$COMPOSE_ENV_FILE (Docker Compose config — provides DOMAIN_PATH, DASH_IMAGE, ports)"
echo "Working directory: $PROJECT_DIR"
if [[ "$RUN_TESTS" == "1" ]]; then
  echo "Tests:              will run (DB_DATABASE=$DB_DATABASE_TEST_VALUE, isolated from dev data)"
else
  echo "Tests:              skipped (pass --tests to run them)"
fi

next_step
echo "[$STEP/$TOTAL_STEPS] docker compose up -d"
compose up -d

echo "Waiting $STARTUP_DELAY_SECONDS second(s) before migrations..."
sleep "$STARTUP_DELAY_SECONDS"

# vendor/, composer.json and composer.lock are baked into the image, not
# host-mounted (see docker-compose.yml), but domain/ IS live-mounted here by
# this point. `composer install` is the fast path (no-op if the image's lock
# already satisfies domain/composer.json). If the domain added/changed a
# composer dependency since the image was built (e.g. box/spout), install
# fails with "required package ... is not present in the lock file" — fall
# back to a full `composer update` to re-resolve against the live domain, so
# domain-only composer changes never require a core image rebuild.
# Deliberately NOT --no-scripts: Composer's post-autoload-dump hook is what
# runs `php artisan package:discover`, which rebuilds
# bootstrap/cache/packages.php. Skipping it leaves that cache stale relative
# to vendor/, silently dropping newly (re)installed packages' service
# providers/commands (e.g. nunomaduro/collision's `artisan test` command).
next_step
echo "[$STEP/$TOTAL_STEPS] docker compose exec app composer install (sync vendor/ with live-mounted domain/composer.json)"
if ! compose exec app composer install --no-interaction; then
  echo "  composer.lock is out of sync with domain/composer.json — re-resolving via composer update..."
  compose exec app composer update --no-interaction
fi

next_step
echo "[$STEP/$TOTAL_STEPS] docker compose exec app php artisan migrate"
compose exec app php artisan migrate

next_step
echo "[$STEP/$TOTAL_STEPS] generate API docs"
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

# Reverb and Horizon are no longer started here: the core image is always
# built from Dockerfile.core.production, which runs supervisord and
# auto-starts/auto-restarts both (see docker/app/custom-supervisor.conf).
# To restart them manually after a code change, use:
#   docker compose exec app supervisorctl -c /etc/supervisor/supervisord.conf restart reverb horizon
# We still tail their supervisor-managed log files below for visibility.

next_step
echo "[$STEP/$TOTAL_STEPS] Opening Reverb log tail terminal window"
open_terminal_window "dash-backend-docker | $PROJECT | Reverb logs" "docker compose exec app tail -f /var/www/dash/storage/logs/supervisor-reverb.log /var/www/dash/storage/logs/supervisor-reverb-error.log"
sleep "$WINDOW_DELAY_SECONDS"

next_step
echo "[$STEP/$TOTAL_STEPS] Opening Horizon log tail terminal window"
open_terminal_window "dash-backend-docker | $PROJECT | Horizon logs" "docker compose exec app tail -f /var/www/dash/storage/logs/supervisor-horizon.log /var/www/dash/storage/logs/supervisor-horizon-error.log"
sleep "$WINDOW_DELAY_SECONDS"

next_step
echo "[$STEP/$TOTAL_STEPS] Opening Laravel log tail terminal window"
open_terminal_window "dash-backend-docker | $PROJECT | Laravel logs" "docker compose exec app tail -f /var/www/dash/storage/logs/laravel.log"
sleep "$WINDOW_DELAY_SECONDS"

if [[ "$RUN_TESTS" == "1" ]]; then
  next_step
  if [[ -z "$DB_DATABASE_TEST_VALUE" ]]; then
    echo "[$STEP/$TOTAL_STEPS] Skipping tests: DB_DATABASE_TEST is not set in $COMPOSE_ENV_FILE" >&2
    echo "  Refusing to guess - running against the wrong database is exactly the bug this guards against." >&2
  else
    echo "[$STEP/$TOTAL_STEPS] Opening tests terminal window (Core+Domain), DB_DATABASE=$DB_DATABASE_TEST_VALUE"
    # -e overrides DB_DATABASE for THIS exec only - the running app/queue
    # containers, using the mounted .env's DB_DATABASE (the dev database),
    # are untouched. Unquoted: DB_DATABASE_TEST_VALUE is a plain identifier,
    # and this string is later wrapped in an AppleScript double-quoted
    # literal (see open_terminal_window) - embedding literal "" here would
    # terminate that literal early.
    open_terminal_window "dash-backend-docker | $PROJECT | Tests" "docker compose exec -e DB_DATABASE=$DB_DATABASE_TEST_VALUE app php artisan test --testsuite=Core,Domain --log-junit /var/www/dash/reports/test_results.xml --no-ansi"
  fi
fi

if [[ "$OPEN_TUNNEL" == "1" ]]; then
  next_step
  echo "[$STEP/$TOTAL_STEPS] Opening Cloudflare tunnel terminal window"
  # CF_TUNNEL_* config lives in the Compose-level file, not the Laravel app
  # env file, so the tunnel script needs its own explicit --env-file too.
  # --env-suffix lets that one file carry per-environment hostname overrides
  # (e.g. CF_TUNNEL_HOSTNAME_API_STAGING) alongside the base dev hostnames,
  # so `staging` and `tunnel` route to different public hostnames on the same
  # named tunnel instead of colliding on CF_TUNNEL_HOSTNAME_API.
  ENV_SUFFIX="$(echo "$ENVIRONMENT" | tr '[:lower:]' '[:upper:]')"
  open_terminal_window "dash-backend-docker | $PROJECT | Cloudflare Tunnel" "node ./scripts/cloudflare-tunnel.js --env-file '$COMPOSE_ENV_FILE' --env-suffix '$ENV_SUFFIX'"
fi

echo "Done. Reverb and Horizon run automatically via supervisord inside the container; their logs and the Laravel log are tailing in separate Terminal windows.$( [[ "$RUN_TESTS" == "1" ]] && echo " Tests are tailing too." )"
