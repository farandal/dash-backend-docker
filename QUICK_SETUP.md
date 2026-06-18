# Quick Setup — Local Dev (core image + mounted domain)

Run the DASH backend locally using the **sail core image** with your **domain mounted live** for editing.
This is the local-development lineage and is fully separate from production (see "Dev vs Production" below).

> TL;DR
> ```bash
> # 1. build the local core (in dash-backend)
> cd ../dash-backend
> docker build -f docker/php8.3/Dockerfile.core -t local/dash-backend-core:latest --build-arg OBFUSCATE_APP=false .
>
> # 2. start the stack (in dash-backend-docker)
> cd ../dash-backend-docker
> docker compose up -d
>
> # 3. pull the mounted domain's composer packages into the container (e.g. box/spout)
> docker compose exec app composer update --no-interaction
>
> # 4. migrate + seed
> docker compose exec app php artisan migrate:fresh --seed
>
> # 5. start realtime workers (separate terminals)
> docker compose exec app php artisan horizon
> docker compose exec app php artisan reverb:start --debug
> ```
> API → http://localhost:25000 · WS test → http://localhost:25000/ws · Mailhog → http://localhost:25026

---

## Prerequisites

- Docker Desktop (or Docker Engine + Compose v2)
- The three sibling repos checked out next to each other:
  ```
  DASH-FRAMEWORK/
  ├── dash-backend/                 # Laravel core (source + sail Dockerfile)
  ├── kitchntabs-backend-domain/    # the domain (mounted live)
  └── dash-backend-docker/          # this runtime project
  ```

---

## Step 1 — Build the local core image

The local image is the **sail** core (`php -S` dev server, app at `/var/www/html`, EXPOSE 8000).
`OBFUSCATE_APP=false` keeps the source readable for debugging.

```bash
cd ../dash-backend
docker build -f docker/php8.3/Dockerfile.core -t local/dash-backend-core:latest --build-arg OBFUSCATE_APP=false .
```

`docker-compose.yml` defaults `DASH_IMAGE` to `local/dash-backend-core:latest`, so you don't need to set it.
(To run a published image instead, set `DASH_IMAGE=farandal/dash-backend:<tag>-core` in `.env`.)

---

## Step 2 — Configure env files

Two files, two consumers — keep the DB credentials identical in both.

**`.env`** (Docker Compose variables):
```ini
COMPOSE_PROJECT_NAME=dash_image

# App-level Laravel env mounted as /var/www/html/.env  (must be a real file on disk)
ENV_FILE=./.env.local

# Domain mounted at /var/www/html/domain
DOMAIN_PATH=../kitchntabs-backend-domain

# Used to INITIALIZE the postgres container — must match .env.local exactly
DB_DATABASE=kt_dev_db
DB_DATABASE_TEST=kt_dev_db_test
DB_USERNAME=kt
DB_PASSWORD=kt5663...

# Host ports (DBI_ prefix avoids collisions with other stacks)
DBI_APP_PORT=25000
DBI_FORWARD_DB_PORT=25432
DBI_FORWARD_REDIS_PORT=25379
DBI_FORWARD_MAILHOG_PORT=25025
DBI_FORWARD_MAILHOG_DASHBOARD_PORT=25026
DBI_REVERB_SERVER_PORT=25001
```

**`.env.local`** (mounted as the container's `/var/www/html/.env`) — the values that matter for local:
```ini
APP_ENV=local
APP_DEBUG=true
APP_KEY=base64:...                 # generate once if empty: docker compose exec app php artisan key:generate

DB_CONNECTION=pgsql
DB_HOST=pgsql                      # service name, not localhost
DB_PORT=5432
DB_DATABASE=kt_dev_db              # MUST match .env
DB_USERNAME=kt                     # MUST match .env
DB_PASSWORD=kt5663...              # MUST match .env
DB_DATABASE_TEST=kt_dev_db_test    # MUST match .env

QUEUE_CONNECTION=redis
BROADCAST_DRIVER=reverb
REDIS_HOST=redis
REDIS_CLIENT=predis                # single-node local redis
REDIS_PASSWORD=null

# Reverb (websockets) — browser connects to ws://localhost:25001
REVERB_SERVER_HOST=0.0.0.0         # bind inside container
REVERB_SERVER_PORT=25001
REVERB_HOST=localhost              # public host the browser uses (NOT 0.0.0.0)
REVERB_PORT=25001
REVERB_SCHEME=http
REVERB_APP_ID=mock_app
REVERB_APP_KEY=mock_key
REVERB_APP_SECRET=...

MAIL_MAILER=smtp
MAIL_HOST=mailhog
MAIL_PORT=1025
```

> If `ENV_FILE` points at a path that doesn't exist, the app boots with no env. Verify the file the compose
> variable references actually exists (`.env.local` here).

---

## Step 3 — Start the stack

```bash
docker compose up -d
```

First boot waits ~30s for the Postgres healthcheck. Services: `app`, `pgsql`, `pgsql_setup` (creates the test DB),
`redis`, `mailhog`, `api_docs`.

---

## Step 4 — Install the mounted domain's composer packages

The core image ships 5 of the 6 domain packages already; **`box/spout` is the one it lacks**, and the domain is
mounted (not baked), so resolve the merged dependency set inside the running container. The core's
`composer-merge-plugin` automatically merges `domain/composer.json`:

```bash
docker compose exec app composer update --no-interaction
```

This installs `box/spout` (used by the logistics export controllers) and registers the domain providers. Re-run it
after any `docker compose up --force-recreate app` (container `vendor/` resets to the image baseline).

> The domain's `endroid/qr-code` is pinned to `^5.0` (the QR helper uses the v5 API and the core ships v5.1.0).
> Do not bump it to `^6.0` — it conflicts with the core and breaks QR generation.

---

## Step 5 — Migrate and seed

```bash
docker compose exec app php artisan migrate:fresh --seed
```

Seeded accounts come from `.env.local` (`SYSTEM_ADMIN_EMAIL`, `DEFAULT_TENANT_NAME`, etc.). Domain migrations run
because the domain is mounted at `/var/www/html/domain`.

---

## Step 6 — Run realtime workers

Queues and websocket broadcasts need Horizon + Reverb (broadcast events are queued, so without Horizon the
websocket test page connects but never receives messages):

```bash
docker compose exec app php artisan horizon
docker compose exec app php artisan reverb:start --debug
```

---

## Access

- API: http://localhost:25000
- WebSocket test page: http://localhost:25000/ws
- Mailhog UI: http://localhost:25026

---

## Tests

The sail core bakes dev deps (PHPUnit, Collision), and the mounted domain includes its `tests/`, so both suites run
locally:

```bash
docker compose exec app php artisan test --testsuite Core
docker compose exec app php artisan test --testsuite Domain
```

The test DB (`kt_dev_db_test`) is created automatically by the `pgsql_setup` service. (Note: the *production* image
excludes domain tests via the domain `.dockerignore` — that's expected; tests are a local/dev concern.)

---

## Dev vs Production (don't cross the streams)

| | Local dev (this project) | Production |
|---|---|---|
| Core Dockerfile | `dash-backend/docker/php8.3/Dockerfile.core` (sail, `php -S`, `/var/www/html`) | `dash-backend/Dockerfile.core.production` (nginx + php-fpm, `/var/www/dash`) |
| Image tag | `local/...:latest` or `*-core` | `*-prod` |
| Domain | **mounted** live at `/var/www/html/domain` | **baked** via `Dockerfile.kitchntabs.production` → ECR |
| Run by | `docker compose` here | ECS Fargate |

Shared config (`config/horizon.php`, `config/database.php`) is local-safe: the Horizon `{...}` Redis prefix is a
harmless literal on single-node Redis, and `sslmode=require` only activates when `PLATFORM=fargate` (never set
locally). Building or running the local stack never affects the production `-prod` images.

---

## Common commands

```bash
docker compose logs -f app
docker compose exec app bash
docker compose exec app php artisan optimize:clear
docker compose exec app php artisan tinker
docker compose down            # stop, keep data
docker compose down -v         # stop, wipe DB/redis volumes
```
