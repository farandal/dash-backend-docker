# PM2 automation — persistent staging server

This machine runs `dash-backend-docker` as an always-on staging server for kitchntabs and
vanexa. This document covers everything involved in making that survive process crashes,
Docker Desktop restarts, and full machine reboots unattended — what's running, how the pieces
depend on each other, how to verify it, and what to do when a piece doesn't come back.

> **Related:** [docs/watcher.md](./docs/watcher.md) — deep dive on the git-watcher script
> specifically · [QUICK_COMMANDS.md](./QUICK_COMMANDS.md) — day-to-day docker/supervisor
> commands · [README.md](./README.md) — full project reference, including the Cloudflare
> tunnel section this automation builds on.

---

## What "fully automated" actually requires

Getting from a cold power-on to both staging sites being reachable, with nobody physically
present, requires **four independent layers** to each come back on their own, in order:

```
Mac powers on
  → Automatic login (no one needs to be there to unlock the session)
    → Docker Desktop launches (it's a GUI app — needs a logged-in session to run at all)
      → Docker daemon starts → containers with restart:unless-stopped resume automatically
      → pm2's launchd agent starts (also needs the login session)
        → pm2 resurrects its saved process list
          → dash-watcher starts (polls the 3 repos every 60s)
          → kitchntabs-tunnel starts (the ONE cloudflared process — see below)
```

Skip any one layer and the chain breaks silently — e.g. Docker containers can be perfectly
configured to restart, but never will if Docker Desktop itself never launches because no one's
logged in.

---

## The four layers, what's configured, and why

### 1. Automatic login

Docker Desktop and pm2's LaunchAgent both require an active GUI session — neither can start
"before login" the way a system daemon can. Without automatic login, the whole chain simply
never begins after a real power-cycle (as opposed to a `pm2 restart`, which doesn't need this
at all since the session is already active).

**Set via:** System Settings → Users & Groups → Login Options → Automatic login. There's no
reliable CLI path — `sysadminctl -autologin` has been removed from recent macOS versions.

### 2. Docker Desktop launches at login

Added as a standard macOS login item (independent of Docker Desktop's own "start at login"
preference, which is more fragile to script around):

```bash
osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/Docker.app", hidden:false}'
```

Verify: `osascript -e 'tell application "System Events" to get the name of every login item'`
should list `Docker`.

### 3. Docker containers resume automatically

`docker-compose.yml` sets `restart: unless-stopped` on every service that needs to survive a
Docker daemon restart: `app`, `pgsql`, `redis`, `mailhog` (`api_docs` and `pgsql_setup` already
had it). Docker's engine reads this policy and auto-restarts eligible containers whenever the
daemon comes up — no script needed, this is standard Docker behavior once the policy is set.

**Critical gotcha, hit for real on 2026-08-08:** a restart policy only applies to a container at
*creation* time — editing `docker-compose.yml` does **nothing** for containers that are already
running. You must recreate them for the new policy to take effect:

```bash
export ENV_FILE=.env.kitchntabs.staging   # match whichever environment is actually running
docker compose --env-file .env.kitchntabs up -d
```

This is exactly what happened here: the policy was added, vanexa's containers happened to get
recreated afterward (so they picked it up), kitchntabs' didn't — so when Docker Desktop's VM
hiccupped during the first post-reboot cold start, only kitchntabs went down and stayed down,
with `RestartCount: 0` and an empty `RestartPolicy.Name` confirming it had never actually
received the policy. Verify any given container actually has it:

```bash
docker inspect <container_name> --format 'Policy: {{.HostConfig.RestartPolicy.Name}}'
# should print: Policy: unless-stopped
```

### 4. pm2 supervises the long-running host processes

Two things are pm2-managed — **not** the full `pnpm dash:start <project> staging --tunnel`
command, which is a one-shot interactive script that opens Terminal windows and then exits; if
pm2 "supervised" that directly with `autorestart: true`, it would relaunch in a tight loop the
instant it exits, spamming Terminal windows and duplicate tunnel connections forever.

```bash
pm2 status
┌────┬──────────────────────┬──────┬───────────┐
│ id │ name                 │ mode │ status    │
├────┼──────────────────────┼──────┼───────────┤
│ 0  │ dash-watcher         │ fork │ online    │   # see docs/watcher.md
│ 1  │ kitchntabs-tunnel    │ fork │ online    │   # see "One tunnel, not two" below
│ .. │ <project>-<type>-log │ fork │ online    │   # 8 apps, see "Real-time log dashboard" below
└────┴──────────────────────┴──────┴───────────┘
```

**Boot persistence** — `pm2 startup` generates the launchd integration (no manual plist
authoring needed), `pm2 save` snapshots the current process list to restore:

```bash
pnpm exec pm2 start scripts/git-watcher.js --name dash-watcher
pnpm exec pm2 start scripts/cloudflare-tunnel.js --name kitchntabs-tunnel -- --env-file .env.kitchntabs --env-suffix STAGING
pnpm exec pm2 save

pnpm exec pm2 startup
# prints a one-time `sudo ...` command — run it yourself, this needs your password
# and I won't/can't run sudo commands on your behalf
```

**A note on verifying this step:** attempting to manually `launchctl load`/`bootstrap`/`print`
the generated agent from an automated tool session produced inconsistent, contradictory results
here (bootstrap reporting success, then the service immediately "not found"; appearing as
disabled in one query and missing in the next) — almost certainly because that tool's shell
wasn't attached to the real GUI session domain the same way an actual Terminal.app window is.
**Don't trust manual `launchctl` probing from a non-interactive shell as the verdict.** The
plist file being correctly placed in `~/Library/LaunchAgents/` with `RunAtLoad: true` is what
matters, and despite the inconclusive manual checks, it worked correctly on the actual reboot
that was tested. If in doubt, the real test is simply: reboot, log in, `pm2 status`.

---

## One tunnel process, not two — a real incident

Initial setup started **two** separate pm2 apps, `kitchntabs-tunnel` and `vanexa-tunnel`, each
running `cloudflare-tunnel.js` against its own `.env.<project>`. This was wrong and caused
active connection instability (`Application error 0x0 (remote)`, repeated
`Connection terminated` / retry cycles in the logs) — both projects share one named Cloudflare
tunnel (`CF_TUNNEL_NAME=dash-dev`, see [README.md → Cloudflare tunnel](./README.md#cloudflare-tunnel)),
so two independent `cloudflared` processes were both trying to register as connectors for the
*same* tunnel ID simultaneously (8 total QUIC connections instead of 4).

**Fix:** run exactly **one** tunnel process. It's sufficient on its own — the ingress config it
pushes covers every hostname for both projects, confirmed via the Cloudflare API
(`GET /accounts/{account}/cfd_tunnel/{tunnel}/configurations`) showing all of
`api-staging.kitchntabs.com`, `ws-staging.kitchntabs.com`, `api-staging.vanexa.cl`,
`ws-staging.vanexa.cl`, plus the `-dev` hostnames, on one shared ingress list. Whichever
project's env file you launch it with doesn't matter — it's the tunnel *name/token* that
determines what gets served, not which `.env.<project>` was passed as `--env-file`.

```bash
pnpm exec pm2 delete vanexa-tunnel   # if you ever find two tunnel processes running again
```

---

## Stale tunnel connections — a second real incident

Separately from the above: Cloudflare's tunnel connection list can accumulate **zombie
registrations** from `cloudflared` processes that were killed abruptly (closed Terminal window,
`kill -9`, machine sleep) without a clean disconnect. Cloudflare doesn't always notice quickly,
and will keep load-balancing a fraction of incoming requests to the dead connector — which
produces exactly the symptom this looks like from the outside: a consistent or intermittent
**502 Bad Gateway**, even though DNS, the tunnel's ingress config, and the local backend are all
verified correct.

**Diagnose** — list every registered connection for the tunnel and check `run_at` timestamps
against what's actually running in `ps aux | grep cloudflared`:

```bash
CF_API_TOKEN=$(grep '^CF_API_TOKEN=' .env.kitchntabs | cut -d= -f2-)
CF_ACCOUNT_ID=$(grep '^CF_ACCOUNT_ID=' .env.kitchntabs | cut -d= -f2-)
TUNNEL_ID="b06894f3-dce9-43a2-83ee-0cd20885c66b"

curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/connections" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(c['id'], c['run_at'], len(c['conns']), 'conns') for c in d['result']]"
```

More than one `client_id` listed, or any `run_at` older than your currently-running process's
start time, means stale registrations are present.

**Fix** — force Cloudflare to drop all of them; the currently-running healthy process
reconnects clean within seconds:

```bash
curl -s -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/connections"
```

Don't call this repeatedly in a tight loop — each call forces *every* connection (including the
healthy one) to drop and reconnect, which looks identical to real instability in the logs while
it's happening. Call it once, then wait ~15s before re-checking.

---

## Real-time log dashboard (`pm2 monit`)

Each log stream — Laravel, Horizon, Reverb, and the container's own stdout (nginx/entrypoint
startup trace) — is registered as its own tiny pm2 app per project, via
`scripts/log-tail.js <project> <laravel|horizon|reverb|container>`. That gives `pm2 monit` a
real split-pane dashboard across all of them, live, with no GUI window automation involved
(deliberately not the `osascript`/Terminal-window approach `run-local-mac.sh` uses — that
script is reused for other purposes and shouldn't be coupled to this).

```bash
pnpm exec pm2 monit
```

Eight apps total, `<project>-<logtype>-log`:

| | kitchntabs | vanexa |
|---|---|---|
| Laravel | `kitchntabs-laravel-log` | `vanexa-laravel-log` |
| Horizon | `kitchntabs-horizon-log` | `vanexa-horizon-log` |
| Reverb | `kitchntabs-reverb-log` | `vanexa-reverb-log` |
| Container (nginx/entrypoint) | `kitchntabs-container-log` | `vanexa-container-log` |

**How it stays resilient across reboots:** `log-tail.js` doesn't implement its own retry loop —
it runs the underlying `docker compose exec app tail -f ...` (or `docker compose logs -f app`
for the container stream) once and exits with that command's exit code. Right after boot, before
containers are up yet, `exec` fails fast; pm2's own restart/backoff then retries automatically
until it succeeds, exactly the "nothing fancy, let pm2 own retries" approach the rest of this
automation already uses (see [docs/watcher.md](./docs/watcher.md) for the same philosophy
applied to the git-watcher).

**Setup** (already done, for reference/reproducibility):

```bash
for project in kitchntabs vanexa; do
  for logtype in laravel horizon reverb container; do
    pnpm exec pm2 start scripts/log-tail.js --name "${project}-${logtype}-log" -- "$project" "$logtype"
  done
done
pnpm exec pm2 save
```

---

## pm2 daemon instability on a fresh reboot — a third real incident

After the first real end-to-end reboot test (auto-login + Docker login item + all 10 apps
saved), `pm2 status` came back showing most apps — including `dash-watcher` and
`kitchntabs-tunnel`, the two that actually matter for public reachability — as `stopped`, `pid
N/A`. Confusingly, their log files had fresh content right up to a specific moment (`dash-watcher`
polling normally through `15:28`, `kitchntabs-tunnel` completing a full successful reconnect at
`15:29:27`), meaning they **did** start correctly at boot and ran for a while before dying — not
a resurrect failure, something killed them mid-flight. Exactly 2 of the 8 log-tail apps survived
as orphaned OS processes still running but no longer tracked by pm2 (`ps aux` showed them, `pm2
status` didn't) — several unrelated processes all dying around the same moment points at the pm2
daemon itself crashing/restarting, not each app failing independently.

**Likely root cause:** none of the 10 apps waited for Docker to actually be ready. Right after
boot, Docker Desktop is itself still starting (its own VM, its own cold start), so all 8
`log-tail.js` apps hit `docker compose exec` failing immediately, tripping pm2's restart/backoff
for all of them **simultaneously** — competing for CPU/disk with Docker Desktop's own startup at
the exact moment the system is already under the most load it'll see all boot. That resource
crunch is the plausible trigger for the pm2 daemon itself becoming unresponsive or getting killed,
which would explain unrelated processes (a git-polling script, a Go tunnel binary, several tail
processes) all going down together.

**Fix:** every script that touches Docker now waits for it explicitly instead of crash-looping —
`log-tail.js` polls `docker compose exec app true` until it succeeds before starting its tail;
`cloudflare-tunnel.js` and `git-watcher.js` poll `docker info` before their first real action.
All three log `<name>: Docker not ready yet, waiting...` once (not every poll) and then wait
quietly — no crash, no restart-count consumed, no CPU spent competing with Docker Desktop's own
startup. **This has not yet been verified against a real second reboot** — the theory fits the
evidence well, but treat it as the leading hypothesis until confirmed by actually rebooting again
and checking `pm2 status` shows everything `online` with a clean, low restart count (↺ column)
on the first try.

**Immediate recovery, if this happens again regardless:**
```bash
ps aux | grep -E "log-tail.js|git-watcher.js|cloudflare-tunnel.js" | grep -v grep   # find orphans
kill -9 <pids>                       # clean up any orphaned survivors first
pnpm exec pm2 restart all
pnpm exec pm2 save
```

---

## Full status check

```bash
cd dash-backend-docker

# Layer 1: login items
osascript -e 'tell application "System Events" to get the name of every login item'   # expect: Docker

# Layer 2: containers
docker ps --format "table {{.Names}}\t{{.Status}}"
docker inspect dash_image_app --format 'Policy: {{.HostConfig.RestartPolicy.Name}}'    # expect: unless-stopped
docker inspect vanexa_image_app --format 'Policy: {{.HostConfig.RestartPolicy.Name}}'  # expect: unless-stopped

# Layer 3: pm2
pnpm exec pm2 status              # expect 10 apps online: dash-watcher, kitchntabs-tunnel,
                                   # and the 8 <project>-<logtype>-log apps
pnpm exec pm2 logs --lines 20 --nostream

# Layer 4: tunnel
ps aux | grep cloudflared | grep -v grep          # expect exactly ONE process
curl -s -o /dev/null -w "kitchntabs: %{http_code}\n" https://api-staging.kitchntabs.com
curl -s -o /dev/null -w "vanexa: %{http_code}\n"     https://api-staging.vanexa.cl
```

---

## Troubleshooting

### `pm2 status` shows nothing / pm2 isn't running after reboot

`~/Library/LaunchAgents/pm2.farandal.plist` should exist with `RunAtLoad: true`. If it's
missing, or you suspect it's in a broken state, the fix is to redo it from scratch **in a real
logged-in Terminal window**, not through an automation tool:

```bash
pnpm exec pm2 unstartup launchd    # remove any existing (possibly broken) registration
rm -f ~/Library/LaunchAgents/pm2.farandal.plist
pnpm exec pm2 startup              # copy/paste the printed sudo command yourself
pnpm exec pm2 save
```

### A project's containers are down after reboot, but the other project's are fine

Check the restart policy directly (see Full status check above) — if it's blank instead of
`unless-stopped`, that container was never recreated after the policy was added to
`docker-compose.yml`. Recreate it (remember `export ENV_FILE=...` first — see
[README.md Troubleshooting](./README.md#--force-recreate-silently-switches-a-staging-container-to-local-mode)
for that specific footgun):

```bash
export ENV_FILE=.env.<project>.staging
docker compose --env-file .env.<project> up -d
```

### One or both sites return 502 Bad Gateway

Check for stale tunnel connections first (see above) before assuming a code/config problem —
this has been the actual cause more than once. Only after ruling that out, check the tunnel's
live ingress config against what's expected:

```bash
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  | python3 -m json.tool
```

### Two tunnel processes running

```bash
ps aux | grep cloudflared | grep -v grep
```
Should show exactly one. If pm2 shows two tunnel apps (e.g. someone re-added `vanexa-tunnel`),
delete the extra one — see "One tunnel process, not two" above.

---

## Security note

Never paste account passwords, sudo passwords, or the `-password` argument for
`sysadminctl`/similar tools into this chat or any command run through it — that argument
literally puts the password in plaintext into shell history and process listings, and pasting
it here puts it in the conversation log too. If a password was ever pasted into a chat by
mistake, rotate it afterward.
