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

> **Read Part 4 first.** This procedure was written before the first install and several steps were wrong or
> incomplete in practice: blank `DB_DATABASE_TEST` (2.3, corrected), the `docker-compose.image-only.yml`
> overlay (2.5) does not work on Compose v5, the wrong image can be built, env file modes and storage
> ownership need care, and the RAG vector index needs non-filterable metadata keys. The install that actually
> works is **staging's model** (base compose, `local/dash-backend-core:latest` built on the host, real core
> checkout, the git watcher), described in 4.5–4.9. Part 4.9 is the current state.

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
| `.env.<project>` | `DB_DATABASE_TEST` | **Do NOT leave blank** — Compose's `${DB_DATABASE_TEST:-dash_test}` treats blank as unset and substitutes `dash_test`, so `pgsql_setup` never turns healthy and `app` never starts. Keep the value (e.g. `kt_dev_db_test`) and create that empty database (see 4.6). |
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

---

# Part 4 — Record of the actual preview installation (2026-09-25)

> **Update 2026-09-26.** The install described in 4.5–4.6 (image tag `local/dash-backend:v1.4.0-core`, the
> `dash-backend-src` checkout, `docker-compose.image-only.yml`, exporting `ENV_FILE`) was later **converged onto
> staging's model** so the git watcher could run and the core image could be built on the host. Where 4.5–4.6
> and 4.9 differ, **4.9 is the current state**.

What was really done on the first preview install, in order, with what went wrong. Read this
before repeating the procedure: several steps in Parts 1–3 needed correcting (marked **⚠ differs
from Part 2**). No secret values are recorded here.

| | |
|---|---|
| Machine | `172.20.20.80`, Ubuntu 24.04.2, 8 vCPU, **15 GB RAM**, 98 GB disk (Part 1.3 asks for 32 GB / 500 GB) |
| Service user | `fablabadmin` (in `docker` and `sudo`), repos under `~/` |
| Stacks | KitchnTabs (`dash_image_*`, ports 25000/25001) and Vanexa (`vanexa_image_*`, 25100/26001) |
| Tracks | branch `production`, tag **`v1.4.0`** (staging tracks `development`) |
| Exposure | Cloudflare Tunnel `kitchntabs-preview-server`, final hostnames `api-preview.*` / `ws-preview.*` |

## 4.1 Starting state

Docker 29 and Compose 5.5 were installed, and the Postgres/Redis/MailHog containers of both
projects had been running for 8 days, but there was **no app container**, no `cloudflared`, no
`jq`/node/pnpm, and preview env files that were still copies of the old dev values. The domain
repos were on `production`; `~/dash-backend` was a stale, non-git directory (see 4.6). GitHub
access is over HTTPS with a token embedded in each remote URL, not SSH deploy keys.

## 4.2 Release: development → production, tagged v1.4.0

Preview follows `production`, so the first release was cut before installing.

| Repo | Action | Commit |
|---|---|---|
| `dash-backend` | fast-forward `production` to `development`, tag `v1.4.0` | `d10d99a` |
| `vanexa-backend-domain` (remote `farandal/fablabos`) | fast-forward, tag `v1.4.0` | `1c5e7a2` |
| `kitchntabs-backend-domain` | branches were already identical, tag `v1.4.0` | `756030d` |
| `dash-backend-docker` | **no `production` branch existed**, created from `development`, tag `v1.4.0` | `19b1237` |

Pushes were fast-forward only. Caveats:

- The `v1.4.0` tag in `dash-backend` was **moved once** (force-updated) to include commit
  `d10d99a` (see 4.5). It was minutes old and unused, but anyone who fetched the first `v1.4.0`
  must `git fetch --tags --force`.
- Pushing to `development` makes the **staging** git watcher redeploy. Staging containers restarted
  shortly after; a brief staging tunnel outage was reported at about the same time. The link is
  probable but not confirmed. Warn whoever uses staging before pushing.
- Shell trap while doing this: in zsh `"$DEV:refs/heads/production"` is read as a `:r` modifier.
  Use `"${DEV}:refs/heads/production"`.

## 4.3 AWS: four isolated buckets and a dedicated knowledge base

Nothing in staging's env files names a bucket (staging uses `MEDIA_DISK=local`), so the buckets
were derived from the code (`config/filesystems.php`, `config/lab_rag.php`). Everything is in
`us-east-2`, account `635862864028`, created with the `KitchenTabs` admin profile.

| Purpose | Env variable | Preview resource | Staging/prod equivalent |
|---|---|---|---|
| Public media | `AWS_BUCKET` | `kitchntabs-preview` | `kitchntabs-dev` |
| Private files | `AWS_PRIVATE_BUCKET` | `kitchntabs-preview-private` | `kitchntabs-dev-private` |
| RAG documents | `LAB_RAG_DOCUMENTS_BUCKET` | `vanexa-preview-lab-documents` | `vanexa-lab-documents` |
| RAG vectors (S3 Vectors) | `LAB_RAG_VECTOR_BUCKET` | `vanexa-preview-lab-kb-vectors` | `vanexa-lab-kb-vectors` |

Settings copied from the dev buckets: SSE-AES256, `BucketOwnerEnforced`, no versioning. The
private and RAG buckets block all public access. `kitchntabs-preview` mirrors dev (ACLs blocked,
public policy allowed) but its policy grants anonymous `s3:GetObject` **only** — dev also grants
`ListBucket`, which was not copied.

The RAG side was created with `vanexa-ci-cdk/scripts/provision-lab-rag.sh`, run with names
overridden by environment variables (`DOC_BUCKET`, `VECTOR_BUCKET`, `ROLE_NAME`, `KB_NAME`,
`DATA_SOURCE_NAME`), producing role `vanexa-preview-lab-kb-role`, KB `S2Q8P5IUUH` and data
source **`MCHFZMQLRK`** (the first data source, `IQWFKSFN3K`, was deleted and replaced — see
4.8). Caveats:

- **⚠ The vector index must be created with non-filterable text keys.** The script originally
  created it without `--metadata-configuration`; ingestion then failed for some documents with
  *"Filterable metadata must have at most 2048 bytes (S3 Vectors)"* (10–15 of 98, no per-document
  reason shown, and retries did not help). An index cannot be altered, so it was deleted and
  recreated with `{"nonFilterableMetadataKeys":["AMAZON_BEDROCK_TEXT","AMAZON_BEDROCK_METADATA"]}`,
  the data source was recreated, and ingestion then indexed 98/98. The script now does this, but
  staging's index (`vanexa-lab-kb-vectors`) was created without it and currently works only because
  its chunks happen to fit; expect the same failure there on larger or accented documents.

- The script needed two edits, **still uncommitted in `vanexa-ci-cdk` for review**: those names
  are now overridable (defaults unchanged), and a `KB_MULTIMODAL=false` switch was added.
- AWS now rejects the script's multimodal setup ("supplemental data storage bucket contains a
  sub-folder"), so the preview KB was created with **default text-layer parsing and no
  supplemental storage** (`KB_MULTIMODAL=false`) — the same as staging's existing KB. Scanned or
  image-only PDFs are not indexed. The unfixed script fails the same way for anyone creating a
  new multimodal KB.
- `LAB_RAG_TENANT_ISOLATION=false` on preview for now (shared KB). The per-tenant switch and role
  are in place if you want it on.
- **The app's AWS key is staging's key, which has `AdministratorAccess`.** The buckets are
  isolated by name, but the credential is not. A key scoped to the preview buckets is the real
  isolation and is still to do.
- Region: production runs S3 and Bedrock both in `us-east-2`, so preview sets `AWS_REGION` and
  `AWS_DEFAULT_REGION` to `us-east-2` (Vanexa staging uses `us-east-1`). Vanexa **agent turns on
  Bedrock in `us-east-2` have not been tested** here.
- `AWS_URL` and `AWS_ENDPOINT` default to the **dev bucket** in `config/filesystems.php`. Setting
  only `AWS_BUCKET` uploads to the new bucket but serves URLs from `kitchntabs-dev`. Set both.

## 4.4 Cloudflare tunnel and DNS

Created with the Cloudflare API (procedure 2.4): tunnel `kitchntabs-preview-server`
(`f9e193e0-039d-401e-bfe2-ae6e0f47cd0a`), ingress `api-preview.kitchntabs.com`→`:25000`,
`ws-preview.kitchntabs.com`→`:25001`, `api-preview.vanexa.cl`→`:25100`, `ws-preview.vanexa.cl`→`:26001`,
then a `404` catch-all; four proxied CNAMEs to `<tunnel-id>.cfargotunnel.com`. The final hostnames
are used from day one, so switching to direct DNS later is a record change with no app or
frontend change. `cloudflared` (deb, v2026.9.3) runs as `cloudflared-preview.service` from
`/etc/cloudflared/preview-token` (mode 600); the tunnel reported healthy with 4 connections.

- **⚠ The staging Cloudflare API token was reused** to create the tunnel and DNS. It was used only
  from the operator's workstation and never stored on the preview machine. A separate preview
  token was requested afterwards and is still to be created; rotate/replace as needed. The
  machine only holds the tunnel's own connector token.
- Both zones already existed in the same Cloudflare account and no preview record existed
  beforehand; check that first, since creating a duplicate name would fail or overwrite.
- WebSockets are on the **`ws-preview.*` hostname** (`/app/<key>`), not on the API host. The
  in-app `/ws` test page connects to `REVERB_HOST`. Test the upgrade over **HTTP/1.1**
  (`curl --http1.1`); over HTTP/2 the handshake returns 500 and looks like a failure.

## 4.5 The core image (the wrong turn)

`DASH_IMAGE` was first **`local/dash-backend:v1.4.0-core`** (superseded by `local/dash-backend-core:latest`, see 4.9), built on the preview machine (amd64)
from the tagged core:

```bash
git clone --branch v1.4.0 --depth 1 <dash-backend url> ~/dash-backend-src
cd ~/dash-backend-src && ./docker-publish-core.sh --hub-user local --tag v1.4.0-core --skip-push
```

This builds `Dockerfile.core.production` (PHP 8.5 on Debian, nginx + php-fpm, supervisor programs
Horizon, Reverb and the scheduler, app user `dash`). Staging's image is a locally built
arm64 image and cannot be copied to an x86 host, hence the local build.

**⚠ Do not build `docker/php8.3/Dockerfile.core`.** That is the *dev/sail* image: it serves with
`php -S`, runs only one supervisor program and runs PHP as user `sail` (uid 1337). It was built
first by mistake, cost roughly 40 minutes, and produced a container with no Horizon or Reverb.
Its `composer install` also failed (`phpoffice/phpspreadsheet 1.30.x` requires `<8.5.0` but
`composer.json` pins platform PHP 8.5.0), which led to commit `d10d99a`
(`--ignore-platform-req=php` in that Dockerfile and in `start-container`). That change is
harmless but **was not needed for the production image**, which runs `composer update -W` and
resolves it. Keep or revert it deliberately; the underlying fix is bumping `maatwebsite/excel`
and `phpspreadsheet`.

## 4.6 Env files, compose fixes and first start

Env changes (backups of the previous files were left as `.env.<project>[.preview].bak-<timestamp>`):

- `.env.<project>` (compose): `DASH_IMAGE`, `ENV_FILE=.env.<project>.preview`, `CF_TUNNEL_NAME`,
  new `DB_PASSWORD`, `CF_TUNNEL_TOKEN` blank, **`BACKEND_PATH=../dash-backend-src`** (see below).
- `.env.<project>.preview` (app): new `APP_KEY`, new `DB_PASSWORD`, region `us-east-2`,
  `MEDIA_DISK=s3`, `MEDIA_PRIVATE_DISK=s3-private`, the four bucket variables plus `AWS_URL` and
  `AWS_ENDPOINT`; Vanexa also gets the `LAB_RAG_*` set, `SOCIAL_FEED_ENABLED=true` and a
  `SANCTUM_STATEFUL_DOMAINS` list.
- The database password was rotated **in place** with `ALTER USER` on the existing Postgres
  container (the volume was empty), before recreating the containers. Redis's password was **not**
  rotated and is still shared with the old files.

Problems hit, in the order met, each of which SETUP Parts 2–3 did not mention:

1. **`pgsql_setup` never healthy → `app` stays `Created`.** Blank `DB_DATABASE_TEST` is replaced by
   `dash_test` (see the corrected 2.3 row). Fix: keep `kt_dev_db_test` / `vx_dev_db_test` and
   create those empty databases (`CREATE DATABASE … OWNER <user>` via `psql` in the pgsql container).
2. **`OCI runtime … not a directory` on `phpunit.xml`.** `docker-compose.image-only.yml` says it
   "drops every `${BACKEND_PATH}` mount", but on Compose v5 the overlay's `volumes` are **merged**
   with the base file's, so the base mounts remain. With no `dash-backend` checkout Docker had
   created stale empty directories at those paths, and the mount failed. Fix used:
   `BACKEND_PATH=../dash-backend-src`, i.e. the checkout the image was built from, so the mounted
   files equal the image's own. **Consequence: `~/dash-backend-src` must always be at the same tag as
   `DASH_IMAGE`**, so this is not truly "image-only". Fixing the overlay (`!override` on `volumes`)
   is a follow-up in this repo.
3. **`docs/api-docs` missing** → `mkdir -p docs/api-docs` (an empty dir is enough).
4. **500 with "No application encryption key" and `APP_ENV=local`.** I had set the app env files to
   mode `600`; PHP runs in the container as a different uid (group 1000), could not read `.env`, and
   fell back to defaults. Use **`640`** (owner + group read, group = the service user's group).
   Not `644` — these files hold secrets.
5. **500 `file_put_contents(…/storage/framework/views/…): Permission denied`.** The storage
   folders had been created by the dev image's `sail` user (uid 1337); the production image writes
   as `dash` (uid 1000, gid 33). Fix (needs sudo), **excluding `pgsql-data`**, which belongs to Postgres:

   ```bash
   sudo find storage/<project>-backend-domain -path '*/pgsql-data' -prune -o -exec chown 1000:33 {} +
   ```

6. The entrypoint runs the migrations itself on boot (216 tables KitchnTabs, 84 Vanexa were
   present before I ran anything); `php artisan migrate --force --seed` afterwards completed with
   no errors.

Always run `docker compose … up -d` with the matching `--env-file` (the `ENV_FILE` export turned out to be unnecessary when `--env-file` is given, see 4.9), and use
`setsid nohup … &` for anything that outlives the SSH session. Do not use `pkill -f <pattern>`
inside an `ssh '…'` one-liner: the pattern matches the shell's own command line and kills it.

## 4.7 Verified state

- Both APIs answer `200` locally and at `https://api-preview.kitchntabs.com` and
  `https://api-preview.vanexa.cl`.
- WebSocket upgrade returns `101` on `ws-preview.*` locally and through the tunnel.
- Each app is configured for its preview buckets and writes, reads and deletes on the public and
  private bucket; Vanexa reads the preview RAG bucket names and KB `S2Q8P5IUUH`.
- Each container runs nginx, php-fpm, Horizon, Reverb and the scheduler, as on staging.

**Not verified — no automated test suite was run for this install:** a real login, an agent turn on
Bedrock in `us-east-2`, a RAG upload/ingest/search, the social-media sync, mail, and the **reboot
test** (3.1). Do the reboot test before calling preview handed over.

## 4.8 Copying tenants from staging (LDP Magazine, John Hopkins)

Done on 2026-09-25 with `vanexa-backend-domain/scripts/copy-tenant-between-envs.php`
(uncommitted at the time of writing). One tenant at a time: its tenancy, tenant, users and roles,
subscription and marketplace links, MCP servers, Labs, documents and their selections, and (if
present) social sources and posts. **Not copied:** session/observation/usage history, kiosk photos,
device nodes and devices (they point at staging), API keys and Sanctum tokens.

| Tenant | Result |
|---|---|
| LDP Magazine (3 Labs) | 1 tenancy, 1 tenant, 1 user, 225 documents, 3 social sources, 36 posts, 1 MCP server |
| John Hopkins (1 Lab) | 1 tenancy, 1 tenant, 1 user, 3 documents, 3 MCP servers |

Procedure (all steps are read-only on staging):

1. **Export on staging**, inside the app container:
   `MODE=export TENANT_NAME="<name>" OUT=/tmp/x.json php /tmp/copy-tenant.php`.
   Encrypted values are **decrypted with staging's `APP_KEY`**, because preview has its own key:
   `tenants.settings` / `tenancies.settings` sub-keys, `ai_agent_mcp_servers.auth_token`, and the
   platform `ai_system_provider_keys.credentials` (DeepInfra, Apify).
2. **Move the file** to preview through a mode-600 hop. It contains plaintext secrets and password
   hashes; it must never be printed or committed, and is shredded on both machines afterwards.
3. **Dry run on preview** (`MODE=import IN=… php …`, rolled back), then `APPLY=1`. Already-existing
   primary keys are skipped, so it is re-runnable. Foreign keys are deferred and an orphan check
   runs before commit. The two currencies differ per environment (CLP has a different UUID) and are
   remapped by code; roles, languages, plans and marketplaces have identical integer ids in both.
4. **Copy files** (not done by the script):
   - RAG objects, bucket to bucket inside S3:
     `aws s3 sync s3://vanexa-lab-documents/<tenant_id>/ s3://vanexa-preview-lab-documents/<tenant_id>/`
     (includes the `.metadata.json` sidecars).
   - Media (thumbnails, page images, character assets, social images) from staging's disk:
     `aws s3 sync storage/vanexa-backend-domain/app/<tenancy_id>/ s3://kitchntabs-preview/<tenancy_id>/`
     run **on the staging host**, which has an AWS CLI and staging's key. LDP was 313 objects, 1.99 GB.
5. **Re-ingest** into the preview KB (`start-ingestion-job`, or dispatch `SyncLabKnowledgeBaseJob`).

Caveats:

- Users keep their **staging password hash**, so they log in with their staging passwords.
- Platform credentials were copied only into rows that were empty on preview.
- Preview runs with `LAB_RAG_TENANT_ISOLATION=false`, so all copied tenants share one KB. On staging,
  the John Hopkins tenant is on the per-tenant KB allowlist; on preview it is not.
- When the data source id changes, update `LAB_RAG_DATA_SOURCE_ID` in the app env **in place**
  (rewrite the file without replacing it; `sed -i` swaps the inode and the single-file bind mount
  keeps serving the old content) and restart the app so its cached config is rebuilt.
- After copying, a real login and an agent turn on preview are still to be verified.

## 4.9 Converging on staging's model, the watcher, and the kiosk page (2026-09-26)

The request was to run the auto-update watcher on preview **and** build the core image on the host. The
watcher (`scripts/git-watcher.js`) assumes staging's layout, so preview was moved to it.

What the watcher assumes, and what that meant:

| Assumption in `git-watcher.js` | Consequence on preview |
|---|---|
| Core checkout at `../dash-backend`, a git repo on the tracked branch, with history | `~/dash-backend` had to become a real full clone on `production` (the first install had left a root-owned, Docker-created empty tree there; it was **renamed** to `dash-backend.stale-<timestamp>`, not deleted) |
| Runs `docker compose --env-file .env.<project>` only, with **no** `-f` overlay | The `docker-compose.image-only.yml` overlay could no longer be used; preview now runs the **base** `docker-compose.yml` like staging |
| Builds and tags **`local/dash-backend-core:latest`** with `Dockerfile.core.production` and `INSTALL_DEV_DEPS=true` | `DASH_IMAGE=local/dash-backend-core:latest` in both `.env.<project>`; the image carries dev dependencies (as on staging) |
| Needs `node` | Ubuntu's `nodejs` (18.19.1) installed with apt; the script uses only built-in modules, so no pnpm |

Steps, in order:

1. `sudo apt-get install nodejs`; renamed the stale `~/dash-backend`; `git clone --branch production` of the core
   into `~/dash-backend` (branch `production`, `d10d99a`, clean tree).
2. Built the image **on the host, while the old containers kept serving**, with the watcher's exact command:
   `docker build -f Dockerfile.core.production -t local/dash-backend-core:latest --build-arg INSTALL_DEV_DEPS=true .`
   (about 11.5 minutes cold; 860 MB image).
3. Edited `.env.kitchntabs` and `.env.vanexa`: `DASH_IMAGE=local/dash-backend-core:latest`, `BACKEND_PATH=../dash-backend`.
4. Recreated both apps with `docker compose --env-file .env.<project> up -d --force-recreate app` (base file only).
   Result: 5 of 5 processes per container (nginx, php-fpm, Horizon, Reverb, scheduler), API `200`, WebSocket `101`.
   The containers mounted the preview app env file **without `ENV_FILE` being exported**, so the earlier advice to
   export it was unnecessary when `--env-file` is passed.
5. Installed the watcher: `scripts/systemd/dash-watcher.env` with `DASH_WATCHER_BRANCH=production` (no
   `DASH_WATCHER_SKIP_CORE`, core tracking is on), the shipped unit copied unchanged to
   `/etc/systemd/system/dash-watcher.service` (it already uses `fablabadmin` and `/home/fablabadmin`),
   `systemctl enable --now dash-watcher`. First cycles logged `no changes`.
6. **Tested the domain path for real:** `git reset --hard HEAD~1` in `~/vanexa-backend-domain` so it was genuinely
   behind `origin/production`; the watcher pulled `8f0fb6f → 1c5e7a2` on its next poll, applied the update in 20 s
   (composer, migrate, optimize:clear, supervisor restart) and the app stayed healthy.
   The core path (pull, rebuild, recreate both apps) was exercised later the same day by a real release: promoted at
   00:40:56, image rebuilt in 3.5 min (warm cache), both projects updated by 00:46:34, no manual step.

Caveats:

- The watcher follows the **branch tip**, not tags. It skips a repo silently (only a journal warning) if it is not on
  `production`, has uncommitted changes, or has diverged, so do not edit or `git reset` the host checkouts (the test in
  step 6 was a deliberate exception and left the tree clean).
- It does not follow `dash-backend-docker` (compose, `domain-config-layers`, the watcher itself) or the env files.
- `local/dash-backend-core:latest` is a floating tag: rollback means stopping the watcher, checking out the previous
  commit in `~/dash-backend`, rebuilding, recreating, and moving `production` back before restarting the watcher.
- Pushes to `production` now restart preview (as pushes to `development` restart staging).
- It needs working git credentials on the host, which today means the token embedded in the remote URLs (including
  the new core clone). Rotating that token means updating the remotes on all three checkouts.
- Obsolete and safe to remove: `~/dash-backend-src`, `~/dash-backend.stale-*`, and the image
  `local/dash-backend:v1.4.0-core` (3.6 GB).

**Kiosk card page.** The Android kiosk on preview showed "content unavailable". Cause: `LAB_KIOSK_AGUI_URL` (the
page that draws the AG-UI cards, `vanexa-app` `/kiosk-agui`) was set on staging but never added to preview's env.
Fixed by adding `LAB_KIOSK_AGUI_URL=https://app.vanexa.cl/kiosk-agui` to `.env.vanexa.preview` (in place) and restarting
the app; the backend then served the value and the page returned `200` against `api-preview`/`ws-preview`. The kiosk
must be relaunched to pick it up. **Side effect still to resolve:** staging's value also points at `app.vanexa.cl`,
which after the frontend redeploy below is wired to preview, so staging kiosks now mix a staging session with a
preview page. It should become `https://app-staging.vanexa.cl/kiosk-agui`.

**Frontends (2026-09-25).** The three production apps (`system.vanexa.cl`, `vanexa.cl`/`www`, `app.vanexa.cl`) were
rebuilt against `api-preview` / `ws-preview.vanexa.cl`, and the three staging apps were deployed for the first time to
`system-staging`, `web-staging` and `app-staging.vanexa.cl` against staging. This was done by editing the gitignored
`apps/vanexa-<app>/.env.vanexa-<app>.production` and `.staging` files and running
`node scripts/deploy-frontend.js production …` from `vanexa-ci-cdk`; the live bundles were checked for the right
backend hostnames and CORS was verified for all seven origins. See `vanexa-backend-domain/docs/PREVIEW-ENV.md` §6.

## 4.10 Open items

- [ ] Create a dedicated Cloudflare API token for preview and stop using staging's.
- [ ] Reboot test with nobody logged in (containers come back, `cloudflared-preview` returns).
- [ ] Block DB/Redis/MailHog ports at `DOCKER-USER`/network level (they listen on `0.0.0.0`).
- [ ] Preview-scoped AWS credentials instead of staging's admin key; rotate Redis password.
- [ ] Fix staging's `LAB_KIOSK_AGUI_URL` (see 4.9).
- [ ] Delete the obsolete `~/dash-backend-src`, `~/dash-backend.stale-*` and the image `local/dash-backend:v1.4.0-core`.
- [ ] Rotate the GitHub token embedded in the git remote URLs on the machine (it was printed to a
      terminal during this install), and move to a credential helper or deploy keys.
- [ ] Commit or discard the `provision-lab-rag.sh` changes in `vanexa-ci-cdk`; decide on `d10d99a`.
- [ ] `docker-compose.image-only.yml` does not drop the base mounts on Compose v5 (4.6 item 2); fix it with `!override`, or retire it, since preview no longer uses it.
- [ ] RAM is 15 GB against the recommended 32 GB for two full stacks; watch memory under load.
- [ ] `FRONTEND_URL` on preview still points at the production sites; review it.
