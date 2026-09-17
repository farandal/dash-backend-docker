1. Docker Engine (native, not Desktop)

# Docker requirements

sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker fablabadmin     # so fablabadmin doesn't need sudo for docker/compose
sudo systemctl enable --now docker      # boot-persistent, no GUI/login needed
docker compose version                  # sanity check — must print v2.x
Log out/in once for the group membership to take effect.

2. One-time bootstrap of both stacks

cd ~/dash-backend-docker

for project in kitchntabs vanexa; do
  docker compose --env-file .env.$project up -d
  sleep 4
  docker compose --env-file .env.$project exec app composer install --no-interaction \
    || docker compose --env-file .env.$project exec app composer update --no-interaction
  docker compose --env-file .env.$project exec app php artisan migrate --force
done

docker ps --format "table {{.Names}}\t{{.Status}}"
docker inspect dash_image_app   --format 'Policy: {{.HostConfig.RestartPolicy.Name}}'   # expect unless-stopped
docker inspect vanexa_image_app --format 'Policy: {{.HostConfig.RestartPolicy.Name}}'   # expect unless-stopped
This assumes .env.kitchntabs / .env.vanexa (compose-level) and the .env.<project>.<environment> (Laravel-level, referenced via ENV_FILE= inside each) already exist on this box — copy them over from your Mac's dash-backend-docker/ the way tools/dash_setup handles secrets, or recreate them from .env.example/.env.local.example.

3. Auto-deploy: git-watcher, branch from config, supervised by systemd
I made the branch config-driven — git-watcher.js now reads DASH_WATCHER_BRANCH (defaulting to development) instead of a hardcoded value, and I added the systemd equivalent of the Mac launchd files:

scripts/systemd/dash-watcher.service
scripts/systemd/dash-watcher.env.example
Install on the server:


cd ~/dash-backend-docker
cp scripts/systemd/dash-watcher.env.example scripts/systemd/dash-watcher.env
# edit if needed — DASH_WATCHER_BRANCH=development

sudo cp scripts/systemd/dash-watcher.service /etc/systemd/system/dash-watcher.service
sudo systemctl daemon-reload
sudo systemctl enable --now dash-watcher

systemctl status dash-watcher     # expect: active (running)
journalctl -u dash-watcher -f     # watch it poll every 60s
When you're ready to point preprod at production: edit scripts/systemd/dash-watcher.env, then sudo systemctl restart dash-watcher — no code change, no redeploy of the watcher itself.

Note: the watcher only reacts to new pulls — it won't bring up a stack from cold, that's step 2's job. If containers are ever fully torn down, redo step 2 once.

4. Public access: nginx + Let's Encrypt (direct IP, no tunnel)
Reverb needs its own proxied hostname (matches this codebase's existing api-*/ws-* split, e.g. CF_TUNNEL_HOSTNAME_WS in .env.kitchntabs) because it's a separate host port, not a path on the API. Substitute your real preprod hostnames for the placeholders below; ports come from DBI_APP_PORT/DBI_REVERB_SERVER_PORT in each project's .env.<project> — check yours with grep '^DBI_' .env.kitchntabs .env.vanexa rather than trusting numbers from another environment.


sudo apt-get install -y nginx certbot python3-certbot-nginx ufw
/etc/nginx/sites-available/kitchntabs-preprod (repeat for vanexa with its own hostnames/ports):


server {
    listen 80;
    server_name api-preprod.kitchntabs.com;
    location / {
        proxy_pass http://127.0.0.1:25000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name ws-preprod.kitchntabs.com;
    location / {
        proxy_pass http://127.0.0.1:25001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}

sudo ln -s /etc/nginx/sites-available/kitchntabs-preprod /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d api-preprod.kitchntabs.com -d ws-preprod.kitchntabs.com   # repeat for vanexa's domains
Then in each .env.<project>.<environment> Laravel file, set APP_URL=https://api-preprod... (no port), and REVERB_HOST=ws-preprod..., REVERB_PORT=443, REVERB_SCHEME=https — exactly the pattern already drafted in REQUERIMIENTOS_PREPRODUCCION.md's sample env block.


sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
5. Full status check / reboot test

systemctl status docker dash-watcher
docker ps --format "table {{.Names}}\t{{.Status}}"
curl -sI https://api-preprod.kitchntabs.com
curl -sI https://api-preprod.vanexa.cl   # or whatever the real vanexa hostname is
sudo reboot
# after it comes back, log in and re-run the block above — everything should
# already be online with no manual start needed
If dash-watcher doesn't come back after a reboot, it's a real bug (unlike the Mac doc's session-domain confusion) — journalctl -u dash-watcher --since -10min will show the actual failure.

---

## 6. Publishing the core image to Docker Hub (with the config patches baked in)

`docker-compose.yml`'s `app` service unconditionally bind-mounts ~10 things from
`${BACKEND_PATH:-../dash-backend}` — 8 individual "patched" config files
(`horizon.php`, `reverb.php`, `system.php`, `filesystems.php`, `logging.php`,
`firebase.php`, `broadcasting.php`, `app.php`), `phpunit.xml`, the nginx
template, and (if left uncommented) the whole core source tree. If
`dash-backend` doesn't exist on disk, Docker doesn't fail loudly — it silently
creates empty directories at those host paths and mounts those instead, which
for `pgsql_setup` crash-loops it (its entrypoint tries to run a script that no
longer exists) and blocks `app` from ever starting (`depends_on: pgsql_setup:
condition: service_healthy`).

The fix: rebuild and publish a Hub image from the **current** `dash-backend`
checkout, so everything those mounts used to patch in is already baked into
the image via its `COPY . /var/www/dash` layer.

**Important gotcha found while doing this:** `docker-publish-core.sh` was
building `docker/php8.3/Dockerfile.core` — a Laravel-Sail-style dev image
(`ubuntu:24.04`, no nginx/supervisor, exposes port `8000`, entrypoint
`start-container`). Nothing that's actually running here — the `80`/`6001`
port mapping, supervisord-managed Horizon/Reverb, the config-patch mounts —
exists in that Dockerfile. The real one is root-level `Dockerfile.core.production`
(`php:8.5-fpm-bookworm` + nginx + supervisor, `EXPOSE 80 6001`), which is what
`git-watcher.js` already builds locally for its own rebuild step. Fixed
`docker-publish-core.sh` to build that file instead (commit `c169ad0` in
`dash-backend`, `--build-arg INSTALL_DEV_DEPS=false` replaces the now-irrelevant
`WWWGROUP`/`OBFUSCATE_APP` args, which only applied to the other Dockerfile).

**Publish (run from `dash-backend`, wherever it's checked out — your Mac, not
this server):**
```bash
cd dash-backend
DOCKERHUB_USER=farandal DOCKERHUB_TOKEN=<your Docker Hub PAT> \
  ./docker-publish-core.sh --tag latest-core --arch amd64
```
- `--arch amd64` matches this server's architecture and skips the slower
  multi-arch export; drop it (or use `--platform linux/amd64,linux/arm64`) if
  an Apple Silicon Mac also needs to pull the same tag natively.
- Currently published: `farandal/dash-backend:latest-core`.
- If the build fails partway on an apt package fetch (`Error reading from
  server` / `403 Forbidden` from `deb.debian.org`), that's a flaky mirror edge
  node, not a real problem — just retry; buildx's layer cache means it resumes
  from the failed step, not from scratch.

---

## 7. Running off the Hub image only — no `dash-backend` clone, both projects

This is a different mode than Section 2/3 above: no `dash-backend` checkout on
this host at all, `app` runs purely from the published tag. Trade-off: core/
platform changes no longer auto-deploy via git-watcher (see the end of this
section) — you rebuild+push from wherever `dash-backend` *is* checked out and
manually re-pull here.

**7.1 — Point both projects at the Hub image.** In `.env.kitchntabs` and
`.env.vanexa`:
```ini
DASH_IMAGE=farandal/dash-backend:latest-core
```

**7.2 — Bootstrap both stacks with the image-only overlay.**
[`docker-compose.image-only.yml`](./docker-compose.image-only.yml) replaces
every `${BACKEND_PATH}`-dependent mount (the config patches, `phpunit.xml`,
the nginx template, and `pgsql`/`pgsql_setup`'s `database/create-testing-db.sh`
— the test-only database it would have created is simply skipped; leave
`DB_DATABASE_TEST` blank in this mode) with the image's own baked-in
equivalents:
```bash
cd ~/dash-backend-docker
for project in kitchntabs vanexa; do
  docker compose -f docker-compose.yml -f docker-compose.image-only.yml \
    --env-file .env.$project up -d
  sleep 4
  docker compose -f docker-compose.yml -f docker-compose.image-only.yml \
    --env-file .env.$project exec app composer install --no-interaction \
    || docker compose -f docker-compose.yml -f docker-compose.image-only.yml \
    --env-file .env.$project exec app composer update --no-interaction
  docker compose -f docker-compose.yml -f docker-compose.image-only.yml \
    --env-file .env.$project exec app php artisan migrate --force
done
docker ps --format "table {{.Names}}\t{{.Status}}"
```

**7.3 — Tell dash-watcher not to look for `dash-backend`.** In
`scripts/systemd/dash-watcher.env`:
```ini
DASH_WATCHER_SKIP_CORE=1
```
then `sudo systemctl restart dash-watcher`. Without this, every 60s cycle
still tries to `git fetch` a `../dash-backend` path that doesn't exist and
warns forever — harmless, but noisy. Domain-repo polling
(`kitchntabs-backend-domain`/`vanexa-backend-domain`) is unaffected either way.

**Shipping a core change in this mode** (no auto-deploy — do this manually):
```bash
# 1. wherever dash-backend is actually checked out:
cd dash-backend && DOCKERHUB_USER=farandal DOCKERHUB_TOKEN=<PAT> \
  ./docker-publish-core.sh --tag latest-core --arch amd64

# 2. on this server, per project:
docker compose -f docker-compose.yml -f docker-compose.image-only.yml --env-file .env.<project> pull app
docker compose -f docker-compose.yml -f docker-compose.image-only.yml --env-file .env.<project> up -d --force-recreate app
```

`~/dash-backend` on this server is unused in this mode — safe to leave or delete.

---

## 8. `production` branches for the domain repos

`DASH_WATCHER_BRANCH` is one shared value across both domain repos, so both
need an actual branch named `production` for the later switch to work.

- `kitchntabs-backend-domain` already had `production` — it was a clean
  fast-forward behind `development` (0 unique commits), just 7 behind.
  Fast-forwarded and pushed.
- `vanexa-backend-domain` (remote is `github.com/farandal/fablabos.git` — its
  pre-rename repo name, not a config error) had **no** `production` branch at
  all, only `master`. Created `production` fresh from `origin/development`
  and pushed; `master` left untouched.

Checked both `kitchntabs-ci-cdk` and `vanexa-ci-cdk` for any GitHub Actions
workflow or webhook that auto-deploys on a push to `production`/`master` —
found none, so this was a pure git operation, not a deploy trigger.

Both `production` branches now match their `development` branches exactly.
Flip `DASH_WATCHER_BRANCH=production` in `scripts/systemd/dash-watcher.env` +
`sudo systemctl restart dash-watcher` whenever you're ready to switch.

---

## Troubleshooting: `permission denied ... /var/run/docker.sock`

The `usermod -aG docker fablabadmin` step in Section 1 needs a fresh login (or
`newgrp`) to actually take effect in an already-open shell.

```bash
groups                      # does "docker" show up?
```
- **Not listed:** `sudo usermod -aG docker fablabadmin` (if not already run),
  then `newgrp docker` to apply it to the CURRENT shell without logging out.
  Any *other* already-open terminal on this box still needs its own
  `newgrp docker` or a fresh login — group membership is otherwise only
  re-read at login time.
- **Already listed** but still denied: check the daemon itself —
  `sudo systemctl status docker` (should be `active (running)`) and
  `ls -l /var/run/docker.sock` (should be owned `root:docker`).