# Git watcher — staging auto-sync

`scripts/git-watcher.js` keeps this machine's running staging containers (kitchntabs and vanexa)
in sync with the `development` branch of three repos — `dash-backend` (core),
`kitchntabs-backend-domain`, and `vanexa-backend-domain` — without anyone having to manually
`git pull` and remember which `docker compose`/`supervisorctl` commands to run afterward.

It is **not** a deploy pipeline. There's no build/release/rollback concept, no approval gate, no
notification system. It's a small unattended loop: check for new commits every 60 seconds, and
if there are any, pull and restart whatever needs restarting. Nothing more.

> **Related:** [QUICK_COMMANDS.md](../QUICK_COMMANDS.md) for the underlying `docker
> compose`/`supervisorctl` commands this script wraps · [README.md](../README.md) for the full
> project reference.

---

## Why this exists

This Mac runs `dash-backend-docker` as a persistent staging backend for two Laravel domains,
kitchntabs and vanexa, both built on a shared `dash-backend` core. Picking up new commits used to
be fully manual — `git pull` each repo, then remember the right sequence of `docker
compose`/`supervisorctl` calls, including always passing `--env-file .env.<project>` (a mistake
that's actually happened: omitting it makes Compose silently target an empty, wrong project
instead of the running stack).

---

## Architecture

One persistent Node process, supervised by [pm2](https://pm2.keymetrics.io/), with its own
internal `setInterval` timer — not a one-shot script re-invoked externally by cron or launchd.
This matters: an external scheduler firing on a fixed wall-clock tick (e.g. pm2's own
`cron_restart`, or a launchd `StartInterval`) could force-kill an in-progress `docker build`
mid-way if a cycle ever runs long. A single long-lived process with its own timer never has that
race, and needs no cross-process locking — a plain in-memory boolean guard (`isRunning`) is
enough to skip an overlapping tick.

```
Every 60s:
  for repo in [dash-backend, kitchntabs-backend-domain, vanexa-backend-domain]:
    git fetch origin development
    if repo is not on branch "development" or has uncommitted changes:
      log a warning, skip this repo — never auto-stash/reset/force anything
    else if local HEAD == origin/development:
      nothing to do
    else if local HEAD is an ancestor of origin/development (clean fast-forward available):
      git pull --ff-only origin development
      mark repo as "changed this cycle"
    else:
      diverged from origin — log a warning, skip (needs a human to resolve)

  if dash-backend changed:
    docker build -f Dockerfile.core.production -t local/dash-backend-core:latest \
      --build-arg INSTALL_DEV_DEPS=true .
    # runs from ../dash-backend; the OLD containers keep serving traffic throughout the build

  for project in [kitchntabs, vanexa]:
    domainChanged = (that project's domain repo changed this cycle)
    if not (dash-backend changed or domainChanged):
      continue                                      # nothing to do for this project this cycle

    if dash-backend changed:
      docker compose --env-file .env.<project> up -d --force-recreate app
      # container swap only — the actual downtime window, a few seconds.
      # entrypoint re-execs supervisord -> horizon/reverb/scheduler come up fresh automatically

    docker compose --env-file .env.<project> exec app composer install --no-interaction \
      || docker compose --env-file .env.<project> exec app composer update --no-interaction
    docker compose --env-file .env.<project> exec app php artisan migrate --force --no-interaction
    docker compose --env-file .env.<project> exec app php artisan optimize:clear

    if not dash-backend changed:
      # container wasn't recreated, so Horizon/Reverb/the scheduler are still holding the
      # OLD code in memory (they cache class definitions) — restart explicitly to pick up
      # the pull. A core-triggered recreate gets this for free via a fresh supervisord, so
      # this step is skipped in that branch to avoid a redundant restart.
      docker compose --env-file .env.<project> exec app \
        supervisorctl -c /etc/supervisor/supervisord.conf restart all
```

### Downtime characteristics

| Change | Container recreated? | Downtime |
|---|---|---|
| Domain repo only (kitchntabs or vanexa) | No — `domain/` is live-mounted, `git pull` is instantly visible inside the running container | None — only Horizon/Reverb/scheduler restart in place (a couple of seconds), the web/nginx process and the WebSocket listener are never interrupted |
| `dash-backend` (core) | Yes, for **both** projects (they share one image) | A few seconds per project — just the container swap. The image rebuild itself (the slow part) happens beforehand while the old containers keep serving |

The Cloudflare tunnel process/window for each project is a separate, independently-running
process — nothing the watcher does ever touches it. Tunneled public endpoints stay up through a
domain-only update, and see only the container-swap downtime window during a core update.

### Why `dash-backend` needs a rebuild but the domains don't

`dash-backend` is baked into the `local/dash-backend-core:latest` Docker image at build time —
it is not live-mounted, so a `git pull` on the host has no effect on a running container until
the image is rebuilt and the container recreated from it. `kitchntabs-backend-domain` and
`vanexa-backend-domain` are bind-mounted into their containers at `/var/www/dash/domain` (see
each project's `DOMAIN_PATH` in `.env.<project>`), so a host-side pull is immediately live —
only `vendor/` (baked into the image, not mounted) needs reconciling via `composer install`.

---

## Files

| File | Purpose |
|---|---|
| `scripts/git-watcher.js` | The watcher itself — plain CommonJS Node, no framework, matches the style of `scripts/cloudflare-tunnel.js`. Uses `child_process.spawnSync` for every `git`/`docker`/`composer`/`artisan`/`supervisorctl` call. |
| `package.json` → `"watcher"` script | `node ./scripts/git-watcher.js` — for running it directly/manually, separate from the pm2-supervised copy. |
| `docs/watcher.md` | This file. |

### Key internals (`scripts/git-watcher.js`)

- `DOMAIN_REPOS` / `CORE_REPO` / `PROJECTS` — the repo↔project topology, as small constants at
  the top of the file. Not externally configurable by design (see [Limitations](#limitations--known-tradeoffs)).
- `POLL_INTERVAL_MS = 60_000` — the only "config" that exists; edit and `pm2 restart
  dash-watcher` to change it.
- `compose(project, ...args)` — wraps every `docker compose` call with `--env-file
  .env.<project>` automatically, so it's structurally impossible to repeat the
  missing-`--env-file` mistake at a call site.
- `syncRepo(repo)` — returns `'skip'` (dirty tree / wrong branch / diverged — never
  auto-resolved), `'none'` (already up to date), or `'pulled'` (clean fast-forward applied).
- `composerSync(project)` — `composer install`, falling back to `composer update` on failure
  (same pattern as `scripts/run-local-mac.sh`, for when a pulled domain's `composer.json` no
  longer matches the baked-in lock file).
- `updateProject(project, { coreChanged })` — the per-project apply step: recreate (if core
  changed) → composer → migrate → optimize:clear → supervisor restart (if core *didn't* change).
- `runCycle()` — one full pass; guarded by `isRunning` so an overlapping tick just logs and
  returns instead of running concurrently.

---

## Commands

### Day-to-day (pm2)

```bash
cd dash-backend-docker

pnpm exec pm2 status                  # is it running?
pnpm exec pm2 logs dash-watcher       # tail live output
pnpm exec pm2 logs dash-watcher --lines 50 --nostream   # last 50 lines, no follow
pnpm exec pm2 restart dash-watcher    # after editing git-watcher.js
pnpm exec pm2 stop dash-watcher       # pause it (stays registered, not running)
pnpm exec pm2 delete dash-watcher     # remove it from pm2 entirely
```

### Manual / one-off run (bypasses pm2)

```bash
pnpm watcher       # foreground, Ctrl+C to stop — same code, just not pm2-supervised
```

### Initial setup (already done on this machine — reference only)

```bash
cd dash-backend-docker
pnpm install pm2                                          # already installed

pnpm exec pm2 start scripts/git-watcher.js --name dash-watcher

pnpm exec pm2 startup      # prints a `sudo ...` command — must be run manually,
                            # pm2/Claude cannot execute sudo on your behalf
# paste and run the printed sudo command yourself, once

pnpm exec pm2 save         # snapshots the current process list; the launchd entry
                            # installed by `pm2 startup` restores this list on boot/login
```

`pm2 startup` on macOS targets **launchd**, not cron — it installs a LaunchAgent (per-user
session, required for Docker Desktop access; a system-level LaunchDaemon can't reach the
logged-in user's Docker context). This means the watcher only runs while `farandal` is logged
in — for it to come back after a cold boot with nobody physically logging in, this Mac's account
needs automatic login enabled in System Settings (outside this script's control).

---

## Limitations & known tradeoffs

Deliberately minimal ("nothing fancy," not a real deploy pipeline):

- **No retry-on-failure state tracking.** If a deploy step fails *after* `git pull` already
  advanced local `HEAD` (e.g. a migration errors out), that failure is visible in `pm2 logs
  dash-watcher` but won't be automatically retried next cycle — there's nothing new to pull.
  Recovery today is manual: fix the issue, then either wait for the next real commit or manually
  re-run the relevant `docker compose`/`artisan` command from [QUICK_COMMANDS.md](../QUICK_COMMANDS.md).
- **No desktop notifications.** `pm2 logs` / `pm2 status` is the only monitoring surface — check
  in on it, it won't proactively alert you to a failure.
- **Not configurable beyond editing the script.** No `.env.watcher`, no CLI flags, no
  `--dry-run`/`--status` mode. Repo paths, branch name, and poll interval are constants at the
  top of `git-watcher.js`.
- **Never auto-resolves git problems.** A dirty working tree, a branch other than
  `development` checked out, or a diverged local/remote history all just skip that repo with a
  logged warning, indefinitely, until a human fixes it. The watcher will never `git reset`,
  stash, force-push, or force-merge anything.
- **Never runs destructive migrations.** Only `php artisan migrate --force --no-interaction` —
  never `migrate:fresh` or `migrate:refresh`.
- **kitchntabs and vanexa share one host `bootstrap/cache/` directory.** `docker-compose.yml`
  bind-mounts `../dash-backend/bootstrap` into *both* projects' containers (same host path,
  see the "core source" mount block). `composer install`'s `post-autoload-dump` hook
  auto-runs `config:cache`, which writes into that shared directory — so if either project's
  `.env` is ever unresolvable for any reason (a stuck/broken bind mount, mid-recreate timing),
  the resulting bad cache silently poisons **the other project too**, even though its own
  `.env` was completely fine. Hit for real on 2026-08-08: a stale vanexa container had lost its
  `/var/www/dash/.env` bind mount (root cause not fully pinned down — likely fallout from
  several manual `--force-recreate` cycles during same-day debugging); `composer install`
  cached Laravel's stock `forge`/`forge`/no-password DB defaults, and kitchntabs — untouched
  that cycle — started failing DB queries with the same bad cached config seconds later.
  `optimize:clear` is the only thing that cleans this up, so `updateProject()` now runs it
  unconditionally, even when `migrate` fails (previously it was skipped on migrate failure,
  which is exactly how the bad cache lingered until caught manually). If this recurs, `docker
  compose --env-file .env.<project> exec app php artisan config:clear` fixes both projects
  immediately regardless of which one's container has the underlying problem. A deeper fix —
  giving each project its own `bootstrap/cache` instead of sharing `dash-backend`'s — would
  remove the cross-contamination risk entirely but changes the local-dev mount architecture
  too, so it's a deliberate follow-up, not done here.
- **Single-machine, single-instance.** No distributed locking; only designed to run once, on
  this Mac, under one pm2 daemon.

---

## Troubleshooting

### A repo never seems to update

Check `pm2 logs dash-watcher` for a `WARN` line naming that repo. The most common causes, in
order of likelihood:
- **Uncommitted changes** — `git -C ../<repo> status` on the host to confirm, then commit/stash/
  discard as appropriate. The watcher will pick it up on the very next cycle once the tree is
  clean.
- **Not on `development`** — `git -C ../<repo> branch --show-current`. Check it out.
- **Diverged from origin** — local and `origin/development` both have commits the other doesn't.
  Needs manual `git pull`/rebase/merge resolution; the watcher will not attempt one.

### `dash-backend` isn't triggering a rebuild despite a merged PR

Same checklist as above, applied to `../dash-backend` specifically. Since core changes affect
both projects, this repo being blocked (e.g. by uncommitted changes) silently means neither
project ever picks up core changes — worth checking first if *both* projects seem stale.

### Watcher process itself isn't running

```bash
pnpm exec pm2 status                        # look for "dash-watcher", check its status column
pnpm exec pm2 logs dash-watcher --lines 100 --nostream   # look for a crash/uncaught exception
pnpm exec pm2 restart dash-watcher
```

### It didn't come back after a reboot

- Confirm the `pm2 startup` sudo command was actually run (see Commands above) — this is a
  one-time manual step, easy to miss.
- Confirm `pm2 save` was run *after* `pm2 start ... --name dash-watcher` (the saved process list
  is a snapshot — if `dash-watcher` wasn't running when you last saved, it won't be restored).
- Confirm this Mac's account auto-logs-in — a LaunchAgent only starts once the user session
  begins.
- `pnpm exec pm2 resurrect` manually restores the last-saved process list, useful for testing
  this without an actual reboot.

### A pulled change deployed but the app is still broken

Check `pm2 logs dash-watcher` around the relevant timestamp for an `ERROR` line — `composer
install`/`composer update`, `php artisan migrate`, and `supervisorctl restart` failures are all
logged with their stderr. Since there's no auto-retry (see Limitations), fix the underlying issue
and re-run the relevant step manually from [QUICK_COMMANDS.md](../QUICK_COMMANDS.md) rather than
waiting for the watcher to notice — it won't, until the next real commit lands.
