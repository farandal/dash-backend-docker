# dash-backend-image

This folder runs KitchnTabs backend using the Docker Hub image instead of building `dash-backend` locally.

It is pre-configured to use:
- Local env file: `../dash-backend/.env.kitchntabs.local`
- Domain folder: `../kitchntabs` (mounted at `/var/www/html/domain`)
- Core image: `farandal/dash-backend:1.0.0-core`

Image contract (required):
- The Docker image must already contain the full Laravel application at `/var/www/html`.
- At minimum, the image must include: `artisan`, `app/`, `bootstrap/`, `config/`, `database/`, `public/`, `routes/`, `storage/`, `vendor/`.
- This setup does not mount local backend source code.
- Use the `-core` tagged images (e.g., `farandal/dash-backend:1.0.0-core`, `farandal/dash-backend:latest-core`) built with `docker-publish-core.sh` in the dash-backend folder.

## Requirements

- Docker Desktop (or Docker Engine + Compose v2)
- Existing files/folders:
  - `../dash-backend/.env.kitchntabs.local`
  - `../kitchntabs`

## Start

From this directory:

```bash
docker compose up -d
```

## First-time app setup

```bash
docker compose exec app php artisan key:generate
docker compose exec app php artisan migrate --force
```

## Access URLs

- API: `http://localhost:18000`
- Mailhog UI: `http://localhost:18025`

Default ports in this folder are intentionally isolated so this stack can run side-by-side with your existing `dash-backend` stack.
Port variables are prefixed with `DBI_` to avoid collisions with exported vars from other stacks.

## Useful commands

```bash
# logs
docker compose logs -f app

# shell in app container
docker compose exec app bash

# stop stack
docker compose down
```

## Cloudflare tunnel

The image-only stack keeps the Cloudflare tunnel logic in this folder too. It runs on the host and forwards the published app port from `.env`.

Install Node dependencies once:

```bash
pnpm install
```

```bash
./scripts/cloudflare-tunnel.sh
# or
pnpm cloudflare:tunnel
```

Notes:
- Uses `APP_PORT` from `dash-backend-image/.env`.
- Uses `CF_TUNNEL_HOSTNAME=dev-local-api.kitchntabs.com` or `--hostname dev-local-api.kitchntabs.com`; if no named tunnel token is provided, it falls back to a quick `trycloudflare.com` URL.
- Falls back to a temporary `trycloudflare.com` URL if no hostname is configured.
- Updates `APP_URL` in `dash-backend-image/.env` by default.
- For a custom domain, set either `CF_TUNNEL_TOKEN_FILE` or `CF_TUNNEL_TOKEN` in `.env`.
- Named tunnel mode now starts with `--url http://localhost:$APP_PORT`, so you do not need a local ingress config file for basic HTTP forwarding.
- If named tunnel mode hits repeated QUIC dial timeout errors (common on restricted networks), it auto-falls back to a quick `trycloudflare.com` URL.
- Tune or disable this behavior with `CF_QUIC_ERROR_FALLBACK_ENABLED`, `CF_QUIC_ERROR_FALLBACK_COUNT`, and `CF_QUIC_ERROR_FALLBACK_WINDOW_SEC`.
- Optional DNS automation: if `CF_API_TOKEN` and (`CF_ZONE_ID` or `CF_ZONE_NAME`) are set, the script auto-creates/updates the CNAME for `CF_TUNNEL_HOSTNAME`.
- `CF_ZONE_ID` is recommended when zone-name lookup is restricted by token scope.
- `CF_TUNNEL_CNAME_TARGET` is optional. If omitted, the script derives `<tunnel-id>.cfargotunnel.com` from your tunnel token.
- `CF_API_TOKEN` is for Cloudflare API calls like DNS management. It does not replace the named tunnel token.
- `CF_TUNNEL_HOSTNAME` is the hostname to publish, not the tunnel credential itself.

## Testing

### First-time test database setup

The test suite uses a separate PostgreSQL database (`dash_db_test`) configured in `phpunit.xml`. Create it once before running tests:

```bash
docker-compose exec pgsql psql -U dashpanel -d kitchntabs_dev_db -c "CREATE DATABASE dash_db_test OWNER dashpanel;"
```

Tests use `RefreshDatabase`, so migrations run automatically on each test run — no separate migrate step is needed.

### `phpunit.xml` environment

| Variable | Value |
|---|---|
| `APP_ENV` | `testing` |
| `DB_CONNECTION` | `pgsql` |
| `DB_HOST` | `pgsql` |
| `DB_PORT` | `5432` |
| `DB_DATABASE` | `dash_db_test` |
| `CACHE_DRIVER` | `array` |
| `MAIL_MAILER` | `array` |
| `QUEUE_CONNECTION` | `sync` |
| `SESSION_DRIVER` | `array` |
| `TELESCOPE_ENABLED` | `false` |

### Running tests

```bash
# Run all tests
docker-compose exec app php artisan test

# Filter by class or method name
docker-compose exec app php artisan test --filter Auth
docker-compose exec app php artisan test --filter TenantAuthorizationTest

# Run a specific test suite
docker-compose exec app php artisan test --testsuite Core
docker-compose exec app php artisan test --testsuite Domain

# Wipe and re-seed test DB manually (optional, tests do this automatically)
docker-compose exec app php artisan migrate:fresh --seed --env=testing
```

> **Note:** `security_opt: seccomp:unconfined` must be set on the `app` service in `docker-compose.yml` (already configured) — otherwise `php artisan test` fails with `proc_open(): posix_spawn() failed`.

## Customization

Edit `.env` in this folder to change image tag, env file, domain path, or ports.

### Examples

```bash
# use latest core image
sed -i '' 's#^DASH_IMAGE=.*#DASH_IMAGE=farandal/dash-backend:latest-core#' .env

# point to another domain module
sed -i '' 's#^DOMAIN_PATH=.*#DOMAIN_PATH=../another-domain#' .env
```

## Docker and Laravel command reference

Run these from this folder (`dash-backend-image`).

```bash
# Start / stop / restart
docker-compose up -d
docker-compose down
docker-compose restart app

# Recreate app container only
docker-compose up -d --force-recreate app

# Show container status and logs
docker-compose ps
docker-compose logs -f app
docker-compose logs -f pgsql redis mailhog

# Shell access
docker-compose exec app bash
docker-compose exec pgsql psql -U "$DB_USERNAME" -d "$DB_DATABASE"
docker-compose exec redis redis-cli

# Laravel Artisan basics
docker-compose exec app php artisan optimize:clear
docker-compose exec app php artisan about
docker-compose exec app php artisan migrate --force
docker-compose exec app php artisan db:seed --force
docker-compose exec app php artisan route:list

# Queue / cache / tinker
docker-compose exec app php artisan queue:work --tries=1
docker-compose exec app php artisan cache:clear
docker-compose exec app php artisan config:clear
docker-compose exec app php artisan tinker

# Composer in container
docker-compose exec app composer install
docker-compose exec app composer dump-autoload

# Tests
# Note: requires security_opt: seccomp:unconfined in docker-compose.yml (already set)
docker-compose exec app php artisan test
docker-compose exec app php artisan test --filter SomeTestClass
docker-compose exec app php artisan migrate:fresh --seed --env=testing
docker-compose exec app php artisan test --env=testing

# Quick health checks
curl -I http://localhost:${DBI_APP_PORT:-25000}
curl -I http://localhost:${DBI_FORWARD_MAILHOG_DASHBOARD_PORT:-25026}
```
