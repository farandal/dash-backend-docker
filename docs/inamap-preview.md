# INAMAP on the preview box (172.20.20.80)

Adds inamap to the Linux box that already runs kitchntabs and vanexa on the `production` branch.
Same watcher pattern as the Mac staging box ([PM2_AUTOMATION.md](../PM2_AUTOMATION.md)), but the
supervisor here is **systemd** (`dash-watcher.service`), not pm2 — there is no pm2 on this box.
Background: [SETUP.md](../SETUP.md) Part 4 (how the box was built), [watcher.md](./watcher.md).

| | |
|---|---|
| Box | `fablabadmin@172.20.20.80` |
| Tracks | `production` (`DASH_WATCHER_BRANCH`, already set) |
| Backend hostnames | `api.inamap.space`, `ws.inamap.space` |
| Host ports | app `25200`, reverb `27001`, pgsql `25434`, redis `25389`, mailhog `25029`/`25030` — none collide with kitchntabs (`250xx`, `25432`, `25379`) or vanexa (`251xx`, `25433`, `25388`, `26001`) |
| Frontend | Cloudflare Pages, published by the watcher (§7) |

> **Capacity.** SETUP.md §4.10 already flags this box as 15 GB against a recommended 32 GB for two
> stacks. The Mac staging box was OOM-killed repeatedly with three. Watch `free -h` / `docker stats`
> under load. The release valve here is manual: set `ACTIVE_PROJECTS=kitchntabs,vanexa` in
> `.env.projects` (read fresh every cycle, no restart) and `docker compose stop` in
> `~/inamap-backend-docker`. Do not use `scripts/toggle-project.sh` on this box: it ends in an
> unguarded `pnpm exec pm2 save` and fails without pm2.

## 1. Branches (done 2026-10-13)

`production` was created from `origin/development` on `inamap-backend-domain`,
`inamap-frontend-domain` and `inamap-backend-docker`. They are plain aliases of `development`
until promoted; promote by fast-forward only (see the `vanexa-backend-deploy` skill §2):

```bash
git -C <repo> fetch -q origin
git -C <repo> log --oneline origin/production..origin/development   # what ships
git -C <repo> log --oneline origin/development..origin/production   # must print nothing
NEW=$(git -C <repo> rev-parse origin/development)
git -C <repo> push origin "${NEW}:refs/heads/production"            # braces: zsh :r modifier trap
```

`dash-backend-docker` already had a `production` branch. The watcher code that knows about inamap
is on its `development` only — fast-forward `production` the same way before pulling it on the box
(§2), or check out `development` on the box.

## 2. Get the inamap-aware watcher onto the box

```bash
ssh fablabadmin@172.20.20.80
cd ~/dash-backend-docker
git fetch origin && git log --oneline HEAD..origin/production     # sanity check what is incoming
git pull --ff-only
```

**Before restarting the watcher**, set these in `scripts/systemd/dash-watcher.env`
(`dash-watcher.env.example` documents each):

```
INAMAP_FRONTEND_ENV=production
INAMAP_TOOLCHAIN_BIN=/home/fablabadmin/.local/node/bin
```

`INAMAP_FRONTEND_ENV` is what keeps the frontend hook off the staging Pages projects: unset, the
script's default profile is `staging`, and a moved `inamap-frontend-domain` commit would overwrite
the Mac's `inamap-*-staging` sites. `DASH_WATCHER_SKIP_FRONTEND=1` is the alternative if a host
should not publish a frontend at all.

## 3. Clone the three repos as siblings of `dash-backend-docker`

```bash
cd ~
git clone -b production https://github.com/farandal/inamap-backend-docker.git
git clone -b production https://github.com/farandal/inamap-backend-domain.git
git clone -b production https://github.com/farandal/inamap-frontend-domain.git   # only needed once §7 is decided
```

Use the same remote form that already works for `kitchntabs-backend-domain` here (token or deploy
key — check `git -C ~/kitchntabs-backend-domain remote -v`). The watcher requires each repo to be
on `production`, clean, and fast-forwardable, otherwise it skips with a `warn` line.

## 4. Env files

```bash
cd ~/inamap-backend-docker
cp .env.example .env
cp .env.app.example .env.app.production
mkdir -p storage/app-storage/{app/public,framework/{cache,sessions,views},logs} \
         storage/bootstrap-cache storage/pgsql-data reports
```

`.env` (compose level): `DASH_IMAGE=local/dash-backend-core:latest` — the image the watcher already
builds here for kitchntabs/vanexa from `dash-backend` `production` (the published
`farandal/dash-backend:latest-core` also works but is older; used on 2026-10-13 after checking that
every `App\\` class the inamap domain imports exists in that core). Note the watcher does not recreate
`inamap_app` when the image is rebuilt: `docker compose up -d --force-recreate app` by hand,
`APP_ENV_FILE=./.env.app.production`, a real `DB_PASSWORD` (`openssl rand -hex 16`, same value in
both files). **Keep `DB_DATABASE_TEST` set** — blank becomes a default and leaves `pgsql_setup`
unhealthy with `app` stuck in `Created`.

`.env.app.production`: `APP_ENV=local`, `APP_DEBUG=true`, `LOG_LEVEL=debug` (same as every pre-prod
tier here), `APP_KEY=base64:$(openssl rand -base64 32)`, `APP_URL=https://api.inamap.space`,
`REVERB_HOST=ws.inamap.space`, `REVERB_PORT=443`, `REVERB_SCHEME=https`, fresh
`REVERB_APP_ID/KEY/SECRET` mirrored into `PUSHER_APP_ID/KEY/SECRET`, `PUSHER_APP_PORT=443`,
`PUSHER_APP_SCHEME=https`. Leave `FRONTEND_URL` / `INAMAP_APP_URL` as placeholders until §7.
Generate the three `*_PASSWORD` seed values with `openssl rand -hex 10`.

Do this **before** first boot (600 makes php-fpm unable to read the file: 500 "No application
encryption key"; 644 exposes secrets):

```bash
chmod 640 .env .env.app.production
```

Env files are single-file bind mounts: edit them in place (`cat new > file`), never `sed -i`, then
`docker restart inamap_app`.

## 5. Bring it up

```bash
cd ~/inamap-backend-docker
docker compose up -d && sleep 10 && docker compose ps
sudo find storage/app-storage -exec chown 1000:33 {} +     # not storage/pgsql-data
docker compose exec app php artisan db:seed                  # once; migrate runs on boot
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:25200/    # 502 for ~1 min on a fresh app is normal
```

## 6. Cloudflare Tunnel

A **dedicated** tunnel (`inamap-preview-server`), never shared with the Mac staging box's
`api-staging.inamap.space` tunnel. Ingress: `api.inamap.space` → `http://localhost:25200`,
`ws.inamap.space` → `http://localhost:27001`, fallback `http_status:404`; proxied CNAMEs to
`<tunnel id>.cfargotunnel.com`. Create it through the Cloudflare API (account and zone ids and the
token come from the existing `.env.*` on the box or the dashboard — not recorded here), store the
connector token at `/etc/cloudflared/inamap-preview-token` (mode 600), and run it as a unit:

```ini
# /etc/systemd/system/cloudflared-inamap.service
[Unit]
Description=Cloudflare Tunnel (inamap-preview-server)
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=fablabadmin
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run --token-file /etc/cloudflared/inamap-preview-token
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now cloudflared-inamap
```

One connector per tunnel only (two connectors on one tunnel produce random 502s).

## 7. Frontend — Cloudflare Pages, published by the watcher

Production hostnames: `inamap.space` + `www.inamap.space` (web), `app.inamap.space`,
`system.inamap.space`; Pages projects `inamap-web`, `inamap-app`, `inamap-system`
(production branch `production`, direct upload).

`scripts/inamap-frontend-deploy.js` with `INAMAP_FRONTEND_ENV=production` generates the apps'
`.env` files from the production hostnames plus the backend's `REVERB_APP_KEY`, builds with a
frozen lockfile and runs `wrangler pages deploy`. The watcher runs it when `inamap-frontend-domain`
moves or when the commit recorded in `.inamap-frontend-production.sha` is stale (retry every
15 min). The box's system node is 18, so the build uses a user-local Node 22 + pnpm 11.17.0 via
`INAMAP_TOOLCHAIN_BIN`. Needs `.env.inamap-pages` (`CF_ACCOUNT_ID`, and a `CF_API_TOKEN` with
**Account → Cloudflare Pages → Edit** only).

Full procedure, the Pages/DNS provisioning calls and the token steps are in
`inamap-documentation/devops/preview-env.md` (§6, §11).

## 8. Verify

```bash
sudo systemctl restart dash-watcher        # the repo list is code: a restart is required
journalctl -u dash-watcher -f              # expect inamap-backend-domain "no changes", no "not on production" warn
docker compose -f ~/inamap-backend-docker/docker-compose.yml ps
curl -s -o /dev/null -w '%{http_code}\n' https://api.inamap.space
curl -s --http1.1 -i -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "https://ws.inamap.space/app/<REVERB_APP_KEY>?protocol=7" | head -1   # 101
free -h && docker stats --no-stream
```

Reboot test: after `sudo reboot`, `inamap_app` and `cloudflared-inamap` must come back with nobody
logged in.

### php-fpm keeps old code

`supervisorctl restart all` does not restart php-fpm (`opcache.validate_timestamps=Off`), so the
watcher now restarts the app container after every domain-only deploy (~1 min of API downtime).
Verify a deploy by hitting the changed endpoint through the public hostname, not by the log.
The 2026-10-13 install is recorded in `inamap-documentation/devops/preview-env.md`.

## Open items

- `CF_API_TOKEN` (Pages:Edit only) in `.env.inamap-pages` on the box; until it is there a frontend
  change fails fast and retries every 15 min. The first release was published from a workstation.
- Cloudflare token for this tunnel/DNS was staging's, used from a workstation; get a dedicated one.
- `production` is an alias of `development` on all three repos, so there is no release gate yet.
