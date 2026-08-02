# Dash Backend Docker Port Mapping Guide

## Purpose

This guide documents how to configure and verify port mappings when starting a new local project in `dash-backend-docker`. It explains the core environment variables, the Docker Compose ports mapping, and the minimal steps to bootstrap a new project with the correct host/container networking.

## Port roles

### HTTP app port

- Host port: `DBI_APP_PORT`
- Container port: `80`

This is the main web API port that hosts the Laravel app.

### Reverb / WebSocket port

- Host port: `DBI_REVERB_SERVER_PORT`
- Container port: `REVERB_SERVER_PORT`
- Public WebSocket port (client-facing): `REVERB_PORT`

This port mapping is used for realtime WebSocket traffic. Typically the container binds Reverb to an internal port (`6001`) while the host exposes it on a different local port such as `26001`.

### Database port

- Host port: `DBI_FORWARD_DB_PORT`
- Container port: `5432`

This port is used by external tools and local developer clients to connect to the PostgreSQL service.

### Redis port

- Host port: `DBI_FORWARD_REDIS_PORT`
- Container port: `6379`

Used by external Redis clients and debugging tools.

### Mailhog ports

- SMTP host port: `DBI_FORWARD_MAILHOG_PORT`
- Web UI host port: `DBI_FORWARD_MAILHOG_DASHBOARD_PORT`

## Key environment variables

The local stack is configured through two env files:

- `dash-backend-docker/.env.<project>` — Docker Compose runtime settings
- `dash-backend-docker/.env.<project>.local` — Laravel app env values mounted into the app container

### Required Docker Compose env variables

In `.env.<project>`:

- `COMPOSE_PROJECT_NAME` — compose project prefix
- `ENV_FILE` — Laravel `.env` file mounted into the app container
- `DOMAIN_PATH` — mounted domain package path
- `DBI_APP_PORT` — host port mapped to container port `80`
- `DBI_REVERB_SERVER_PORT` — host port mapped to `REVERB_SERVER_PORT`
- `DBI_FORWARD_DB_PORT` — host port mapped to PostgreSQL `5432`
- `DBI_FORWARD_REDIS_PORT` — host port mapped to Redis `6379`
- `DBI_FORWARD_MAILHOG_PORT` and `DBI_FORWARD_MAILHOG_DASHBOARD_PORT`

### Required Laravel app env values

In `.env.<project>.local`:

- `APP_URL` — should include the host-side `DBI_APP_PORT`
- `APP_PORT` — same as the host-side app port
- `DB_CONNECTION`, `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`
- `REVERB_SERVER_HOST` — usually `0.0.0.0`
- `REVERB_SERVER_PORT` — internal container port for Reverb (`6001`)
- `REVERB_HOST` — browser-visible host, usually `localhost`
- `REVERB_PORT` — public WebSocket port on the host (`DBI_REVERB_SERVER_PORT`)

## Docker Compose port mapping

In `docker-compose.yml`, the app service binds:

```yaml
ports:
  - "${DBI_APP_PORT:-18000}:80"
  - "${DBI_REVERB_SERVER_PORT:-26001}:${REVERB_SERVER_PORT:-6001}"
```

This means the host port and container port may be different.

## Recommended default local port setup

A stable local setup uses the following values:

- `DBI_APP_PORT=25100`
- `APP_PORT=25100`
- `APP_URL=http://localhost:25100`
- `DBI_REVERB_SERVER_PORT=26001`
- `REVERB_SERVER_PORT=6001`
- `REVERB_HOST=localhost`
- `REVERB_PORT=26001`

This split keeps the app HTTP port separate from the WebSocket port while preserving a predictable public endpoint.

## Startup guide for a new project

1. Copy the example project env files:

```bash
cd dash-backend-docker
cp .env.example .env.<project>
cp .env.local.example .env.<project>.local
```

2. Edit `.env.<project>`:

- set `COMPOSE_PROJECT_NAME` for the project
- set `ENV_FILE=.env.<project>.local`
- set `DOMAIN_PATH` to the mounted domain package path
- set `DBI_APP_PORT=25100`
- set `DBI_REVERB_SERVER_PORT=26001`
- set other exposed ports as needed

3. Edit `.env.<project>.local`:

- set `APP_URL=http://localhost:25100`
- set `APP_PORT=25100`
- set all `DB_*` values to match the compose-level database settings
- set `REVERB_SERVER_HOST=0.0.0.0`
- set `REVERB_SERVER_PORT=6001`
- set `REVERB_HOST=localhost`
- set `REVERB_PORT=26001`

4. Verify the mounted Laravel env file path in `docker-compose.yml`.

5. Start the stack:

```bash
pnpm dash:<project>:local
```

If your project name is `vanexa`, the command is:

```bash
pnpm dash:vanexa:local
```

## Verify after startup

Use `docker ps` to confirm:

- app container: host port `25100` mapped to `80`
- app container: host port `26001` mapped to `6001`

Use the browser or curl:

```bash
curl -I http://localhost:25100
curl -I http://localhost:26001
```

## Troubleshooting

- If the app is still serving on the wrong host port, verify `DBI_APP_PORT` in `.env.<project>` and `APP_URL`/`APP_PORT` in `.env.<project>.local`
- If WebSocket connections fail, verify `REVERB_SERVER_PORT=6001`, `REVERB_HOST=localhost`, and `REVERB_PORT=26001`
- If a `php artisan migrate` or `artisan` command runs from the wrong path, check that the app env file is mounted into the active runtime root (`/var/www/dash`) and not `/var/www/html`

## Notes

- `APP_URL` must include the host-side app port, not the internal container port.
- `REVERB_PORT` should be the public port clients use, typically the same as `DBI_REVERB_SERVER_PORT`.
- `REVERB_SERVER_PORT` is the internal container bind port and should usually remain `6001`.
