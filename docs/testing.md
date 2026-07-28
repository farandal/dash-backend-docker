# Testing Guide — dash-backend-docker

This guide documents how to run the test suites, access logs, understand volumes, and test WebSocket/Reverb notifications from the `dash-backend-docker` environment.

---

## Quick Start Commands

These commands assume you are in the `dash-backend-docker/` folder.

### 1. Start the stack

```bash
docker compose up -d
```

### 2. Run migrations and seed the database

Required on a fresh stack or after `docker compose down -v`.

```bash
docker compose exec app php artisan migrate:fresh --seed
```

### 3. Start Reverb (WebSocket server)

Must be running before any broadcast-dependent tests or manual WebSocket tests.

```bash
docker compose exec app php artisan reverb:start --debug
```

The `--debug` flag prints each connection, subscription, and event to stdout — useful during development.

### 4. Start Horizon (queue worker)

Must be running before any queue-dispatched jobs or notification delivery tests.

```bash
docker compose exec app php artisan horizon
```

### 5. Run the Core test suite

```bash
docker compose exec app php artisan test --testsuite=Core
```

### 6. Run the Domain test suite

```bash
docker compose exec app php artisan test --testsuite=Domain
```

### 7. Run Core tests with JUnit XML report (for CI)

The report is written to `./reports/` on the host (see Volumes section).

```bash
docker compose exec app php artisan test --testsuite=Core --log-junit /var/www/dash/reports/core_results.xml
```

---

## Why Reverb and Horizon Must Be Started Before Tests

Several test cases assert that events were broadcast or that queued jobs completed. If Reverb or Horizon are not running when those tests execute, the assertions will fail or silently time out.

| Dependency | Required for |
|---|---|
| `reverb:start` | Broadcast event delivery, WebSocket channel tests |
| `horizon` | Queued notification delivery, job-based side effects |

Both processes are long-running and must be left running in a separate terminal while tests execute.

---

## Accessing Laravel Logs

Laravel writes application logs to `/var/www/dash/storage/logs/laravel.log` inside the container.

### Option A — Read directly from the container

```bash
# Tail the log in real time
docker compose exec app tail -f /var/www/dash/storage/logs/laravel.log

# Read the last 200 lines
docker compose exec app tail -200 /var/www/dash/storage/logs/laravel.log

# Search for errors
docker compose exec app grep -i "error\|exception" /var/www/dash/storage/logs/laravel.log
```

### Option B — Mount the storage directory as a volume (optional)

To access logs directly on the host, add a volume binding in `docker-compose.yml` under the `app` service:

```yaml
volumes:
  - ./storage/logs:/var/www/dash/storage/logs
```

Then create the local directory first:

```bash
mkdir -p storage/logs
```

After restarting the stack, `storage/logs/laravel.log` will be readable from the host without `docker exec`.

> **Note:** The `storage/` directory is not currently volume-mounted because it is baked into the image. Mounting it will shadow the image's storage directory and may require re-running `php artisan storage:link` inside the container.

---

## Docker Compose Volumes Explained

### Named volumes (persist across restarts, survive `docker compose down`)

| Volume name | Service | Purpose |
|---|---|---|
| `dash-pgsql` | `pgsql` | PostgreSQL data directory. Preserves all databases between stack restarts. Deleted only with `docker compose down -v`. |
| `dash-redis` | `redis` | Redis snapshot/persistence data. Preserves Reverb app registry and queue state. |
| `dash-composer-cache` | `app` | Composer package cache. Speeds up any `composer install` runs inside the container. |

### Bind mounts (map host paths into the container)

| Host path | Container path | Purpose |
|---|---|---|
| `.env.local` (or value of `ENV_FILE`) | `/var/www/dash/.env` | Laravel application environment. All `env()` calls inside the app read from here. Also mounted as `.env.production` so it is always active regardless of `APP_ENV`. |
| `DOMAIN_PATH` (default `../dash-backend-domain`) | `/var/www/dash/domain` | Domain-specific code (controllers, models, policies, migrations). Allows extending the core image with project-specific logic without rebuilding. |
| `../dash-backend/database/create-testing-db.sh` | `/docker-entrypoint-initdb.d/` | Bootstrap script run by the `pgsql` and `pgsql_setup` services to create both `DB_DATABASE` and `DB_DATABASE_TEST` databases on first boot. |
| `./reports` | `/var/www/dash/reports` | JUnit XML test reports written by `--log-junit`. Makes CI reports available on the host after a test run. |

---

## Testing WebSocket Notifications

### Prerequisites

1. Stack is up: `docker compose up -d`
2. Migrations and seeds done: `docker compose exec app php artisan migrate:fresh --seed`
3. Reverb is running: `docker compose exec app php artisan reverb:start --debug`

### Browser Test UI

Open the WebSocket test page in your browser:

```
http://localhost:25000/ws
```

This page (served from `dash-backend/resources/views/websocket-test.blade.php`) connects to Reverb via Laravel Echo and subscribes to the `session` public channel. When a message is broadcast to that channel, it appears in the page UI in real time.

The browser connects to:

```
ws://localhost:25001/app/mock_key
```

> **Important — `REVERB_HOST` must be `localhost`:** `REVERB_SERVER_HOST=0.0.0.0` is the bind address Reverb listens on inside the container. `REVERB_HOST` is the address the browser uses to connect from outside. These are different. Setting `REVERB_HOST=0.0.0.0` causes the browser to attempt `ws://0.0.0.0:25001`, which always fails. `REVERB_HOST` must always be set to the hostname or IP reachable from the browser (`localhost` for local dev).

### API Trigger Routes

These routes are registered in `dash-backend/routes/api.php` and can be called with any HTTP client (curl, Postman, browser DevTools).

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/ws/trigger` | Broadcasts a `PublicMessageNotification` to the `session` public channel. No auth required. |
| `POST` | `/api/ws/trigger/{userId}` | Broadcasts a `PrivateMessageNotification` to the `user.{userId}` private channel. Requires the user to have authenticated and subscribed. |
| `POST` | `/api/ws/channel` | Broadcasts a `TenantChannelMessageNotification` to a tenant channel. Body: `{ "tenantId": 1, "roles": ["admin"] }`. Requires auth. |

#### Example — trigger a public notification

```bash
curl -X POST http://localhost:25000/api/ws/trigger
```

Expected response:

```json
{ "success": true, "message": "Event triggered" }
```

If this returns 500, check the logs: the most likely cause is the `pulse_entries` table missing. Ensure `PULSE_ENABLED=false` is set in `.env.local`.

#### Example — trigger a private notification

```bash
# Replace 1 with a seeded user ID
curl -X POST http://localhost:25000/api/ws/trigger/1
```

#### Example — trigger a tenant channel notification

```bash
curl -X POST http://localhost:25000/api/ws/channel \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{ "tenantId": 1, "roles": ["admin"] }'
```

### Broadcast Channels

Defined in `dash-backend/routes/channels.php`:

| Channel | Type | Authorization |
|---|---|---|
| `session.{sessionId}` | Public | Always authorized |
| `user.{id}` | Private | User ID must match authenticated user |
| `tenant.{tenantId}` | Private | User must belong to tenant |
| `tenant.{tenantId}.system` | Private | User must belong to tenant |
| `tenant.{tenantId}.chat` | Private | User must belong to tenant |

---

## Common Issues

### `pulse_entries` does not exist — 500 on `/api/ws/trigger`

The Pulse migration (`2023_06_07_000001_create_pulse_tables.php`) IS included in core and always
runs on pgsql — `PulseMigration::shouldRun()` checks only the DB driver, not `PULSE_ENABLED`.

The 500 means `migrate:fresh` has not been run yet. Run it and the tables will be created:

```bash
docker compose exec app php artisan migrate:fresh --seed
```

Optionally set `PULSE_ENABLED=false` in `.env.local` to disable Pulse telemetry recording in local dev (reduces DB writes). This does not affect table creation.

### `ws://0.0.0.0:25001/app/mock_key` connection failed

`REVERB_HOST` is set to the bind address instead of the public host. Change `REVERB_HOST=0.0.0.0` to `REVERB_HOST=localhost` in `.env.local` and restart Reverb.

### Reverb port mismatch

The container binds Reverb on `REVERB_SERVER_PORT=6001`. The host maps that to `DBI_REVERB_SERVER_PORT=25001` (in `.env`). The browser must connect to `REVERB_PORT=25001` (the host-side port). Ensure all three are consistent.

### Tests fail with "broadcast driver not configured"

`BROADCAST_DRIVER=reverb` must be set in `.env.local` and Reverb must be running before the test suite starts.
