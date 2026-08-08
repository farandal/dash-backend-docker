# Quick Setup — Local Dev (multi-domain)

Run the DASH backend locally. The stack supports three independent domains; pick the one
you're working on and run the matching pnpm command.

> **Full reference:** [README.md](./README.md) · **Dev cheatsheet:** [DASH-BACKEND-DOCKER-DEVELOPMENT.md](./DASH-BACKEND-DOCKER-DEVELOPMENT.md)

---

## TL;DR

```bash
# 1. Build the local core image (in dash-backend, once or after source changes)
cd ../dash-backend
docker build -f Dockerfile.core.production -t local/dash-backend-core:latest --build-arg INSTALL_DEV_DEPS=true .

# 2. Start the stack for your domain (in dash-backend-docker)
cd ../dash-backend-docker
pnpm dash:start vanexa local    # or:  fablabos / reddorada / kitchntabs

# 3. Install mounted domain packages (first run / after --force-recreate)
docker compose exec app composer update --no-interaction

# 4. Migrate + seed
docker compose exec app php artisan migrate:fresh --seed
```

Reverb and Horizon are **not** started manually — the image runs `supervisord`, which
auto-starts and auto-restarts both at container boot (see
`docker/app/custom-supervisor.conf`). To restart either after a code change:

```bash
docker compose exec app supervisorctl -c /etc/supervisor/supervisord.conf restart reverb horizon
```

API → http://localhost:25100 · WS test → http://localhost:26001/ws · Mailhog → http://localhost:25026

---

## Domains at a glance

| Domain | pnpm command | Compose env | App env | DB |
|---|---|---|---|---|
| **vanexa** | `pnpm dash:start vanexa local` | `.env.vanexa` | `.env.vanexa.local` | `kt_dev_db` |
| **fablabos** | `pnpm dash:start fablabos local` | `.env.fablabos` | `.env.fablabos.local` | `fl_dev_db` |
| **reddorada** | `pnpm dash:start reddorada local` | `.env.reddorada` | `.env.reddorada.local` | `rd_dev_db` |

Each domain uses a **pair** of env files:

- **`.env.<domain>`** — read by Docker Compose (`--env-file`): sets `DOMAIN_PATH`, `STORAGE_PATH`,
  `DB_*` credentials, ports, and Cloudflare tunnel config.
- **`.env.<domain>.local`** — mounted as `/var/www/dash/.env` inside the container: full Laravel
  application config.
- **`.env.<domain>.tunnel`** — tunnel-mode variant of the app env (overrides `APP_URL`,
  `REVERB_HOST`, `REVERB_PORT`, `REVERB_SCHEME` for public Cloudflare hostnames).
- **`.env.<domain>.staging`** — same idea, for the staging public hostnames
  (`api-staging.<domain>` / `ws-staging.<domain>`). Run with
  `pnpm dash:start <domain> staging --tunnel` — see
  [DASH-BACKEND-DOCKER-DEVELOPMENT.md](./DASH-BACKEND-DOCKER-DEVELOPMENT.md#cloudflare-tunnel)
  for how `--tunnel` and per-environment hostnames work.

All env files are gitignored. Copy the templates to create yours:

```bash
cp env.domain.example       .env.vanexa
cp env.domain.local.example .env.vanexa.local
# edit both files — fill in DB credentials, APP_KEY, domain-specific values
```

---

## Prerequisites

- Docker Desktop (or Docker Engine + Compose v2)
- Sibling repos checked out next to each other:

```
DASH-FRAMEWORK/
├── dash-backend/                    # Laravel core source + sail Dockerfile
├── dash-backend-docker/             # this project
├── vanexa-backend-domain/       # vanexa domain (optional)
├── fablabos-backend-domain/         # Fablabos domain (optional)
└── reddorada-backend-domain/        # Reddorada domain (optional)
```

---

## Step 1 — Build the local core image

The local image uses `Dockerfile.core.production` (nginx + php-fpm + supervisord, app at
`/var/www/dash`). `INSTALL_DEV_DEPS=true` keeps require-dev packages (Pint, Sail, Mockery,
Faker, Pest, etc.) in the image for local development.

```bash
cd ../dash-backend
docker build -f Dockerfile.core.production -t local/dash-backend-core:latest --build-arg INSTALL_DEV_DEPS=true .
```

`docker-compose.yml` defaults `DASH_IMAGE` to `local/dash-backend-core:latest`, so no
further config is needed. To run a published image instead, set
`DASH_IMAGE=farandal/dash-backend:<tag>-core` in `.env.<domain>`.

---

## Step 2 — Configure env files

Two files per domain; DB credentials must be identical in both.

**`.env.<domain>`** (Docker Compose level):

```ini
COMPOSE_PROJECT_NAME=dash_image

# DASH_IMAGE=local/dash-backend-core:latest   # default — uncomment to pin a published tag

ENV_FILE=.env.<domain>.local                  # Laravel app env mounted into the container
DOMAIN_PATH=../<domain>-backend-domain        # sibling domain repo path
STORAGE_PATH=./storage/<domain>-backend-domain

DB_DATABASE=<prefix>_dev_db
DB_DATABASE_TEST=<prefix>_dev_db_test
DB_USERNAME=<user>
DB_PASSWORD=<password>

DBI_APP_PORT=25000
DBI_FORWARD_DB_PORT=25432
DBI_FORWARD_REDIS_PORT=25379
DBI_REVERB_SERVER_PORT=25001
DBI_FORWARD_MAILHOG_PORT=25025
DBI_FORWARD_MAILHOG_DASHBOARD_PORT=25026
```

**`.env.<domain>.local`** (Laravel app level — mounted as `/var/www/dash/.env`):

```ini
APP_ENV=local
APP_DEBUG=true
APP_KEY=base64:...           # generate: docker compose exec app php artisan key:generate
APP_URL=http://localhost:25000

DB_CONNECTION=pgsql
DB_HOST=pgsql                # service name inside the compose network — NOT localhost
DB_PORT=5432
DB_DATABASE=<prefix>_dev_db  # MUST match .env.<domain>
DB_USERNAME=<user>           # MUST match .env.<domain>
DB_PASSWORD=<password>       # MUST match .env.<domain>
DB_DATABASE_TEST=<prefix>_dev_db_test

QUEUE_CONNECTION=redis
BROADCAST_DRIVER=reverb
REDIS_HOST=redis
REDIS_CLIENT=predis
REDIS_PASSWORD=null

REVERB_SERVER_HOST=0.0.0.0   # bind inside the container
REVERB_SERVER_PORT=26001
REVERB_HOST=localhost          # browser connects to ws://localhost:26001
REVERB_PORT=26001
REVERB_SCHEME=http
REVERB_APP_ID=mock_app
REVERB_APP_KEY=mock_key
REVERB_APP_SECRET=<secret>

MAIL_MAILER=smtp
MAIL_HOST=mailhog
MAIL_PORT=1025
```

> If `ENV_FILE` points at a file that doesn't exist, the app boots with no env. Verify the
> file exists before `docker compose up`.

---

## Step 3 — Start the stack

The launcher (`scripts/run-local.mjs`) selects `--env-file .env.<domain>` and opens separate
terminal windows for Reverb, Horizon, log tail, and tests:

```bash
pnpm dash:start vanexa local
pnpm dash:start fablabos local
pnpm dash:start reddorada local
```

Or call the script directly for any project/environment combination:

```bash
node scripts/run-local.mjs vanexa local
node scripts/run-local.mjs fablabos   tunnel
node scripts/run-local.mjs reddorada  production
```

On macOS/Linux this delegates to `scripts/run-local-mac.sh <project> <environment>`;
on Windows it calls `scripts/run-local.ps1`.

---

## Step 4 — Install the mounted domain's composer packages

```bash
docker compose exec app composer update --no-interaction
```

Re-run after any `docker compose up --force-recreate app` — the container's `vendor/`
resets to the image baseline on recreate.

---

## Step 5 — Migrate and seed

```bash
docker compose exec app php artisan migrate:fresh --seed
```

Seeded accounts come from the app env file (`SYSTEM_ADMIN_EMAIL`, `DEFAULT_TENANT_NAME`, etc.).

---

## Step 6 — Realtime workers

The launcher opens these in separate terminal windows automatically. If you need to restart
them manually:

```bash
docker compose exec app php artisan horizon
docker compose exec app php artisan reverb:start --debug
```

---

## Access

- API: http://localhost:25100
- WebSocket diagnostics: http://localhost:26001/ws
- Mailhog UI: http://localhost:25026

---

## Tests

```bash
docker compose exec app php artisan test --testsuite Core
docker compose exec app php artisan test --testsuite Domain
```

The test DB (`<prefix>_dev_db_test`) is created automatically by the `pgsql_setup` service.

---

## Switching between domains

The stack runs **one domain at a time**. To switch:

```bash
docker compose down -v                      # stop + wipe volumes (data is domain-specific)
pnpm dash:start <project> local             # restart with the new domain env
docker compose exec app php artisan migrate:fresh --seed
```

> `-v` is required: each domain has its own DB credentials and data. Without it, the
> postgres volume keeps the previous domain's data and the new credentials will fail.

---

## Dev vs Production

| | Local dev (this project) | Production |
|---|---|---|
| Core Dockerfile | `dash-backend/Dockerfile.core.production --build-arg INSTALL_DEV_DEPS=true` (nginx + php-fpm + supervisord, `/var/www/dash`, domain mounted) | `dash-backend/Dockerfile.core.production` (same Dockerfile, `INSTALL_DEV_DEPS=false`, domain baked) |
| Image tag | `local/...:latest` or `*-core` | `*-prod` |
| Domain | **mounted** live at `/var/www/dash/domain` | **baked** → ECR |
| Run by | `docker compose` here | ECS Fargate |
