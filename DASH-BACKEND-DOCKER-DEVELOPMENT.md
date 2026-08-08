# dash-backend-docker — Developer Cheatsheet

> **New here?** Start with [QUICK_SETUP.md](./QUICK_SETUP.md).
> **Full reference:** [README.md](./README.md)
>
> **Dev vs Production:** local dev and production both build from the same lineage —
> `Dockerfile.core.production` (nginx + php-fpm + supervisord, app at `/var/www/dash`).
> For local dev, pass `--build-arg INSTALL_DEV_DEPS=true` to keep require-dev packages in
> the image; the domain is still mounted live via docker-compose.yml, unlike a real
> production build where it's baked in.
>
> **First run:** after `docker compose up`, run
> `docker compose exec app composer update --no-interaction` to pull the mounted domain's
> packages (notably `box/spout`, which is not in the core lock) into the container.

---

## Domain overview

Three domains share the same `dash-backend` core image. Each domain has its own:
- Composer domain layer (mounted at `/var/www/dash/domain`)
- PostgreSQL database (separate credentials)
- Runtime storage (assets, logs, cache — named folder under `./storage/`)
- Env file pair (`.env.<domain>` + `.env.<domain>.local`)

| Domain | Compose env | App env | DB | Domain repo |
|---|---|---|---|---|
| **vanexa** | `.env.vanexa` | `.env.vanexa.local` | `kt_dev_db` | `../vanexa-backend-domain` |
| **fablabos** | `.env.fablabos` | `.env.fablabos.local` | `fl_dev_db` | `../fablabos-backend-domain` |
| **reddorada** | `.env.reddorada` | `.env.reddorada.local` | `rd_dev_db` | `../reddorada-backend-domain` |
| **kitchntabs** | `.env.kitchntabs` | `.env.kitchntabs.local` | `kt_dev_db` | `../kitchntabs-backend-domain` |

Copy the templates to create env files for a new domain:

```bash
cp env.domain.example       .env.<domain>
cp env.domain.local.example .env.<domain>.local
```

---

## pnpm launchers

```bash
# generic launcher — no project is baked in, always pass one explicitly
pnpm dash:start <project> <environment>

# examples
pnpm dash:start vanexa local
pnpm dash:start vanexa tunnel
pnpm dash:start vanexa production

pnpm dash:start fablabos local
pnpm dash:start reddorada tunnel
pnpm dash:start kitchntabs production
```

You can also invoke the cross-platform launcher directly:

```bash
node scripts/run-local.mjs <project> <environment>
# examples:
node scripts/run-local.mjs vanexa local
node scripts/run-local.mjs fablabos   tunnel
node scripts/run-local.mjs reddorada  production
```

The launcher:
1. Loads `--env-file .env.<project>` so Docker Compose gets the correct `DOMAIN_PATH`,
   `STORAGE_PATH`, and `DB_*` values.
2. Exports `ENV_FILE=.env.<project>.<environment>` (the Laravel app env) so the compose
   variable override takes precedence over the value in `.env.<project>`.
3. Exports `COMPOSE_PROJECT_NAME` so subsequent `docker compose exec` calls target the
   correct running project.
4. Runs `docker compose up -d` → `artisan migrate` → `pnpm docs:generate`.
5. Opens Reverb log tail, Horizon log tail, Laravel log tail, and Core+Domain test windows
   in separate Terminal sessions (macOS). Reverb and Horizon themselves are
   supervisord-managed inside the container (auto-started at boot) — these windows only
   tail their supervisor log files rather than running the processes directly.

---

## Build the local core image

```bash
# In dash-backend — run once, or after core source changes
cd ../dash-backend
docker build -f Dockerfile.core.production -t local/dash-backend-core:latest --build-arg INSTALL_DEV_DEPS=true .
```

---

## Publish a core image to Docker Hub

```bash
# From dash-backend/
./docker-publish-core.sh --hub-user farandal --tag 1.0.0-core                        # multi-arch push
./docker-publish-core.sh --hub-user farandal --tag 1.0.0-core --arch arm64 --skip-push  # local load only
```

Then update the image tag in `.env.<domain>`:

```ini
DASH_IMAGE=farandal/dash-backend:1.0.0-core
```

---

## Common Docker / Artisan commands

```bash
# Start / stop
docker compose down -v                           # stop + wipe DB volumes
docker compose up -d --force-recreate app        # recreate app container (picks up new image)

# Logs and shell
docker compose logs -f app
docker compose exec app bash
docker compose exec app tail -f /var/www/dash/storage/logs/laravel.log

# Migrations / seeding
docker compose exec app php artisan migrate:fresh --seed
docker compose exec app php artisan migrate
docker compose exec app php artisan db:seed --force

# Cache / config
docker compose exec app php artisan optimize:clear
docker compose exec app php artisan cache:clear
docker compose exec app php artisan config:clear

# Composer (re-run after --force-recreate to restore domain packages)
docker compose exec app composer update --no-interaction
docker compose exec app composer install

# Artisan tools
docker compose exec app php artisan about
docker compose exec app php artisan route:list
docker compose exec app php artisan tinker
docker compose exec app php artisan key:generate
docker compose exec app php artisan media-library:regenerate
docker compose exec app php artisan queue:work --tries=1
```

---

## Realtime workers

The launcher opens these in separate terminal windows automatically.
To restart manually:

```bash
docker compose exec app php artisan reverb:start --debug
docker compose exec app php artisan horizon
```

---

## Tests

```bash
# All suites
docker compose exec app php artisan test

# By suite
docker compose exec app php artisan test --testsuite Core
docker compose exec app php artisan test --testsuite Domain

# Filter
docker compose exec app php artisan test --filter Auth
docker compose exec app php artisan test --filter TenantAuthorizationTest

# Single file
docker compose exec app php artisan test tests/Unit/UuidV7Test.php

# JUnit XML output
docker compose exec app php artisan test --testsuite=Core,Domain --log-junit /var/www/dash/reports/test_results.xml --no-ansi

# Direct phpunit
docker compose exec app vendor/bin/phpunit --testsuite Core
```

Test results land in `./reports/`.

---

## PostgreSQL access

```bash
# via docker compose (always works)
docker compose exec -T pgsql psql -U kt -d kt_dev_db

# direct TCP (port 25432, if Docker Desktop port forwarding is enabled)
psql -h localhost -p 25432 -U kt -d kt_dev_db
```

If port 25432 isn't reachable on macOS, start a socat bridge:

```bash
docker run -it --rm -v /var/run/docker.sock:/var/run/docker.sock \
  alpine/socat TCP-LISTEN:5432,reuseaddr,fork DOCKER:${COMPOSE_PROJECT_NAME:-dash_image}_pgsql:5432
# then connect to localhost:5432
```

**DBeaver connection:**

| Field | vanexa | fablabos | reddorada |
|---|---|---|---|
| Host | `localhost` | `localhost` | `localhost` |
| Port | `25432` | `25432` | `25432` |
| DB | `kt_dev_db` | `fl_dev_db` | `rd_dev_db` |
| User | `kt` | `kt` | `kt` |

---

## Cloudflare tunnel

### Tunnel only (stack already running)

```bash
pnpm cloudflare:tunnel --env-file .env.vanexa
pnpm cloudflare:tunnel --env-file .env.fablabos
pnpm cloudflare:tunnel --env-file .env.reddorada
```

### Start stack + tunnel together

```bash
pnpm dash:start vanexa tunnel
pnpm dash:start fablabos tunnel
pnpm dash:start reddorada tunnel
```

This uses `.env.<domain>.tunnel` as the Laravel app env (sets `APP_URL`, `REVERB_HOST`,
`REVERB_PORT=443`, `REVERB_SCHEME=https` for the public hostnames).

Opening the tunnel is controlled by an explicit `--tunnel` flag, not by the environment name —
`environment` only selects which `.env.<project>.<environment>` app env gets mounted. Passing
`tunnel` as the environment still opens the tunnel automatically (backward-compatible shorthand,
since `.env.<domain>.tunnel` has no other use), but any other environment needs `--tunnel`
explicit:

```bash
pnpm dash:start kitchntabs staging --tunnel   # boots the stack + opens the tunnel to the
                                               # staging hostnames below
pnpm dash:start kitchntabs staging            # boots the stack only, reachable at localhost
```

The tunnel script is passed `--env-suffix <ENVIRONMENT>` (uppercased), so one compose-level
`.env.<domain>` file can carry hostnames for several environments at once: it prefers
`CF_TUNNEL_HOSTNAME_<SLOT>_<SUFFIX>` / `CF_TUNNEL_LOCAL_<SLOT>_<SUFFIX>` over the base
`CF_TUNNEL_HOSTNAME_<SLOT>` / `CF_TUNNEL_LOCAL_<SLOT>` vars when the suffixed ones are set,
e.g. `CF_TUNNEL_HOSTNAME_API_STAGING=api-staging.<domain>`. All environments share the same
named tunnel (`CF_TUNNEL_NAME`) — `pushTunnelIngressConfig()` in `cloudflare-tunnel.js` merges
routes into the tunnel's existing ingress rather than replacing them, so starting the staging
tunnel doesn't disturb the dev (`tunnel`) routes already running on it, and vice versa.

### Required env vars in `.env.<domain>`

```ini
CF_API_TOKEN=<your api token>
CF_ACCOUNT_ID=<your account id>
CF_ZONE_NAME=<domain>.com
CF_TUNNEL_NAME=<domain>-dev

CF_TUNNEL_HOSTNAME_API=api-dev.<domain>.com
CF_TUNNEL_LOCAL_API=http://localhost:25100

CF_TUNNEL_HOSTNAME_WS=ws-dev.<domain>.com
CF_TUNNEL_LOCAL_WS=http://localhost:26001

# CF_TUNNEL_TOKEN is written back automatically after first run — leave blank initially
```

Multi-route mode activates when any `CF_TUNNEL_HOSTNAME_*` is non-empty. The script
creates the named tunnel, fetches its token, pushes ingress rules, creates CNAMEs, and
runs `cloudflared tunnel run`.

---

## API docs

```bash
pnpm docs:generate     # generate OpenAPI JSON from running container
pnpm docs:start        # generate + start the local docs UI
```

---

## Switching domains

```bash
docker compose down -v                           # wipe domain-specific DB data
pnpm dash:start <new-domain> local                # restart with new env pair
docker compose exec app composer update --no-interaction
docker compose exec app php artisan migrate:fresh --seed
```

> `-v` is required: each domain's Postgres container was initialized with different
> credentials. Without `-v`, the volume keeps the old credentials and the new domain's
> connection will fail.
