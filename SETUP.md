# Preview environment — setup on a new machine

How to stand up a **preview** environment for KitchnTabs and Vanexa on a dedicated machine,
reproducing the working staging server (see [PM2_AUTOMATION.md](./PM2_AUTOMATION.md) for how
staging runs on macOS today). Preview runs the same Docker stack, exposed through its own
Cloudflare Tunnel on its own hostnames, so it never shares state, hostnames, or a tunnel with
staging.

| | |
|---|---|
| **Part 1 — IT requirements** | What IT must provide: machine, firewall, DNS, outbound access. Self-contained; can be sent to IT on its own. |
| **Part 2 — Setup procedure** | Step-by-step for the engineer doing the install. |
| **Part 3 — Verification and operations** | Acceptance checks, day-to-day commands, known failure modes. |

> Hostnames below (`api-preview.*`, `ws-preview.*`) are **proposals**. Confirm the final names
> with IT before starting; everything is parameterised on them.

---

# Part 1 — IT requirements

## 1.1 What is being hosted

Two independent backends on one machine, each an API and a WebSocket (Laravel Reverb) server:

| Product | Public API hostname | Public WebSocket hostname | Local API port | Local WebSocket port |
|---|---|---|---|---|
| KitchnTabs | `api-preview.kitchntabs.com` | `ws-preview.kitchntabs.com` | 25000 | 25001 |
| Vanexa | `api-preview.vanexa.cl` | `ws-preview.vanexa.cl` | 25100 | 26001 |

All four hostnames are HTTPS on 443 to the public. Browsers and mobile apps call the API over
HTTPS and hold a long-lived `wss://` connection to the WebSocket hostname.

## 1.2 Recommended exposure: Cloudflare Tunnel (no inbound ports)

The staging server does not accept any inbound connection from the internet. A small daemon,
`cloudflared`, opens **outbound** connections to Cloudflare, and Cloudflare forwards public
HTTPS/WSS traffic back down them to `localhost` on the machine. Cloudflare terminates TLS and
provides DDoS/WAF protection.

What this means for IT:

- **No inbound port has to be opened** on the firewall or router for the web/API/WebSocket traffic.
- **No public IP, NAT rule, load balancer, or certificate** is needed for the four hostnames.
- The four DNS names must live in a **Cloudflare-managed zone** (`kitchntabs.com` and
  `vanexa.cl` already are). A proxied record pointing at a tunnel cannot be created in a zone
  hosted elsewhere.

If corporate policy forbids Cloudflare Tunnel, use the direct-exposure alternative in 1.7.

## 1.3 Machine

| Item | Requirement |
|---|---|
| Type | Dedicated VM or physical host, always on |
| CPU / RAM / disk | 8 vCPU, 32 GB RAM, 500 GB SSD (same sizing as [REQUERIMIENTOS_PREPRODUCCION.md](./REQUERIMIENTOS_PREPRODUCCION.md)) |
| OS | Ubuntu 24.04 LTS (or another current Linux with systemd) |
| Docker | Docker Engine 24+ with Compose v2, enabled at boot |
| Other software | `git`, Node.js 20+ and `pnpm`, `cloudflared`, `curl`, `jq`, `chrony`/NTP |
| Accounts | A non-root service user in the `docker` group, with SSH deploy-key access to the GitHub repos (see 2.2) |
| Time | NTP-synchronised. Clock skew breaks TLS and tunnel registration. |
| Autostart | Docker and the services in Part 2 must start at boot with nobody logged in |

## 1.4 Firewall — inbound

| Port | Proto | Source | Purpose | Required |
|---|---|---|---|---|
| 22 | TCP | Named admin IPs / VPN only | Administration (key-only, no password login) | Yes |
| 80, 443, or anything else | — | — | — | **No** (with Cloudflare Tunnel) |

**Important — Docker bypasses host firewalls.** The compose file publishes database, Redis and
mail ports on all interfaces (`0.0.0.0:25432`, `25379`, `25433`, `25388`, `25025-25028`, …).
Docker inserts its own iptables rules ahead of `ufw`/`firewalld`, so a "deny incoming" policy
does **not** protect them. IT must block them explicitly, in the `DOCKER-USER` chain or at the
network/security-group level:

- Deny all inbound from anything except loopback to TCP **25000–25999, 26001 and 18010** (the
  app, WebSocket, Postgres, Redis, MailHog and API-docs ports). In the tunnel design nothing outside
  the machine ever needs to reach them.
- The four proxied ports (25000, 25001, 25100, 26001) are reached only by `cloudflared` on
  `localhost`.

## 1.5 Firewall — outbound

The machine must be able to reach the following. Outbound is normally allowed by default; if it
is restricted, allow these.

| Destination | Port / proto | Why |
|---|---|---|
| `region1.v2.argotunnel.com`, `region2.v2.argotunnel.com` | **7844 UDP (QUIC) and TCP (HTTP/2 fallback)** | Cloudflare Tunnel connections. **This is the one people forget.** |
| `api.cloudflare.com` | 443 | Tunnel and DNS management by the deploy scripts |
| `update.argotunnel.com`, `cfd-features.argotunnel.com` | 443 | `cloudflared` feature/update checks |
| `github.com` | 22 or 443 | Pulling the application repositories |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` | 443 | Pulling the application image and base images |
| `repo.packagist.org`, `packagist.org`, `registry.npmjs.org` | 443 | Composer / npm dependencies (private packages also authenticate here) |
| AWS S3, region `us-east-2` (`*.s3.us-east-2.amazonaws.com`) | 443 | File storage used by the application |
| `api.deepinfra.com` | 443 | AI provider used by the Vanexa agents |
| DNS resolvers, NTP | 53 UDP/TCP, 123 UDP | Name resolution, time sync |

The application also calls third-party services configured per environment (payments,
messaging, push notifications). The engineer will hand IT the exact list from the env files
during setup (step 2.5); please allow them or advise on a proxy.

## 1.6 DNS

If the zones are already in the shared Cloudflare account, **no action is needed from IT**: the
setup script creates the four records itself, using an API token (see 2.4). Otherwise IT must
provide, or delegate to us, the ability to create these records in the Cloudflare zones:

| Name | Type | Target | Proxy |
|---|---|---|---|
| `api-preview.kitchntabs.com` | CNAME | `<TUNNEL_ID>.cfargotunnel.com` | Proxied (orange cloud) |
| `ws-preview.kitchntabs.com` | CNAME | `<TUNNEL_ID>.cfargotunnel.com` | Proxied |
| `api-preview.vanexa.cl` | CNAME | `<TUNNEL_ID>.cfargotunnel.com` | Proxied |
| `ws-preview.vanexa.cl` | CNAME | `<TUNNEL_ID>.cfargotunnel.com` | Proxied |

`<TUNNEL_ID>` is generated in step 2.4 and handed over then. In Cloudflare, WebSockets must be
enabled for the zone (default on; Network → WebSockets).

Please also provide (or confirm we may create) a Cloudflare **API token** scoped to
*Account → Cloudflare Tunnel: Edit* and *Zone → DNS: Edit* for the two zones, and no more.

## 1.7 Alternative: direct exposure (only if tunnels are not allowed)

Everything in 1.4 and 1.6 changes:

| Item | Requirement |
|---|---|
| Inbound | **443/TCP** from the internet (and 80/TCP for redirect-to-HTTPS) to a reverse proxy on the machine |
| Public IP | A static public IP or a load balancer in front of the machine |
| DNS | Four `A`/`AAAA` records to that IP (or the proxy in front of it), instead of tunnel CNAMEs |
| TLS | Valid certificates for the four hostnames (Let's Encrypt or corporate CA), auto-renewed |
| Reverse proxy | nginx/Caddy on the machine, mapping each hostname to its local port (below) |
| Protection | Rate limiting / WAF, since Cloudflare's is no longer in front |

Each hostname needs WebSocket upgrade support, a 128 MB body limit and 300 s timeouts.
Example (nginx), one server block per hostname:

```nginx
server {
    listen 443 ssl http2;
    server_name api-preview.kitchntabs.com;          # ws-preview.* -> 25001, vanexa -> 25100 / 26001
    ssl_certificate     /etc/ssl/preview/fullchain.pem;
    ssl_certificate_key /etc/ssl/preview/privkey.pem;

    client_max_body_size 128M;
    proxy_read_timeout 300s;  proxy_send_timeout 300s;  proxy_connect_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:25000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;       # required for the ws-* hostnames
        proxy_set_header Connection "upgrade";
    }
}
```

## 1.8 Checklist for IT

- [ ] Machine provisioned to 1.3, with a service user and SSH access for the engineer
- [ ] Inbound: only 22 from admin IPs/VPN; **DOCKER-USER rules blocking 25000–25999, 26001 and 18010** (1.4)
- [ ] Outbound allowed to every row in 1.5, especially **7844 UDP + TCP** to Cloudflare
- [ ] Final preview hostnames approved; zones confirmed to be in Cloudflare (1.6)
- [ ] Cloudflare API token provided with the scoped permissions in 1.6
- [ ] (Direct exposure only) public IP, DNS, TLS certificates, reverse proxy per 1.7

---

# Part 2 — Setup procedure

Assumes Part 1 is complete. Commands run on the new machine as the service user.
`<host>` is the machine, `$PREVIEW_DIR` is where the repos live (example: `~/kitchntabs`).

## 2.1 Install prerequisites

```bash
# Docker Engine + Compose v2: follow https://docs.docker.com/engine/install/ubuntu/
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"            # log out/in afterwards

# Node.js 20+, pnpm, cloudflared, tools
sudo apt-get install -y git curl jq chrony
corepack enable && corepack prepare pnpm@latest --activate
# cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

Confirm: `docker compose version`, `node -v`, `cloudflared --version`, `timedatectl` (NTP synchronised).

## 2.2 Clone the repositories

The compose project expects the repos as **siblings** in one directory. Preview runs from a
published core image, so `dash-backend` is **not** cloned (this is the "image-only" mode).

```bash
mkdir -p "$PREVIEW_DIR" && cd "$PREVIEW_DIR"
git clone git@github.com:farandal/dash-backend-docker.git
git clone git@github.com:farandal/kitchntabs-backend-domain.git
git clone git@github.com:farandal/vanexa-backend-domain.git
cd dash-backend-docker && git checkout development && git pull
```

`git@github.com` needs a read-only **deploy key** (or machine user) on each of the three repos.

**Pull `development` before anything else.** It contains fixes the setup depends on: per-domain
`bootstrap/cache` isolation and the image-only overlay. Without the isolation, whichever
project starts last overwrites the other's cached DB credentials and routes.

## 2.3 Create the env files

Each project needs **two** files, both untracked and copied from the staging machine over a
secure channel (never through git or chat):

| File | Read by | Contains |
|---|---|---|
| `.env.<project>` | Docker Compose (`--env-file`) | Image tag, paths, ports, DB credentials, tunnel settings |
| `.env.<project>.preview` | The Laravel app (mounted as `/var/www/dash/.env`) | Full application config, `APP_KEY`, third-party keys |

Start from the staging equivalents and edit:

```bash
scp staging:dash-backend-docker/.env.kitchntabs        .env.kitchntabs
scp staging:dash-backend-docker/.env.kitchntabs.staging .env.kitchntabs.preview
# same for .env.vanexa and .env.vanexa.staging -> .env.vanexa.preview
```

Values that **must** change from staging, per project:

| File | Variable | Preview value |
|---|---|---|
| `.env.<project>` | `DASH_IMAGE` | A **pinned published tag**, e.g. `farandal/dash-backend:<tag>-core`. Never `:latest`. |
| `.env.<project>` | `ENV_FILE` | `.env.<project>.preview` |
| `.env.<project>` | `DOMAIN_PATH`, `STORAGE_PATH`, `DB_STORAGE_PATH` | Keep the staging values; they are relative to the repo |
| `.env.<project>` | `DB_DATABASE_TEST` | **Leave blank** (image-only mode has no test-DB script) |
| `.env.<project>` | `CF_TUNNEL_HOSTNAME_API_PREVIEW`, `CF_TUNNEL_HOSTNAME_WS_PREVIEW` | The preview hostnames from 1.1 |
| `.env.<project>` | `CF_TUNNEL_NAME` | `kitchntabs-preview-server` |
| `.env.<project>` | `CF_TUNNEL_TOKEN` | **Blank.** The token lives in a file outside the repo (2.4). |
| `.env.<project>.preview` | `APP_URL` | `https://api-preview.<domain>` |
| `.env.<project>.preview` | `REVERB_HOST` / `REVERB_PORT` / `REVERB_SCHEME` | `ws-preview.<domain>` / `443` / `https` |
| `.env.<project>.preview` | `SANCTUM_STATEFUL_DOMAINS` | Add the preview hostnames (and the preview frontends, if any) |
| `.env.<project>.preview` | `FRONTEND_URL` | The preview frontend URL |
| `.env.<project>.preview` | `APP_KEY` | Generate a **new** one (see below), do not reuse staging's |
| `.env.<project>.preview` | `DB_*` | Fresh credentials for preview |

`DB_USERNAME`, `DB_PASSWORD` and `DB_DATABASE` must match **between** the two files of a
project. The compose-level file creates the database; the app-level file connects to it.

Do **not** copy staging's secrets unchanged. In particular, `AWS_*`, payment and messaging keys
should be preview-specific so preview traffic cannot touch staging or production data.

Keep the two projects' ports as they are (25000/25001 and 25100/26001) for parity with staging.

## 2.4 Create the preview tunnel

Use a **dedicated** tunnel. Sharing one with staging or with developers' laptops means any
connector can receive preview traffic.

```bash
export CF_API_TOKEN=...            # scoped token from 1.6
export CF_ACCOUNT_ID=...           # Cloudflare account id
export CF_ZONE_KT=...              # zone id of kitchntabs.com
export CF_ZONE_VX=...              # zone id of vanexa.cl
H="Authorization: Bearer $CF_API_TOKEN"; API=https://api.cloudflare.com/client/v4

# 1. Create the tunnel (remotely managed) and capture its id
TUNNEL_ID=$(curl -s -X POST -H "$H" -H "Content-Type: application/json" \
  "$API/accounts/$CF_ACCOUNT_ID/cfd_tunnel" \
  --data '{"name":"kitchntabs-preview-server","config_src":"cloudflare"}' | jq -r .result.id)
echo "$TUNNEL_ID"

# 2. Save its connector token OUTSIDE the repo, readable only by the service user
sudo install -d -m 700 -o "$USER" /etc/cloudflared
curl -s -H "$H" "$API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" | jq -r .result \
  > /etc/cloudflared/preview-token && chmod 600 /etc/cloudflared/preview-token

# 3. Ingress: one rule per hostname, then the mandatory catch-all
curl -s -X PUT -H "$H" -H "Content-Type: application/json" \
  "$API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" --data '{
  "config":{"ingress":[
    {"hostname":"api-preview.kitchntabs.com","service":"http://localhost:25000"},
    {"hostname":"ws-preview.kitchntabs.com", "service":"http://localhost:25001"},
    {"hostname":"api-preview.vanexa.cl",     "service":"http://localhost:25100"},
    {"hostname":"ws-preview.vanexa.cl",      "service":"http://localhost:26001"},
    {"service":"http_status:404"}]}}' | jq '{success, errors}'

# 4. DNS: proxied CNAMEs to the tunnel (repeat per hostname, with the right zone id)
mkdns() { curl -s -X POST -H "$H" -H "Content-Type: application/json" \
  "$API/zones/$2/dns_records" \
  --data "{\"type\":\"CNAME\",\"name\":\"$1\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true}" \
  | jq '{success, errors}'; }
mkdns api-preview.kitchntabs.com "$CF_ZONE_KT";  mkdns ws-preview.kitchntabs.com "$CF_ZONE_KT"
mkdns api-preview.vanexa.cl      "$CF_ZONE_VX";  mkdns ws-preview.vanexa.cl      "$CF_ZONE_VX"
```

A PUT to `/configurations` **replaces** the whole ingress list. When adding a route later, GET
the current config first and send the full merged list, otherwise existing routes are dropped.

Hand `<TUNNEL_ID>` to IT if they manage DNS (1.6).

The repo also ships `scripts/cloudflare-tunnel.js` (`--env-suffix PREVIEW --push-only`) to do
steps 3–4 from the env files. If you use it, **verify with the API which tunnel the running
connector actually registered to** (3.1). On staging, the connector started through this script
with the dedicated tunnel's token file turned out to be registered on the shared `dash-dev`
tunnel, and the dedicated tunnel was down. Starting `cloudflared` directly from the token file
(2.6) avoids the question.

## 2.5 Start the application stack

Repeat for each project, from `dash-backend-docker/`. **Export `ENV_FILE` first**: without it,
`--force-recreate` silently falls back to the compose default `.env.<project>.local` and swaps
the container to local mode with no error.

```bash
cd "$PREVIEW_DIR/dash-backend-docker"

export ENV_FILE=.env.kitchntabs.preview
docker compose -f docker-compose.yml -f docker-compose.image-only.yml \
  --env-file .env.kitchntabs up -d

export ENV_FILE=.env.vanexa.preview
docker compose -f docker-compose.yml -f docker-compose.image-only.yml \
  --env-file .env.vanexa up -d
```

The two projects are separated by `COMPOSE_PROJECT_NAME` (`dash_image` and `vanexa_image`), so
always pass the right `--env-file`. Containers use `restart: unless-stopped` and come back with
Docker after a reboot. **The policy only applies to containers created after it was set**;
verify it (2.8).

First boot takes a few minutes: the container runs diagnostics, clears and rebuilds caches,
migrates, and only then starts supervisord, nginx and php-fpm. A 502 during that window is
normal.

Initialise the data:

```bash
export ENV_FILE=.env.kitchntabs.preview
docker compose --env-file .env.kitchntabs exec app php artisan key:generate --show   # paste into .env.*.preview, then recreate
docker compose --env-file .env.kitchntabs exec app composer install --no-interaction
docker compose --env-file .env.kitchntabs exec app php artisan migrate --force --seed
```

Repeat with `.env.vanexa`. Use `migrate:fresh --seed` only on a database you are happy to lose,
or restore a dump if preview should mirror existing data.

Also give the AI provider keys their real values now: the platform-wide DeepInfra key is stored
in the database (System → AI Providers) and, as a fallback, `VANEXA_DEEPINFRA_API_KEY` in the
app env. See [vanexa-backend-domain/docs/SYSTEM_SETTINGS.md](../vanexa-backend-domain/docs/SYSTEM_SETTINGS.md).

## 2.6 Run the tunnel connector at boot

Run **one** `cloudflared` process for this tunnel, straight from the token file, under systemd:

```ini
# /etc/systemd/system/cloudflared-preview.service
[Unit]
Description=Cloudflare Tunnel (kitchntabs-preview-server)
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=<service-user>
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run --token-file /etc/cloudflared/preview-token
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now cloudflared-preview
```

Two connectors on the same tunnel produce unstable connections and intermittent 502s. If you
ever run `cloudflared` by hand, stop the service first.

## 2.7 Optional: auto-update from git

The watcher polls the domain repos every 60 s and pulls, migrates and restarts on change. With
no `dash-backend` checkout, tell it to skip core tracking.

```bash
cd "$PREVIEW_DIR/dash-backend-docker/scripts/systemd"
cp dash-watcher.env.example dash-watcher.env
#   DASH_WATCHER_BRANCH=<branch preview tracks; use a release branch, not development>
#   DASH_WATCHER_SKIP_CORE=1
# Edit dash-watcher.service: User=, Group=, WorkingDirectory=, EnvironmentFile= for this machine
# (the shipped unit hardcodes /home/fablabadmin).
sudo cp dash-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now dash-watcher
```

Core (image) upgrades are not automatic in this mode. Change `DASH_IMAGE` to the new tag and
recreate the app containers (with `ENV_FILE` exported).

---

# Part 3 — Verification and operations

## 3.1 Acceptance checks

Run all of them before handing the environment over.

```bash
# Containers up, healthy, with the restart policy
docker ps --format 'table {{.Names}}\t{{.Status}}'
docker inspect dash_image_app vanexa_image_app --format '{{.Name}} {{.HostConfig.RestartPolicy.Name}}'   # unless-stopped

# Each project has its OWN cache and database (must print kt_dev_db / vx_dev_db-style, not swapped)
for c in dash_image_app vanexa_image_app; do
  docker exec $c php -r "\$k=include '/var/www/dash/bootstrap/cache/config.php'; echo '$c ', \$k['database']['connections']['pgsql']['database'], PHP_EOL;"
done

# Local ports answer
for p in 25000 25001 25100 26001; do curl -s -o /dev/null -w "$p %{http_code}\n" http://localhost:$p/; done

# Tunnel: healthy, exactly one connector on the PREVIEW tunnel id
curl -s -H "$H" "$API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID" | jq '{status, connections: (.result.connections|length)}'
ps aux | grep '[c]loudflared tunnel'          # exactly one

# Public
for h in api-preview.kitchntabs.com api-preview.vanexa.cl; do curl -s -o /dev/null -w "$h %{http_code}\n" https://$h/; done
```

WebSocket: open the app's frontend against preview and confirm a live connection (browser
dev-tools → Network → WS shows `wss://ws-preview.<domain>/app/...` in state 101).

Reboot test, the check that matters most: `sudo reboot`, wait a few minutes **without logging
in**, and repeat the public checks. Everything must return by itself.

## 3.2 Day-to-day

```bash
# status / logs (per project; always pass the matching env file)
docker compose --env-file .env.vanexa ps
docker compose --env-file .env.vanexa exec app tail -f /var/www/dash/storage/logs/laravel.log
docker compose --env-file .env.vanexa exec app supervisorctl -c /etc/supervisor/supervisord.conf status
docker compose --env-file .env.vanexa exec app supervisorctl -c /etc/supervisor/supervisord.conf restart all   # horizon/reverb/scheduler

journalctl -u cloudflared-preview -f         # tunnel
journalctl -u dash-watcher -f                # watcher
```

More commands: [QUICK_COMMANDS.md](./QUICK_COMMANDS.md).

## 3.3 Known failure modes

All of these have happened on staging.

| Symptom | Cause | Fix |
|---|---|---|
| Tunnel "healthy", public URL returns **502** | App container still booting, or nginx/php-fpm never started (entrypoint stuck before supervisord) | Wait for boot. If `docker exec <app> ps aux` shows no `php-fpm`/`nginx`, check `docker logs <app>` and `supervisorctl status`, then `docker restart <app>` |
| Vanexa works, KitchnTabs fails (or the reverse) after a restart; Postgres logs `password authentication failed for user "kt"` | Both projects shared one `bootstrap/cache`, so the last to boot overwrote the other's config | Use `development` ≥ commit `1c6b592` (per-project cache under `<STORAGE_PATH>/bootstrap-cache`). Immediate unblock: `php artisan config:clear && route:clear` in the affected container |
| A product's `/api/...` routes all return 404 | Same shared-cache cause, route cache | Same fix |
| Container came back in **local** mode after a recreate | `ENV_FILE` not exported before `--force-recreate` | `export ENV_FILE=.env.<project>.preview` and recreate |
| Random 502s, tunnel logs `Application error 0x0` | Two connectors on one tunnel, or stale registrations | One `cloudflared` only. List `.../cfd_tunnel/$TUNNEL_ID/connections`; `DELETE` that same path once to clear stale ones |
| "missing API key" / 401 from DeepInfra in agent turns | The turn's **tenant** is in `system_key` mode with no platform key, or `tenant_key` mode with no tenant key | Set the key at the level the tenancy uses (see SYSTEM_SETTINGS.md); check which tenant the failing session belongs to |
| Containers not back after reboot | Restart policy missing (containers predate it) | `docker inspect ... RestartPolicy.Name`; recreate with `ENV_FILE` exported |
| Preview hostnames unreachable, connector shows **down** | Outbound **7844** blocked, or the token file is for a different tunnel | Check 1.5; `journalctl -u cloudflared-preview`; confirm the token's tunnel id matches `$TUNNEL_ID` |

## 3.4 Security notes

- Tokens (`/etc/cloudflared/preview-token`, `CF_API_TOKEN`) are credentials. Keep them out of
  git, the repo directory and chat, and rotate any that leaks.
- The tunnel token belongs to one machine. Do not copy it to laptops.
- Admin access over SSH: key-only, restricted to admin IPs or a VPN. If remote admin is needed
  without opening 22, expose SSH through a Cloudflare route protected by a Cloudflare Access
  policy, as on staging, rather than publishing port 22.
- Preview must not reuse staging's `APP_KEY`, database credentials, or AWS/payment keys.
