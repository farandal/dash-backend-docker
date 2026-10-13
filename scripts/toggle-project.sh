#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# Enable/disable one project's actual resource use on this box — not just
# git-watcher's auto-update, but the running containers and pm2 log-tail apps
# too. This machine confirmed live it cannot comfortably run kitchntabs +
# vanexa + inamap all at once (repeated Docker Desktop OOM-kills); this is
# how to free one up without deleting its setup.
#
# Usage:
#   ./scripts/toggle-project.sh <kitchntabs|vanexa|inamap> disable
#   ./scripts/toggle-project.sh <kitchntabs|vanexa|inamap> enable
#
# What "disable" does:
#   - docker compose stop  (containers stopped, NOT removed — volumes/data,
#     DB included, untouched; `enable` just starts them again, no re-migrate)
#   - pm2 stop on that project's log-tail apps (stays registered, 0% cpu, no
#     retry-loop against a now-stopped container — `enable` just pm2 starts
#     them again)
#   - removes the project from ACTIVE_PROJECTS in .env.projects, so
#     git-watcher.js stops polling/touching it entirely within one poll cycle
#     (60s) — no git fetch, no composer/migrate, no supervisorctl
#
# Does NOT touch: the project's Cloudflare tunnel ingress/DNS (its hostname
# just starts 502ing, which is the correct "disabled" signal — re-enabling
# needs no DNS/tunnel changes), or inamap's dedicated tunnel connector (it's
# cheap to leave running; only the backend containers are the real resource
# cost).
# ----------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="${1:-}"
ACTION="${2:-}"
ENV_FILE=".env.projects"

case "$PROJECT" in
  kitchntabs|vanexa) COMPOSE_DIR="." ; COMPOSE_ARGS=(--env-file ".env.$PROJECT") ; LOG_APPS=("$PROJECT-laravel-log" "$PROJECT-horizon-log" "$PROJECT-reverb-log" "$PROJECT-container-log" "$PROJECT-ai-agents-log") ;;
  inamap)            COMPOSE_DIR="../inamap-backend-docker" ; COMPOSE_ARGS=() ; LOG_APPS=("inamap-laravel-log" "inamap-horizon-log" "inamap-reverb-log" "inamap-container-log") ;;
  *) echo "Usage: $0 <kitchntabs|vanexa|inamap> <enable|disable>" >&2; exit 1 ;;
esac

read_active() {
  if [[ -f "$ENV_FILE" ]]; then
    grep -E '^ACTIVE_PROJECTS=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true
  fi
}

write_active() {
  local list="$1" tmp
  tmp="$(mktemp)"
  if [[ -f "$ENV_FILE" ]] && grep -qE '^ACTIVE_PROJECTS=' "$ENV_FILE"; then
    awk -v v="$list" 'BEGIN{d=0} /^ACTIVE_PROJECTS=/{print "ACTIVE_PROJECTS="v; d=1; next} {print} END{if(!d) print "ACTIVE_PROJECTS="v}' "$ENV_FILE" > "$tmp"
  else
    { [[ -f "$ENV_FILE" ]] && cat "$ENV_FILE"; echo "ACTIVE_PROJECTS=$list"; } > "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
}

# No file yet = every project implicitly active (matches git-watcher.js's own
# default) — seed the list with all three before removing/adding one, so an
# absent project isn't silently "active forever, never actually disabled."
current="$(read_active)"
if [[ -z "$current" ]]; then
  current="kitchntabs,vanexa,inamap"
fi
IFS=',' read -ra arr <<< "$current"

case "$ACTION" in
  disable)
    new_list=""
    for p in "${arr[@]}"; do [[ "$p" == "$PROJECT" ]] || new_list+="$p,"; done
    new_list="${new_list%,}"
    write_active "$new_list"
    echo "› .env.projects: ACTIVE_PROJECTS=$new_list"

    echo "› stopping containers ($PROJECT)..."
    ( cd "$COMPOSE_DIR" && docker compose "${COMPOSE_ARGS[@]}" stop )

    echo "› stopping pm2 log apps..."
    for app in "${LOG_APPS[@]}"; do
      pnpm exec pm2 stop "$app" 2>/dev/null || true
    done
    pnpm exec pm2 save
    echo "✓ $PROJECT disabled. Its hostname(s) will 502 until re-enabled — expected."
    ;;
  enable)
    case ",$current," in *",$PROJECT,"*) ;; *) current="${current:+$current,}$PROJECT" ;; esac
    write_active "$current"
    echo "› .env.projects: ACTIVE_PROJECTS=$current"

    echo "› starting containers ($PROJECT)..."
    ( cd "$COMPOSE_DIR" && docker compose "${COMPOSE_ARGS[@]}" up -d )

    echo "› starting pm2 log apps..."
    for app in "${LOG_APPS[@]}"; do
      pnpm exec pm2 start "$app" 2>/dev/null || true
    done
    pnpm exec pm2 save
    echo "✓ $PROJECT enabled. Containers may take a minute or two to finish booting."
    ;;
  *) echo "Usage: $0 <kitchntabs|vanexa|inamap> <enable|disable>" >&2; exit 1 ;;
esac
