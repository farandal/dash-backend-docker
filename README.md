# DASH Development Setup

This guide covers the full reference for the local DASH backend stack.

> **New here?** Start with [QUICK_SETUP.md](./QUICK_SETUP.md) for the condensed flow.
>
> **Dev vs Production:** local dev and production both build from the same lineage —
> `dash-backend/Dockerfile.core.production` (nginx + php-fpm + supervisord, app at
> `/var/www/dash`). For local dev, pass `--build-arg INSTALL_DEV_DEPS=true` to keep
> require-dev packages in the image; the domain is still mounted live via
> docker-compose.yml, unlike a real production build where it's baked in.

---

## Multi-domain architecture

The stack supports three independent domains. Each domain is a self-contained Laravel tenant
layer mounted on top of the shared `dash-backend` core:

| Domain | pnpm shortcut | Compose env | App env | Domain repo | DB |
|---|---|---|---|---|---|
| **vanexa** | `pnpm dash:vanexa:local` | `.env.vanexa` | `.env.vanexa.local` | `../vanexa-backend-domain` | `kt_dev_db` |
| **fablabos** | `pnpm dash:fablabos:local` | `.env.fablabos` | `.env.fablabos.local` | `../fablabos-backend-domain` | `fl_dev_db` |
| **reddorada** | `pnpm dash:reddorada:local` | `.env.reddorada` | `.env.reddorada.local` | `../reddorada-backend-domain` | `rd_dev_db` |
| **kitchntabs** | `pnpm dash:kitchntabs:local` | `.env.kitchntabs` | `.env.kitchntabs.local` | `../kitchntabs-backend-domain` | `kt_dev_db` |

### Env file pairs

Each domain uses two env files (both gitignored — copy from the example templates):

```
env.domain.example        →  .env.<domain>        (Docker Compose level)
env.domain.local.example  →  .env.<domain>.local  (Laravel app level)
```

- **`.env.<domain>`** — consumed by `docker compose --env-file`: controls `DOMAIN_PATH`,
  `STORAGE_PATH`, `DB_*` creds, port mappings, and Cloudflare tunnel config. The script
  passes this file explicitly; Docker Compose does **not** auto-load it (only a literal `.env`
  is auto-loaded, which is not present here by design).
- **`.env.<domain>.local`** — mounted as `/var/www/dash/.env` inside the container. This is
  the single source of truth for all Laravel configuration at runtime.
- **`.env.<domain>.tunnel`** — variant of the app env for Cloudflare tunnel mode. Overrides
  `APP_URL`, `REVERB_HOST`, `REVERB_PORT`, and `REVERB_SCHEME` for the public hostnames
  (`api-dev.<domain>.com`, `ws-dev.<domain>.com`).

> **Critical:** `DB_DATABASE`, `DB_USERNAME`, and `DB_PASSWORD` must be **identical** in
> `.env.<domain>` (used to initialize the Postgres container) and `.env.<domain>.local`
> (used by Laravel to connect). A mismatch causes authentication failures.

### Switching domains

The stack runs **one domain at a time**. To switch:

```bash
docker compose down -v               # wipe the Postgres volume (data is domain-specific)
pnpm dash:fablabos:local            # restart with the new domain
docker compose exec app php artisan migrate:fresh --seed
```

---

## Quick Start

```bash
# 1. Build the local core (in dash-backend)
cd ../dash-backend
docker build -f Dockerfile.core.production -t local/dash-backend-core:latest --build-arg INSTALL_DEV_DEPS=true .

# 2. Start the stack (in dash-backend-docker)
cd ../dash-backend-docker
pnpm dash:vanexa:local   # or fablabos / reddorada / kitchntabs

# 3. Pull mounted domain packages into the container
docker compose exec app composer update --no-interaction

# 4. Migrate + seed
docker compose exec app php artisan migrate:fresh --seed
```

---

## pnpm scripts reference

```bash
# Domain-specific launchers
pnpm dash:vanexa:local       # vanexa — local dev
pnpm dash:vanexa:tunnel      # vanexa — with Cloudflare tunnel
pnpm dash:vanexa:production  # vanexa — production image

pnpm dash:fablabos:local
pnpm dash:fablabos:tunnel
pnpm dash:fablabos:production

pnpm dash:reddorada:local
pnpm dash:reddorada:tunnel
pnpm dash:reddorada:production

pnpm dash:kitchntabs:local
pnpm dash:kitchntabs:tunnel
pnpm dash:kitchntabs:production

# Generic launcher — no default project is baked in, always pass one explicitly
pnpm dash:start -- <project> <environment>

# Tunnel only (stack already running)
pnpm cloudflare:tunnel:vanexa
pnpm cloudflare:tunnel:fablabos
pnpm cloudflare:tunnel:reddorada
pnpm cloudflare:tunnel:kitchntabs

# API docs
pnpm docs:generate
pnpm docs:start
```

You can also call the cross-platform launcher directly:

```bash
node scripts/run-local.mjs <project> <environment>
# <project>     : vanexa | fablabos | reddorada | kitchntabs
# <environment> : local | tunnel | production  (or any suffix matching .env.<domain>.<suffix>)
```

---

## Post-startup commands

### Install mounted domain packages (first run / after `--force-recreate`)

```bash
docker compose exec app composer update --no-interaction
```

The core image ships the majority of domain packages; any extras declared in
`domain/composer.json` (e.g. `box/spout`) are resolved here via the `composer-merge-plugin`.
Re-run after any `--force-recreate` because recreating the container resets `vendor/` to the
image baseline.

> `endroid/qr-code` is pinned to `^5.0` in the domain. Do not bump to `^6.0` — it conflicts
> with the core's `^5.1.0` and breaks QR generation.

### Seeding

```bash
docker compose exec app php artisan migrate:fresh --seed
```

### Generate APP_KEY (if missing)

```bash
docker compose exec app php artisan key:generate
```

### Regenerate media library

```bash
docker compose exec app php artisan media-library:regenerate
```

---

## Verification

- **API:** http://localhost:25100
- **WebSocket diagnostics:** http://localhost:26001/ws
- **Mailhog UI:** http://localhost:25026
- **Test reports:** `reports/core_results_<domain>.xml`, `reports/domain_results.xml`

---

## Quick reference commands

| Action | Command |
|---|---|
| **Stop (preserve data)** | `docker compose down` |
| **Stop + wipe DB** | `docker compose down -v` |
| **Check logs** | `docker compose logs -f app` |
| **Clear runtime cache** | `docker compose exec app php artisan optimize:clear` |
| **Tinker** | `docker compose exec app php artisan tinker` |
| **Run Core tests** | `docker compose exec app php artisan test --testsuite Core` |
| **Run Domain tests** | `docker compose exec app php artisan test --testsuite Domain` |

---

## CI Build Flow — `dash-backend` → Docker Hub → `dash-backend-docker`

### Architecture overview

```
dash-backend/                    ← Laravel source + Dockerfile.core.production + migrations
    └── docker-publish-core.sh   ← Build & push script
          │
          ▼
    Docker Hub
    farandal/dash-backend:<tag>  ← Immutable, versioned image
          │
          ▼
dash-backend-docker/             ← This folder: runtime only
    ├── docker-compose.yml       ← Consumes the image + mounts env + domain
    ├── .env.<domain>            ← Compose variables (image tag, paths, ports, DB creds)
    └── .env.<domain>.local      ← App-level Laravel env (mounted as .env inside container)
```

The image bakes in:
- PHP 8.3 runtime (Ubuntu 24.04 noble)
- All PHP extensions (pgsql, redis, gd, intl, mbstring, xml, zip, xdebug, pcov, …)
- Composer `vendor/` directory
- Full Laravel application code (`app/`, `routes/`, `config/`, `database/`, `public/`, `resources/`, `storage/`)
- All database migrations

The image does **not** bake in:
- `.env` or `.env.*` files (excluded via `.dockerignore` — always mounted at runtime)
- `bootstrap/cache/*.php` (excluded so runtime env is always used)
- `storage/` runtime content (logs, sessions, views, cache)
- `node_modules/`, `aws/`, markdown files

### Step 1 — Prepare the `dash-backend` source

Confirm `.dockerignore` excludes env files:

```
.env
.env.*
!.env.example
bootstrap/cache/*.php
```

> If a local `.env.local` is baked into the image and `APP_ENV=local`, Laravel auto-loads it
> as an override over the mounted runtime env — silently replacing credentials. The
> `.dockerignore` prevents this.

### Step 2 — Build and push to Docker Hub

```bash
cd /path/to/dash-backend

# Multi-arch push (CI / production)
./docker-publish-core.sh --hub-user farandal --tag 1.0.0-core

# Single-arch local load (M1 / arm64 dev — no push)
./docker-publish-core.sh --hub-user farandal --tag 1.0.0-core --arch arm64 --skip-push
```

| Flag | Default | Description |
|---|---|---|
| `--hub-user` | required | Docker Hub username or org |
| `--tag` | `latest-core` | Image tag (use semver, e.g. `1.0.0-core`) |
| `--arch` | both | Shorthand for `--platform linux/<arch>` |
| `--platform` | `linux/amd64,linux/arm64` | Full Buildx platform string |
| `--skip-push` | push enabled | Build + load locally only (single arch) |

### Step 3 — Update `.env.<domain>`

```ini
DASH_IMAGE=farandal/dash-backend:1.0.0-core
```

### Step 4 — Configure `.env.<domain>.local`

Key seeder-driven variables:

```ini
SYSTEM_ADMIN_EMAIL=admin@example.com
SYSTEM_ADMIN_PASSWORD=...
DEFAULT_TENANT_NAME=MockTenant
DEFAULT_TENANT_PUBLIC_ID=00.000.000-0
TENANCY_ADMIN_EMAIL=tenancy@example.com
TENANCY_ADMIN_PASSWORD=...
TENANT_ADMIN_EMAIL=tenant@example.com
TENANT_ADMIN_PASSWORD=...
NORMAL_USER_EMAIL=user@example.com
NORMAL_USER_PASSWORD=...
```

> **Duplicate key warning:** dotenv reads top-to-bottom; the **last** occurrence of a key wins.
> Run `grep -n "KEY_NAME" .env.<domain>.local` to detect duplicates.

### Step 5 — Start the stack

```bash
docker compose down -v
pnpm dash:<domain>:local
```

### Step 6 — Run migrations and seed

```bash
docker compose exec app php artisan migrate:fresh --seed
```

---

## Requirements

- Docker Desktop (or Docker Engine + Compose v2)
- `.env.<domain>` and `.env.<domain>.local` (copy from `env.domain.example` and `env.domain.local.example`)
- Domain repo at `DOMAIN_PATH` (optional — stack works without it, domain features disabled)

---

## Cloudflare tunnel

### Single-hostname mode (legacy)

Set `CF_TUNNEL_HOSTNAME` and `CF_TUNNEL_TOKEN` in `.env.<domain>`, then:

```bash
pnpm cloudflare:tunnel:<domain>
```

### Multi-hostname mode (api-dev + ws-dev)

One named tunnel serves multiple public hostnames. Active automatically when any
`CF_TUNNEL_HOSTNAME_<SLOT>` is non-empty in `.env.<domain>`.

**One-time Cloudflare setup:**
1. Create an API token with **Cloudflare Tunnel → Edit** and **DNS → Edit** permissions.
2. Find your **Account ID** in the Cloudflare dashboard sidebar.

**`.env.<domain>` tunnel variables:**

```ini
CF_API_TOKEN=<your api token>
CF_ACCOUNT_ID=<your account id>
CF_ZONE_NAME=<domain>.com
CF_TUNNEL_NAME=<domain>-dev       # created/looked up automatically

CF_TUNNEL_HOSTNAME_API=api-dev.<domain>.com
CF_TUNNEL_LOCAL_API=http://localhost:25100

CF_TUNNEL_HOSTNAME_WS=ws-dev.<domain>.com
CF_TUNNEL_LOCAL_WS=http://localhost:25001

# CF_TUNNEL_TOKEN is written back automatically after first run — leave blank initially
```

**`.env.<domain>.tunnel`** (the Laravel app env for tunnel mode):

```ini
APP_URL=https://api-dev.<domain>.com
REVERB_HOST=ws-dev.<domain>.com
REVERB_PORT=443
REVERB_SCHEME=https
```

**Run:**

```bash
pnpm dash:<domain>:tunnel
# or, if the stack is already running:
pnpm cloudflare:tunnel:<domain>
```

What the script does in multi-route mode:
1. Creates/looks up the named tunnel via the Cloudflare API and writes its token back to
   `.env.<domain>` as `CF_TUNNEL_TOKEN`.
2. Pushes an ingress config (api-dev → local API, ws-dev → local Reverb, catch-all 404).
3. Creates/updates proxied CNAMEs pointing at `<tunnel-id>.cfargotunnel.com`.
4. Runs `cloudflared tunnel run --token-file ...` pulling the ingress rules just pushed.

QUIC fallback tuning:

```ini
CF_QUIC_ERROR_FALLBACK_ENABLED=1
CF_QUIC_ERROR_FALLBACK_COUNT=3
CF_QUIC_ERROR_FALLBACK_WINDOW_SEC=30
```

---

## Testing

### Prerequisites

Dev dependencies (`phpunit/phpunit`, `nunomaduro/collision`) must be present in `vendor/`.
Verify:

```bash
docker compose exec app bash -c "test -f /var/www/dash/vendor/bin/phpunit && echo OK || echo MISSING"
docker compose exec app php artisan | grep -E '^\s+test\s'
```

If missing:

```bash
docker compose exec app composer install --no-interaction
```

> `composer install` triggers `php artisan key:generate`, which rewrites `APP_KEY` in your
> mounted `.env.<domain>.local`. Stash the current key if you have encrypted data.

### Test suite layout

| Suite | Directory | Contents |
|---|---|---|
| `Core` | `./tests` | Tests baked into the image — core models, services, feature tests |
| `Domain` | `./domain/tests` | Tests from the mounted `DOMAIN_PATH` |

### Running tests

```bash
docker compose exec app php artisan test                     # all suites
docker compose exec app php artisan test --testsuite Core
docker compose exec app php artisan test --testsuite Domain
docker compose exec app php artisan test --filter Auth
docker compose exec app vendor/bin/phpunit --testsuite Core  # direct phpunit
```

> `security_opt: seccomp:unconfined` is required on the `app` service (already set in
> `docker-compose.yml`) — otherwise `php artisan test` fails with
> `proc_open(): posix_spawn() failed`.

---

## Troubleshooting

### Seeded data doesn't match `.env.<domain>.local`

Laravel auto-loads `.env.{APP_ENV}` as an override on top of `.env`. If a `.env.local` was
baked into the image (before the `.dockerignore` fix), it silently overrides the mounted file.

Fix: ensure `dash-backend/.dockerignore` excludes `.env.*`, rebuild the image.

Also check for duplicate keys:

```bash
grep -n "DEFAULT_TENANT_NAME\|TENANCY_ADMIN_EMAIL" .env.<domain>.local
```

### `migrate:fresh` fails on a missing table

A core migration calls `ALTER TABLE` on a table whose `CREATE TABLE` lives only in the domain
layer and the domain is not mounted. Copy the `create_<table>` migration from the domain into
`dash-backend/database/migrations/` and rebuild the image.

### Database connection refused / authentication failed

`DB_*` creds in `.env.<domain>` initialize the Postgres container. If they differ from
`.env.<domain>.local`, the app can't connect. Align both files, then:

```bash
docker compose down -v && pnpm dash:<domain>:local
```

### PostgreSQL port not listening on macOS host

Docker Desktop on macOS sometimes doesn't forward container ports. Use `docker compose exec`
instead of direct TCP:

```bash
docker compose exec -T pgsql psql -U <user> -d <db>
```

For external tools (IDE DB clients), use the socat bridge:

```bash
docker run -it --rm -v /var/run/docker.sock:/var/run/docker.sock \
  alpine/socat TCP-LISTEN:5432,reuseaddr,fork DOCKER:${COMPOSE_PROJECT_NAME}_pgsql:5432
# then connect your tool to localhost:5432
```

### `php artisan test` shows artisan help instead of running

The `test` command is provided by `nunomaduro/collision` (a dev dep). Run
`composer install --no-interaction` to install it.

### `database "<name>_test" does not exist`

The `pgsql_setup` service creates the test DB automatically on first boot. If it's missing,
check `DB_DATABASE_TEST` in both env files and verify the `pgsql_setup` service completed
its healthcheck.

### `Class "Tests\Feature\…" not found` (Domain suite)

A domain test extends a core base class whose namespace was renamed. Update the import path
in the domain test and move the file to mirror the new namespace.

---

## Full Docker and Artisan reference

```bash
# Start / stop / restart
pnpm dash:<domain>:local         # preferred — sets --env-file automatically
docker compose up -d             # manual (requires ENV_FILE exported or set in shell)
docker compose down
docker compose down -v           # also wipes volumes
docker compose restart app
docker compose up -d --force-recreate app   # pick up image changes without full down/up

# Status and logs
docker compose ps
docker compose logs -f app
docker compose logs -f pgsql redis mailhog

# Shell access
docker compose exec app bash
docker compose exec pgsql psql -U "$DB_USERNAME" -d "$DB_DATABASE"
docker compose exec redis redis-cli

# Artisan
docker compose exec app php artisan optimize:clear
docker compose exec app php artisan about
docker compose exec app php artisan migrate --force
docker compose exec app php artisan migrate:fresh --seed
docker compose exec app php artisan db:seed --force
docker compose exec app php artisan route:list
docker compose exec app php artisan queue:work --tries=1
docker compose exec app php artisan cache:clear
docker compose exec app php artisan config:clear
docker compose exec app php artisan tinker

# Composer
docker compose exec app composer install
docker compose exec app composer update --no-interaction
docker compose exec app composer dump-autoload

# Quick health checks
curl -I http://localhost:${DBI_APP_PORT:-25000}
curl -I http://localhost:${DBI_FORWARD_MAILHOG_DASHBOARD_PORT:-25026}
```

---

## Customization

Switch image tag:

```bash
sed -i '' 's#^DASH_IMAGE=.*#DASH_IMAGE=farandal/dash-backend:1.1.0-core#' .env.<domain>
```

Point to a different domain repo:

```bash
sed -i '' 's#^DOMAIN_PATH=.*#DOMAIN_PATH=../another-domain#' .env.<domain>
```

---

## Publishing core image with npm packages

```bash
pnpm dash:build:core               # build image + publish npm packages
pnpm dash:build:core:skip-publish  # rebuild image without republishing packages
```

---

## DBeaver connection (local PostgreSQL)

| Field | Value |
|---|---|
| Server Host | `localhost` or `127.0.0.1` |
| Port | `25432` (mapped from `DBI_FORWARD_DB_PORT`) |
| Database | per domain: `kt_dev_db` / `fl_dev_db` / `rd_dev_db` |
| Username | `kt` (or your `DB_USERNAME`) |
| Password | your `DB_PASSWORD` |

If port 25432 isn't reachable (Docker Desktop port forwarding disabled), use:

```bash
docker compose exec -T pgsql psql -U kt -d kt_dev_db
```

Or set up the socat bridge (see Troubleshooting above).
