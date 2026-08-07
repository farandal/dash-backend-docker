# WebSocket & Notification System — Technical Documentation

## Overview

The notification system dispatches real-time WebSocket messages, emails, FCM push, TTS speech, and database records from a single unified API call. It is built on **Laravel Reverb** (WebSocket server), **Laravel Horizon** (queue workers), and a custom layered stack: `AppNotificationBuilder → AppNotification → AppNotificationBase`.

---

## Architecture

```
Controller / Service
        │
        ▼
AppNotificationBuilder::send()          ← single entry point
        │
        ├── scope: public  ──────────►  broadcast(new PublicMessage(...))
        │                                   └─► Channel('public')  [event: .public]
        │
        ├── scope: private ──────────►  $user->notify(new AppNotification(...))
        │                                   └─► PrivateChannel('user.{id}')  [event: .notification]
        │
        └── scope: channel ──────────►  event(new AppNotification(...))
                                            └─► PrivateChannel('tenant.{id}.system')  [event: .notification]
                                                + optional per-user mail/push/database via $individual
```

All queued work is processed by **Horizon** workers. Reverb delivers the WebSocket frame to the connected client.

---

## Key Components

| File | Role |
|------|------|
| `app/AppNotifications/AppNotificationBuilder.php` | Single public entry point — resolves scope, builds instances, dispatches |
| `app/AppNotifications/AppNotification.php` | Laravel Notification + ShouldBroadcast — determines `via()`, `broadcastOn()`, `broadcastAs()`, `toBroadcast()` |
| `app/AppNotifications/AppNotificationBase.php` | Abstract base — holds config, data, targets, scope, channel; calls `buildNotification()` |
| `app/Events/PublicMessage.php` | Dedicated broadcast event for `scope=public` without a channel override |
| `config/broadcasting.php` | Reverb driver config — uses `REVERB_HOST`/`REVERB_PORT` (connect address) |
| `config/reverb.php` | Reverb server config — `host` = bind address (`REVERB_SERVER_HOST`), `hostname` = public address (`REVERB_HOST`) |

---

## Scopes

### `public`

Broadcasts to an unauthenticated public channel. Any subscriber can receive it without auth.

```php
AppNotificationBuilder::send(
    notificationClass: PublicMessageNotification::class,
    data: ['message' => 'Hello world'],
);
```

- **Channel:** `public`
- **Event name:** `.public`
- **Reverb channel type:** `Channel` (public, no auth)
- **Frontend:** `Echo.channel('public').listen('.public', callback)`

> The notification class must declare `"scope" => "public"` in its `config()`. The builder now reads this and overrides the `$scope` parameter automatically, so callers don't need to pass `scope: "public"` explicitly.

---

### `private`

Sends to a specific authenticated user. Uses Laravel Notifications (`$user->notify()`), so it goes through `via()` and can deliver via multiple channels simultaneously.

```php
AppNotificationBuilder::send(
    notificationClass: PrivateMessageNotification::class,
    data: 'Hello user',
    modelInstance: $user,        // or targets: [$userId], targetType: 'user'
    scope: 'private',
);
```

- **Channel:** `private-user.{user_id}`
- **Event name:** `.notification`
- **Reverb channel type:** `PrivateChannel` (requires auth)
- **Frontend:** `Echo.private('user.' + userId).listen('.notification', callback)`

The `via()` method in `AppNotification` determines delivery channels from the notification class config:

```php
// PrivateMessageNotification::config()
"channels" => ["socket" => true, "mail" => true, "database" => true]
```

---

### `channel`

Broadcasts to a named tenant/system channel. All subscribers of that channel (authenticated) receive it. Optionally also sends individual mail/push/database to users matching given roles within the tenant.

```php
AppNotificationBuilder::send(
    notificationClass: TenantChannelMessageNotification::class,
    data: 'Order received',
    channel: 'tenant.{tenantId}.system',
    scope: 'channel',
    targets: ['kitchen', 'staff'],    // roles for optional individual delivery
    targetType: 'role',
    individual: ['push', 'mail'],     // per-user channels in addition to socket
);
```

- **Channel:** `private-tenant.{id}.system` (or any string passed to `channel:`)
- **Event name:** `.notification`
- **Reverb channel type:** `PrivateChannel`
- **Frontend:** `Echo.private('tenant.' + tenantId + '.system').listen('.notification', callback)`

---

## Notification Class Structure

```php
class MyNotification extends AppNotificationBase
{
    public static function config(): array
    {
        return [
            "name"     => self::class,
            "active"   => true,
            "scope"    => "channel",   // optional — overrides builder default
            "channels" => [
                "socket"   => true,
                "mail"     => false,
                "database" => false,
                "push"     => false,
            ],
            "mailView" => "notifications.my_template",  // optional
        ];
    }

    public function buildNotification(): void
    {
        $this->notificationPayload = new AppNotificationPayload(
            self::class,
            $this->title ?? 'Default Title',
            $this->message ?? 'Default Message',
            $this->data
        );
    }
}
```

---

## Event Name (`broadcastAs`)

`AppNotification::broadcastAs()` returns `$this->notification->type`. When `type` is `null` (not passed by caller), it falls back to `'notification'`. This means:

| Path | Event broadcasted as | Frontend listener |
|------|---------------------|-------------------|
| Public (via `PublicMessage` event) | `.public` | `.listen('.public', cb)` |
| Private / Channel (via `AppNotification`) | `.notification` | `.listen('.notification', cb)` |

To use a custom event name, pass `type: 'my_event'` to `AppNotificationBuilder::send()`.

---

## Environment Variables

### Reverb Server (bind address — internal)

| Variable | Value | Purpose |
|----------|-------|---------|
| `REVERB_SERVER_HOST` | `0.0.0.0` | Interface Reverb listens on inside the container |
| `REVERB_SERVER_PORT` | `6001` | Port Reverb listens on inside the container |

### Reverb Public (connect address — used by clients and broadcasting driver)

| Variable | Value | Purpose |
|----------|-------|---------|
| `REVERB_HOST` | `localhost` | Hostname browsers and Horizon use to reach Reverb |
| `REVERB_PORT` | `26001` | Port browsers and Horizon use |
| `REVERB_SCHEME` | `http` | `https` in production |

> **Critical distinction:** `config/broadcasting.php` (the Pusher HTTP client Horizon uses to POST events) must use `REVERB_HOST`/`REVERB_PORT`, **not** `REVERB_SERVER_HOST`/`REVERB_SERVER_PORT`. The server host `0.0.0.0` is a valid bind address but not a valid TCP connect target.

### Docker Port Mapping

```yaml
# docker-compose.yml
ports:
  - "${DBI_REVERB_SERVER_PORT:-26001}:${REVERB_SERVER_PORT:-6001}"
  #   ^^^^^ host port                  ^^^^^ container port (must match REVERB_SERVER_PORT)
```

Both sides must match `REVERB_SERVER_PORT`. In this local configuration, `REVERB_SERVER_PORT=6001`, so the right-hand side of the `ports` mapping must also be `6001` while the host side may be a different port such as `26001`.

---

## `AppNotificationBuilder::send()` Parameters

```php
AppNotificationBuilder::send(
    notificationClass: string,   // Required. Notification class FQCN.
    data:             array,     // Payload passed to buildNotification().
    modelInstance:    mixed,     // Model (User, Tab, etc.) — used for targetUser resolution.
    type:             string,    // broadcastAs() event name. Defaults to 'notification'.
    scope:            string,    // 'public' | 'private' | 'channel'. Can be omitted if declared in config().
    targets:          array,     // User IDs (targetType='user') or role names (targetType='role').
    targetType:       string,    // 'user' | 'role'.
    channel:          string,    // Channel name, e.g. 'tenant.1.system'.
    tenant:           mixed,     // Tenant model or array — used for mail templates and role resolution.
    individual:       array,     // Per-user channels in addition to socket: ['push','mail','database'].
    sendInstance:     bool,      // Include serialized modelInstance in payload. Default false.
    title:            string,    // Passed to buildNotification() as $this->title.
    message:          string,    // Passed to buildNotification() as $this->message.
    config:           array,     // Overrides merged on top of class config(). E.g. disable mail for one send.
)
```

---

## Docker Local Development

### Start the stack

```bash
pnpm dash:<project>:local   # full stack: DB + Redis + app + migrations
```

Reverb and Horizon are **not** started manually — the core image is always built from
`Dockerfile.core.production`, which runs `supervisord` and auto-starts/auto-restarts both
(see `docker/app/custom-supervisor.conf`). To restart them after a code change:

```bash
docker compose exec app supervisorctl -c /etc/supervisor/supervisord.conf restart reverb horizon
```

### Test page

```
http://localhost:25100/ws
```

Buttons:
- **PublicMessage** — fires `POST /api/ws/trigger`, broadcasts to `public` channel
- **Send to User** — fires `POST /api/ws/trigger/{userId}`, broadcasts to `private-user.{id}`; enter the userId first so the page subscribes to that private channel
- **Send to Channel** — fires `POST /api/ws/channel`, broadcasts to `private-tenant.{tenantId}.system`; enter tenantId first so the page subscribes

---

## Mounted Files (docker-compose)

The following source files from `dash-backend/` are bind-mounted into the container so fixes are preserved across container recreations:

| Host path | Container path |
|-----------|----------------|
| `dash-backend/config/broadcasting.php` | `/var/www/dash/config/broadcasting.php` |
| `dash-backend/resources/views/websocket-test.blade.php` | `/var/www/dash/resources/views/websocket-test.blade.php` |
| `dash-backend/app/AppNotifications/AppNotificationBuilder.php` | `/var/www/dash/app/AppNotifications/AppNotificationBuilder.php` |

After editing any of these files, run:

```bash
docker compose exec app php artisan config:clear
docker compose exec app php artisan view:clear
docker compose exec app php artisan horizon:terminate
# then restart horizon
```

---

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Frontend connects but never receives messages | Broadcasting driver posting to `0.0.0.0` (unreachable) | `broadcasting.php` reverb options `host` must use `REVERB_HOST`, not `REVERB_SERVER_HOST` |
| Frontend `ws://0.0.0.0:26001` connection fails | Blade reads `reverb.servers.reverb.host` (bind addr) | Use `reverb.servers.reverb.hostname` (maps to `REVERB_HOST`) |
| Reverb logs no incoming events, Horizon shows DONE | Port mismatch in docker-compose | Container port in `ports:` mapping must equal `REVERB_SERVER_PORT` |
| Public notification goes to wrong channel | Builder ignores notification class `scope` config | Fixed in `AppNotificationBuilder` — class-declared `scope` now overrides the default `"channel"` |
| Private/channel messages not visible in test page | No listener subscribed | Enter userId/tenantId **before** clicking send — the page auto-subscribes on input change |
