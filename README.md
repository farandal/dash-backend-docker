# dash-backend-docker

## Quick commands:

- docker compose down -v --remove-orphans  
- pnpm dash:start kitchntabs.tunnel --tunnel

## Dash backend core (private repo)

- cd dash-backend
- docker build -f Dockerfile.core.production -t local/dash-backend-core:latest --build-arg INSTALL_DEV_DEPS=true .

Note: For local development is important INSTALL_DEV_DEPS=true

### Local startup scripts (Windows + macOS)

Preferred (pnpm orchestrates OS-specific launcher):
- `pnpm dash:start` (defaults to `.env.local`)
- `pnpm dash:start:production` (uses `.env.production`)
- `pnpm dash:start:env -- staging` (uses `.env.staging`)

- Windows (default `.env.local`):
  - `.\scripts\run-local.bat`
  - or `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-local.ps1 -Environment local`

- Windows with specific env file suffix (uses `.env.{environment}`):
  - `.\scripts\run-local.bat production` (uses `.env.production`)

- macOS (default `.env.local`):
  - `chmod +x ./scripts/run-local-mac.sh` (run once)
  - `bash ./scripts/run-local-mac.sh`

- macOS with specific env file suffix:
  - `bash ./scripts/run-local-mac.sh production` (uses `.env.production`)

Both scripts run the same startup flow:
- `docker compose down -v`
- `docker compose up -d`
- `docker compose exec app php artisan migrate`
- Open separate terminal windows for:
  - `docker compose exec app php artisan reverb:start`
  - `docker compose exec app php artisan horizon`
  - `docker compose exec app tail -f /var/www/dash/storage/logs/laravel.log`
  - `docker compose exec app php artisan test --testsuite=Core --log-junit /var/www/dash/reports/core_results.xml


## Dash backend docker useful commands (public container)

- docker compose down -v
- docker compose up -d

- docker compose exec app php artisan migrate:fresh --seed  

- docker compose exec app php artisan reverb:start --debug
- docker compose exec app php artisan horizon  

- docker compose exec app php artisan test --testsuite Core
- docker compose exec app php artisan test --testsuite Domain

- docker compose exec app php artisan test --testsuite=Core --log-junit /var/www/dash/reports/core_results.xml
- docker compose exec app php artisan test --testsuite=Domain --log-junit /var/www/dash/reports/domain_results.xml --no-ansi

- docker compose exec app tail -f /var/www/dash/storage/logs/laravel.log

# Overview
This folder runs the Dash backend using a pre-built Docker Hub image instead of building `dash-backend` locally.

It is pre-configured to use:
- App env file: `./.env.local` (mounted as `/var/www/dash/.env` inside the container)
- Domain folder: configured via `DOMAIN_PATH` in `.env` (mounted at `/var/www/dash/domain`)
- Core image: configured via `DASH_IMAGE` in `.env` (e.g. `farandal/dash-backend:1.0.0-core`)

Image contract (required):
- The Docker image must already contain the full Laravel application at `/var/www/dash`.
- At minimum, the image must include: `artisan`, `app/`, `bootstrap/`, `config/`, `database/`, `public/`, `routes/`, `storage/`, `vendor/`.
- This setup does not mount local backend source code — all app code comes from the image.
- Use the `-core` tagged images (e.g., `farandal/dash-backend:1.0.0-core`, `farandal/dash-backend:latest-core`) built with `docker-publish-core.sh` in the `dash-backend` folder.

---

## CI Build Flow — `dash-backend` → Docker Hub → `dash-backend-docker`

This section documents the complete pipeline for building the core image from the `dash-backend` source project and deploying it here.

### Architecture overview

```
dash-backend/                    ← Laravel source + Dockerfile.core + migrations
    └── docker-publish-core.sh   ← Build & push script
          │
          ▼
    Docker Hub
    farandal/dash-backend:<tag>  ← Immutable, versioned image
          │
          ▼
dash-backend-docker/             ← This folder: runtime only
    ├── docker-compose.yml       ← Consumes the image + mounts env + domain
    ├── .env                     ← Compose variables (image tag, paths, ports, DB creds)
    └── .env.local               ← App-level Laravel env (mounted as .env inside container)
```

The image bakes in:
- PHP 8.3 runtime (Ubuntu 24.04 noble)
- All PHP extensions (pgsql, redis, gd, intl, mbstring, xml, zip, xdebug, pcov, …)
- Composer `vendor/` directory
- Full Laravel application code (`app/`, `routes/`, `config/`, `database/`, `public/`, `resources/`, `storage/`)
- All database migrations

The image does **not** bake in:
- `.env` or `.env.*` files (excluded via `.dockerignore` — always mounted at runtime)
- `bootstrap/cache/*.php` (excluded to ensure runtime env is always used)
- `storage/` runtime content (logs, sessions, views, cache)
- `node_modules/`, `aws/`, markdown files

---

### Step 1 — Prepare the `dash-backend` source

From the `dash-backend` project root:

```bash
cd /path/to/dash-backend
```

Confirm `.dockerignore` excludes env files (critical — prevents local secrets from being baked into the image):

```
storage/app/*
storage/framework/cache/*
storage/framework/sessions/*
storage/framework/views/*
storage/logs/*
node_modules/*
cache/*
# Never bake env files into the image — they are mounted at runtime by docker-compose
.env
.env.*
!.env.example
# Never bake cached config into the image — it would override .env at runtime
bootstrap/cache/*.php
aws
*.md
DockerFile
docker.build.sh
```

> **Why this matters:** Laravel automatically loads `.env.{APP_ENV}` as an override on top of `.env`. If a local `.env.local` is baked into the image and `APP_ENV=local`, it will silently override all values from the mounted runtime env file, including credentials and tenant configuration.

---

### Step 2 — Build and push to Docker Hub

Use `docker-publish-core.sh` from the `dash-backend` project root. The script uses Docker Buildx for multi-architecture support.

#### Full syntax

```bash
./docker-publish-core.sh \
  --hub-user <dockerhub-username> \
  --tag <semver>-core \
  [--arch arm64|amd64] \
  [--platform linux/amd64,linux/arm64] \
  [--skip-push]
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--hub-user` | Yes | — | Docker Hub username or org |
| `--tag` | No | `latest-core` | Image tag (use semver, e.g. `1.0.0-core`) |
| `--arch` | No | both arches | Shorthand for `--platform linux/<arch>` |
| `--platform` | No | `linux/amd64,linux/arm64` | Full Buildx platform string |
| `--skip-push` | No | push enabled | Build and load locally only (single arch, no push) |

#### Option A — Multi-arch push (CI / production)

Builds for both `linux/amd64` and `linux/arm64` and pushes to Docker Hub.

```bash
./docker-publish-core.sh --hub-user farandal --tag 1.0.0-core
```

Expected output:

```
┌─────────────────────────────────────────────────┐
│  dash-backend-core  →  Docker Hub publish       │
├─────────────────────────────────────────────────┤
│  Image   : farandal/dash-backend:1.0.0-core     │
│  Platform: linux/amd64,linux/arm64              │
│  Push    : true                                 │
└─────────────────────────────────────────────────┘

You will need to be logged in to Docker Hub:
Username: farandal
Password:
Login Succeeded

[+] Building 111.2s (25/25) FINISHED  docker-container:dash-backend-core-builder
 => [internal] load build definition from Dockerfile.core                  0.0s
 => [internal] load metadata for docker.io/library/ubuntu:24.04            1.2s
 => CACHED [ 2/18] WORKDIR /var/www/dash                                   0.0s
 => CACHED [ 3/18] RUN ln -snf /usr/share/zoneinfo/UTC /etc/localtime      0.0s
 => CACHED [ 5/18] RUN rm -f /etc/apt/apt.conf.d/docker-clean ...          0.0s
 => CACHED [ 6/18] RUN apt-get install -y --no-install-recommends ...      0.0s
 => CACHED [10/18] RUN groupadd --force -g 20 sail                         0.0s
 => [16/18] COPY . /var/www/dash                                           9.9s
 => [17/18] RUN rm -f /var/www/dash/bootstrap/cache/*.php                  0.4s
 => [18/18] RUN mkdir -p /var/www/dash/storage/framework/...              35.9s
 => pushing manifest for docker.io/farandal/dash-backend:1.0.0-core       12.3s

✓ Done.
  Pushed: farandal/dash-backend:1.0.0-core

  Others can now run:
    docker pull farandal/dash-backend:1.0.0-core
```

#### Option B — Single-arch local load (M1 / arm64 development)

Builds for the host architecture only and loads the image into the local Docker daemon without pushing. Use this to test locally before releasing.

```bash
./docker-publish-core.sh --hub-user farandal --tag 1.0.0-core --arch arm64 --skip-push
```

Expected output:

```
┌─────────────────────────────────────────────────┐
│  dash-backend-core  →  Docker Hub publish       │
├─────────────────────────────────────────────────┤
│  Image   : farandal/dash-backend:1.0.0-core     │
│  Platform: linux/arm64                          │
│  Push    : false                                │
└─────────────────────────────────────────────────┘

Note: --skip-push uses --load which only supports the host platform (linux/arm64).
[+] Building 111.2s (25/25) FINISHED  docker-container:dash-backend-core-builder
 => CACHED [ 2/18] WORKDIR /var/www/dash                                   0.0s
 => ...
 => [16/18] COPY . /var/www/dash                                           9.9s
 => [17/18] RUN rm -f /var/www/dash/bootstrap/cache/*.php                  0.4s
 => [18/18] RUN mkdir -p /var/www/dash/storage/framework/...              35.9s
 => exporting to docker image format                                      60.7s
 => => exporting layers                                                   20.3s
 => => sending tarball                                                    40.4s
 => importing to docker                                                   20.9s

✓ Done.
```

Verify the image is loaded locally:

```bash
docker images farandal/dash-backend
```

Expected output:

```
REPOSITORY              TAG          IMAGE ID       CREATED         SIZE
farandal/dash-backend   1.0.0-core   5e60c93808b5   2 minutes ago   1.23GB
```

---

### Step 3 — Update `dash-backend-docker/.env`

Switch to this folder and update the image tag:

```bash
cd /path/to/dash-backend-docker
```

Edit `.env`:

```bash
COMPOSE_PROJECT_NAME=dash_image

# Docker Hub image
DASH_IMAGE=farandal/dash-backend:1.0.0-core

# App-level env file — mounted as /var/www/dash/.env inside the container
ENV_FILE=./.env.local

# Domain layer path — mounted as /var/www/dash/domain inside the container
# Set to the path of the domain module on the host (e.g. ../kitchntabs-domain)
DOMAIN_PATH=../dash-domain

# PostgreSQL credentials — MUST match DB_* values in .env.local exactly
DB_DATABASE=myappdb
DB_USERNAME=myappuser
DB_PASSWORD=12345678

# Host port bindings
APP_PORT=25000
DBI_APP_PORT=25000
DBI_FORWARD_DB_PORT=25432
DBI_FORWARD_REDIS_PORT=25379
DBI_FORWARD_MAILHOG_PORT=25025
DBI_FORWARD_MAILHOG_DASHBOARD_PORT=25026
DBI_REVERB_SERVER_PORT=25001
```

> **Important:** The `DB_DATABASE`, `DB_USERNAME`, and `DB_PASSWORD` values in `.env` are used to **initialize the PostgreSQL container**. They must be identical to the same keys inside `.env.local`. A mismatch means the container DB is initialized with different credentials than the app tries to use, causing connection failures.

---

### Step 4 — Configure `.env.local` (app-level environment)

`.env.local` is mounted as `/var/www/dash/.env` inside the container. It is the single source of truth for all Laravel configuration at runtime. It is excluded from git (`.gitignore` matches `*.env` and `.env.*`).

**Seeder-driven variables** — control what `migrate:fresh --seed` creates:

```bash
# System admin — full platform access
SYSTEM_ADMIN_EMAIL=admin@example.com
SYSTEM_ADMIN_PASSWORD=12345678

# Default tenant — created during the tenants table migration
DEFAULT_TENANT_NAME=MockTenant
DEFAULT_TENANT_PUBLIC_ID=00.000.000-0

# Tenancy admin — manages a tenancy account and its tenants
TENANCY_ADMIN_EMAIL=tenancy@example.com
TENANCY_ADMIN_PASSWORD=mock_password_1

# Tenant admin — manages a single tenant
TENANT_ADMIN_EMAIL=tenant@example.com
TENANT_ADMIN_PASSWORD=mock_password_2

# Normal user — basic access
NORMAL_USER_EMAIL=user@example.com
NORMAL_USER_PASSWORD=mock_password_3
```

**Database connection** (must match `.env`):

```bash
DB_CONNECTION=pgsql
DB_HOST=pgsql
DB_PORT=5432
DB_DATABASE=myappdb
DB_USERNAME=myappuser
DB_PASSWORD=12345678
```

> **Duplicate key warning:** dotenv reads files top-to-bottom; the **last** occurrence of a key wins. If `.env.local` has a `DEFAULT_TENANT_NAME` block near the top and another further down in a legacy config section, the last value is what Laravel sees. Run `grep -n "DEFAULT_TENANT_NAME" .env.local` to check.

---

### Step 5 — Start the stack

Tear down any previous state including volumes (required when DB credentials or image changed):

```bash
docker compose down -v
```

Expected output:

```
[+] down 8/8
 ✔ Container dash_image_app              Removed    1.5s
 ✔ Container dash_image_mailhog          Removed    1.3s
 ✔ Container dash_image_redis            Removed    0.4s
 ✔ Container dash_image_pgsql            Removed    0.3s
 ✔ Volume dash_image_dash-composer-cache Removed    0.0s
 ✔ Volume dash_image_dash-pgsql          Removed    0.1s
 ✔ Volume dash_image_dash-redis          Removed    0.0s
 ✔ Network dash_image_dash               Removed    0.2s
```

Start the stack:

```bash
docker compose up -d
```

Expected output (PostgreSQL health check takes ~30 s on first boot):

```
[+] up 8/8
 ✔ Network dash_image_dash               Created    0.0s
 ✔ Volume dash_image_dash-pgsql          Created    0.0s
 ✔ Volume dash_image_dash-redis          Created    0.0s
 ✔ Volume dash_image_dash-composer-cache Created    0.0s
 ✔ Container dash_image_redis            Started    0.4s
 ✔ Container dash_image_mailhog          Started    0.4s
 ✔ Container dash_image_pgsql            Healthy   30.9s
 ✔ Container dash_image_app              Started   31.0s
```

---

### Step 6 — Run migrations and seed

```bash
docker compose exec app php artisan migrate:fresh --seed
```

Expected migration output (every entry must show `DONE`):

```
  Dropping all tables .....................................................................  82.06ms DONE

   INFO  Preparing database.

  Creating migration table ................................................................   4.64ms DONE

   INFO  Running migrations.

  0000_00_00_000000_create_websockets_statistics_entries_table ..........................   2.61ms DONE
  0000_00_00_000000_rename_statistics_counters ..........................................   1.35ms DONE
  ...
  2026_02_25_220000_create_tenancy_system_marketplaces_table ............................   0.78ms DONE
  2026_02_25_220001_create_tenancy_system_point_of_sales_table ..........................   0.63ms DONE
```

Expected seeder output (values reflect `.env.local`):

```
   INFO  Seeding database.

  Database\Seeders\PermissionSeeder ................................................ DONE
  Database\Seeders\RoleSeeder ...................................................... DONE

  Database\Seeders\UserSeeder ...................................................... RUNNING
 • Tenancy (account) created: MockTenant Account (tenancy@example.com)
 • Default Tenant 'MockTenant' linked to Tenancy 'MockTenant Account'
 • System Admin associated with tenant: MockTenant
 • System Admin created: SYSTEM ADMIN (admin@example.com) - Role: System
 • Tenancy Admin associated with tenancy: MockTenant Account
 • Tenancy Admin associated with tenant: MockTenant
 • Tenancy Admin created: TENANCY ADMIN (tenancy@example.com) - Role: TenancyAdmin
 • Tenant Admin associated with tenant: MockTenant
 • Tenant Admin created: TENANT ADMIN (tenant@example.com) - Role: Tenant
 • Normal User associated with tenant: MockTenant
 • Normal User created: NORMAL USER (user@example.com) - Role: User
  Database\Seeders\UserSeeder ...................................................... DONE

  Database\Seeders\TenantSeeder .................................................... DONE
  Database\Seeders\SystemMarketplacesSeeder ........................................ DONE

DASH Sync Roles
Skipping db:sync_roles: command not available.

DASH Update Revisions
Skipping db:update_revisions: command not available.
```

> `db:sync_roles` and `db:update_revisions` are domain-layer commands. When no domain is mounted (`DOMAIN_PATH` points to a non-existent directory), they are silently skipped. This is expected behaviour for a core-only environment.

---

### Troubleshooting

#### Seeded tenant name or emails do not match `.env.local`

Laravel loads `.env.{APP_ENV}` as an override on top of `.env`. If `APP_ENV=local` and a `.env.local` was baked into the image (before the `.dockerignore` fix), it overrides the mounted values at runtime.

**Fix:** Ensure `dash-backend/.dockerignore` excludes `.env` and `.env.*`, then rebuild:

```bash
cd /path/to/dash-backend
# Confirm .dockerignore has: .env / .env.* / !.env.example
./docker-publish-core.sh --hub-user farandal --tag 1.0.0-core --arch arm64 --skip-push
```

Also check for duplicate key definitions inside `.env.local`:

```bash
grep -n "DEFAULT_TENANT_NAME\|TENANCY_ADMIN_EMAIL" .env.local
```

Any key defined more than once: the **last** occurrence wins.

#### `migrate:fresh` fails mid-way on a table (e.g. `currencies`)

A core migration calls `ALTER TABLE` on a table that was never created because its `CREATE TABLE` migration exists only in the domain layer and the domain is not mounted.

Check for missing creators in core:

```bash
grep -rl "currencies\|categories" /path/to/dash-backend/database/migrations/
```

If only `ALTER` migrations exist (no `CREATE`), copy the `create_<table>` migration from the domain layer into `dash-backend/database/migrations/` and rebuild the image.

#### Database connection refused / authentication failed

`DB_DATABASE`, `DB_USERNAME`, and `DB_PASSWORD` in `.env` are used to **initialize** the Postgres container. If these differ from the matching values in `.env.local`, the app cannot connect.

Fix: align both files, destroy the volume, and restart:

```bash
docker compose down -v
docker compose up -d
```

#### `add_image_path_to_categories_table` completes without the `categories` table existing

This migration has an explicit `Schema::hasTable('categories')` guard and silently no-ops when the table does not exist. This is intentional — the migration is safe to include in core. Categories are provided by the domain layer.

---

## Requirements

- Docker Desktop (or Docker Engine + Compose v2)
- Existing files:
  - `./.env.local` (copy from `.env.example` and fill in your values)
  - `DOMAIN_PATH` directory on the host (optional — stack works without it, domain features disabled)

## Start

```bash
docker compose up -d
```

## First-time database setup

```bash
docker compose exec app php artisan migrate:fresh --seed
```

## Access URLs

- API: `http://localhost:25000` (or `http://localhost:${DBI_APP_PORT}`)
- Mailhog UI: `http://localhost:25026` (or `http://localhost:${DBI_FORWARD_MAILHOG_DASHBOARD_PORT}`)

Default ports are prefixed with `DBI_` in `.env` to avoid collisions with other stacks running on the same machine.

## Useful commands

```bash
# Follow logs
docker compose logs -f app

# Shell in app container
docker compose exec app bash

# Artisan
docker compose exec app php artisan optimize:clear
docker compose exec app php artisan route:list
docker compose exec app php artisan tinker

# Stop stack (preserve volumes)
docker compose down

# Stop stack and wipe all data
docker compose down -v
```

## Cloudflare tunnel

The Cloudflare tunnel script runs on the host and forwards the published app port from `.env`.

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
- Uses `APP_PORT` from `.env`.
- Uses `CF_TUNNEL_HOSTNAME` for the public domain; falls back to a temporary `trycloudflare.com` URL if not set.
- Set `CF_TUNNEL_TOKEN_FILE` or `CF_TUNNEL_TOKEN` for a named Cloudflare tunnel.
- Optional DNS automation: set `CF_API_TOKEN` + `CF_ZONE_ID` (or `CF_ZONE_NAME`) to auto-create/update the CNAME.
- QUIC fallback: if named tunnel hits repeated QUIC dial timeouts, it auto-falls back to `trycloudflare.com`. Tune with `CF_QUIC_ERROR_FALLBACK_ENABLED`, `CF_QUIC_ERROR_FALLBACK_COUNT`, `CF_QUIC_ERROR_FALLBACK_WINDOW_SEC`.

## Testing

### Prerequisites

The image must contain dev dependencies (`phpunit/phpunit`, `nunomaduro/collision`) for `php artisan test` to register the `test` command. If `php artisan test` prints the artisan help screen with only `test:image-agent` and `test:openai-raw` listed, the test runner is missing.

Verify quickly:

```bash
docker compose exec app bash -c "test -f /var/www/dash/vendor/bin/phpunit && echo OK || echo MISSING"
docker compose exec app php artisan | grep -E '^\s+test\s'
```

If missing, install dev dependencies inside the container:

```bash
docker compose exec app composer install --no-interaction
```

> Note: the post-install scripts run `php artisan key:generate`, which mutates `APP_KEY` in your mounted `.env.local`. Stash the current key beforehand if you have encrypted data, sessions, or signed URLs that depend on a stable value.

For a permanent fix, ensure the published image bakes dev deps (`Dockerfile.core` runs `composer install --no-scripts` — drop `--no-dev` if you need `artisan test` out of the box).

### Test suite layout

`phpunit.xml` (in the image at `/var/www/dash/phpunit.xml`) defines two suites:

| Suite | Directory | Contents |
|---|---|---|
| `Core` | `./tests` | Tests baked into the image — exercise core models, services, and a small set of feature tests. |
| `Domain` | `./domain/tests` | Tests loaded from the mounted `${DOMAIN_PATH}` (e.g. `../fablabos/tests/`). |

Domain tests typically extend base classes from `Tests\Feature\...` in core. If you see `Class not found` errors for a `Tests\...` class, the domain repo is likely importing a stale namespace path that was renamed in core.

### First-time test database setup

The test database name comes from `DB_DATABASE_TEST` in `.env.local` (mounted as the container's `.env`). It is **not** automatically derived from `DB_DATABASE` + `_test` — both keys must be set explicitly and the test DB must exist.

1. Confirm `.env.local` has matching values:

   ```bash
   DB_DATABASE=dash_dev_db
   DB_DATABASE_TEST=dash_dev_db_test
   ```

2. Create the test database (using the same values from your `.env.local`):

   ```bash
   docker compose exec pgsql psql -U "$DB_USERNAME" -d "$DB_DATABASE" -c "CREATE DATABASE ${DB_DATABASE}_test OWNER $DB_USERNAME;"
   ```

Tests use `RefreshDatabase` — migrations run automatically per test run, so you do not need to migrate the test DB manually.

### Running tests

```bash
# All tests (both suites)
docker compose exec app php artisan test

# Filter by class or method
docker compose exec app php artisan test --filter Auth
docker compose exec app php artisan test --filter TenantAuthorizationTest

# By suite
docker compose exec app php artisan test --testsuite Core
docker compose exec app php artisan test --testsuite Domain

# Single file
docker compose exec app php artisan test tests/Unit/UuidV7Test.php

# Direct phpunit (bypass Laravel's wrapper)
docker compose exec app vendor/bin/phpunit --testsuite Core
```

> `security_opt: seccomp:unconfined` must be set on the `app` service (already configured) — otherwise `php artisan test` fails with `proc_open(): posix_spawn() failed`.

### Testing troubleshooting

#### `php artisan test` shows artisan help instead of running tests

The `test` command is provided by `nunomaduro/collision` (a dev dep). The image was built or installed with `--no-dev`. Fix by re-running `composer install` without `--no-dev` (see Prerequisites above).

#### `database "<name>_test" does not exist`

Either the test database was never created, or `DB_DATABASE_TEST` in `.env.local` points to a name that does not exist on the Postgres container. Verify both, then create the database with the `psql ... CREATE DATABASE` command above.

#### `Class "Tests\Feature\…" not found` when running the Domain suite

A domain test extends a core base class via `use Tests\Feature\X\Y` — but the path has been renamed in core (for example `Tests\Feature\API\Auth\...` → `Tests\Feature\DASH\Auth\...`). Update the import in the domain test, and move the domain test file to mirror the new path so the namespace matches PSR-4.

#### `Class "Domain\Database\Factories\…" not found`

Core models call `factory()` expecting a factory in the domain layer that is not present. Either add the missing factory to the domain repo, or skip the affected test until the domain catches up.

## Customization

Edit `.env` in this folder to change image tag, env file path, domain path, or ports.

```bash
# Switch to a new image tag after a build
sed -i '' 's#^DASH_IMAGE=.*#DASH_IMAGE=farandal/dash-backend:1.1.0-core#' .env

# Point to a different domain module
sed -i '' 's#^DOMAIN_PATH=.*#DOMAIN_PATH=../another-domain#' .env
```

## Full Docker and Artisan reference

```bash
# Start / stop / restart
docker compose up -d
docker compose down
docker compose down -v            # also wipes volumes
docker compose restart app

# Recreate app container only (picks up image changes without full down/up)
docker compose up -d --force-recreate app

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
docker compose exec app composer dump-autoload

# Quick health checks
curl -I http://localhost:${DBI_APP_PORT:-25000}
curl -I http://localhost:${DBI_FORWARD_MAILHOG_DASHBOARD_PORT:-25026}
```
