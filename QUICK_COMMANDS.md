# Quick Commands — kitchntabs & vanexa

Copy-paste reference for day-to-day operation of the two active domains. All `docker compose`
commands **must** include `--env-file .env.<project>` — without it, Compose falls back to a
project name derived from the directory (`dash-backend-docker`), not `dash_image` /
`vanexa_image`, and silently operates on nothing (or on stale leftover resources from a previous
project-less run). This has bitten us before: `docker compose down` with no `--env-file` reported
doing nothing while the real stack kept running untouched.

> **Full reference:** [README.md](./README.md) · **Dev cheatsheet:** [DASH-BACKEND-DOCKER-DEVELOPMENT.md](./DASH-BACKEND-DOCKER-DEVELOPMENT.md)

| | kitchntabs | vanexa |
|---|---|---|
| Compose env file | `.env.kitchntabs` | `.env.vanexa` |
| `COMPOSE_PROJECT_NAME` | `dash_image` | `vanexa_image` |
| API port (local) | `25000` | `25100` |
| Reverb port (local) | `25001` | `26001` |
| DB | `kt_dev_db` | `vx_dev_db` |
| Staging API hostname | `api-staging.kitchntabs.com` | `api-staging.vanexa.cl` |
| Staging WS hostname | `ws-staging.kitchntabs.com` | `ws-staging.vanexa.cl` |

All commands below assume you're in `dash-backend-docker/`. `<ENV>` = the compose env file
(`.env.kitchntabs` or `.env.vanexa`).

---

## Start / stop the stack

```bash
# Start (boots stack + migrates + opens log windows)
pnpm dash:start kitchntabs local
pnpm dash:start vanexa local

# Start with staging app env + Cloudflare tunnel
pnpm dash:start kitchntabs staging --tunnel
pnpm dash:start vanexa staging --tunnel

# Tunnel only, stack already running
pnpm cloudflare:tunnel --env-file .env.kitchntabs --env-suffix STAGING
pnpm cloudflare:tunnel --env-file .env.vanexa --env-suffix STAGING

# Status
docker compose --env-file .env.kitchntabs ps
docker compose --env-file .env.vanexa ps

# Stop (keeps DB data)
docker compose --env-file .env.kitchntabs down
docker compose --env-file .env.vanexa down

# Stop + wipe DB volumes (only when you actually want a clean DB)
docker compose --env-file .env.kitchntabs down -v
docker compose --env-file .env.vanexa down -v

# Recreate just the app container (picks up new env/image; resets vendor/ and any
# manually-copied-in file patches — anything not in domain/ or a host mount is lost)
#
# CRITICAL: if the running container is anything other than the default environment
# (staging, tunnel, ...), export ENV_FILE first — it controls which app env file gets
# bind-mounted as /var/www/dash/.env, and --env-file .env.<project> alone does NOT set
# it; without the export it silently falls back to the compose file's default
# (.env.<project>.local), swapping a staging container to local mode without any
# visible error (DB creds are often identical between the two, so this can hide for
# hours — confirmed happening for real on 2026-08-08, see README.md Troubleshooting).
export ENV_FILE=.env.kitchntabs.staging   # match whichever environment is actually running
docker compose --env-file .env.kitchntabs up -d --force-recreate app

export ENV_FILE=.env.vanexa.staging
docker compose --env-file .env.vanexa up -d --force-recreate app
```

---

## Supervisord processes (Horizon, Reverb, scheduler)

Lightest way to get a clean process state without losing the running container (vendor/, any
manually-copied-in files, etc.):

```bash
# Status
docker compose --env-file .env.kitchntabs exec app supervisorctl -c /etc/supervisor/supervisord.conf status
docker compose --env-file .env.vanexa exec app supervisorctl -c /etc/supervisor/supervisord.conf status

# Restart everything (horizon, reverb, schedule-run)
docker compose --env-file .env.kitchntabs exec app supervisorctl -c /etc/supervisor/supervisord.conf restart all
docker compose --env-file .env.vanexa exec app supervisorctl -c /etc/supervisor/supervisord.conf restart all

# Restart just one (name is <group>:<process>, see `status` output)
docker compose --env-file .env.kitchntabs exec app supervisorctl -c /etc/supervisor/supervisord.conf restart reverb:dash-reverb
docker compose --env-file .env.vanexa exec app supervisorctl -c /etc/supervisor/supervisord.conf restart horizon:dash-horizon
```

---

## Logs

**Live dashboard, all logs, both projects, one screen:**

```bash
pnpm exec pm2 monit
```

Each stream below is also its own pm2 app (`<project>-<laravel|horizon|reverb|container>-log`),
so `pm2 monit` shows all 8 as separate real-time panes. See
[PM2_AUTOMATION.md](./PM2_AUTOMATION.md#real-time-log-dashboard-pm2-monit) for how that's wired
up. The manual `docker compose exec ... tail -f` commands below still work standalone if you
just want one specific stream without pm2:

```bash
# Horizon (queue worker — job dispatch/processing)
docker compose --env-file .env.kitchntabs exec app tail -f /var/www/dash/storage/logs/supervisor-horizon.log /var/www/dash/storage/logs/supervisor-horizon-error.log
docker compose --env-file .env.vanexa exec app tail -f /var/www/dash/storage/logs/supervisor-horizon.log /var/www/dash/storage/logs/supervisor-horizon-error.log

# Reverb (websocket server — connections, subscriptions, broadcasts)
docker compose --env-file .env.kitchntabs exec app tail -f /var/www/dash/storage/logs/supervisor-reverb.log /var/www/dash/storage/logs/supervisor-reverb-error.log
docker compose --env-file .env.vanexa exec app tail -f /var/www/dash/storage/logs/supervisor-reverb.log /var/www/dash/storage/logs/supervisor-reverb-error.log

# Laravel application log
docker compose --env-file .env.kitchntabs exec app tail -f /var/www/dash/storage/logs/laravel.log
docker compose --env-file .env.vanexa exec app tail -f /var/www/dash/storage/logs/laravel.log

# nginx — confirms whether a request left the browser and reached the server at all
# (the fastest way to tell "client never sent it" apart from "server silently swallowed it")
docker compose --env-file .env.kitchntabs exec app tail -f /var/log/nginx/dash.access.log /var/log/nginx/dash.nginx.error.log
docker compose --env-file .env.vanexa exec app tail -f /var/log/nginx/dash.access.log /var/log/nginx/dash.nginx.error.log
```

---

## Reverb debug mode

Non-debug Reverb logs almost nothing beyond its startup line. `REVERB_DEBUG=true` in the
Laravel app env file (`.env.<project>.<environment>`, e.g. `.env.vanexa.staging`) makes
`entrypoint.sh` add `--debug` to the supervisord-managed `reverb:start` command automatically —
persists across restarts, no manual process juggling needed. Remember to turn it back off once
you're done: `--debug` logs every connection/message and will bloat the log file under real
traffic.

```bash
# after editing REVERB_DEBUG in the app env file, apply it with a container recreate.
# Export ENV_FILE matching whichever env file you just edited FIRST — see the warning
# on the force-recreate commands above, this is the same footgun.
export ENV_FILE=.env.vanexa.staging
docker compose --env-file .env.vanexa up -d --force-recreate app
```

---

## Composer / migrations (after `--force-recreate`)

`vendor/` is baked into the image, not host-mounted — it resets to the image baseline on
`--force-recreate`. Re-sync it with the live-mounted `domain/`:

```bash
docker compose --env-file .env.kitchntabs exec app composer install --no-interaction
docker compose --env-file .env.vanexa exec app composer install --no-interaction

docker compose --env-file .env.kitchntabs exec app php artisan migrate
docker compose --env-file .env.vanexa exec app php artisan migrate
```

---

## Redis / queue inspection

```bash
# Horizon status
docker compose --env-file .env.kitchntabs exec app php artisan horizon:status
docker compose --env-file .env.vanexa exec app php artisan horizon:status

# Pending jobs on the default queue
docker compose --env-file .env.kitchntabs exec app redis-cli -h redis LLEN queues:default
docker compose --env-file .env.vanexa exec app redis-cli -h redis LLEN queues:default

# Failed jobs
docker compose --env-file .env.kitchntabs exec app php artisan queue:failed
docker compose --env-file .env.vanexa exec app php artisan queue:failed
```

---

## Shell / tinker

```bash
docker compose --env-file .env.kitchntabs exec app bash
docker compose --env-file .env.vanexa exec app bash

docker compose --env-file .env.kitchntabs exec app php artisan tinker
docker compose --env-file .env.vanexa exec app php artisan tinker
```
