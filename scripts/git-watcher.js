#!/usr/bin/env node

'use strict';

// Polls dash-backend (core) + the two domain repos for new commits on whichever
// branch DASH_WATCHER_BRANCH names (defaults to `development`) every 60s, and if
// anything changed, brings the running staging containers up to date:
//   - domain repo changed  -> git pull (already live-mounted), composer/migrate,
//                             then supervisorctl restart (no container downtime)
//   - dash-backend changed -> rebuild the core image, --force-recreate the app
//                             container for BOTH projects (they share one image),
//                             then composer/migrate on each
//
// Deliberately not fancy: no SHA-tracking/retry state, no notifications. Meant to
// run under a process supervisor (pm2 on macOS, systemd on Linux — see
// dash-watcher.service / DASH_WATCHER_BRANCH in an EnvironmentFile) that handles
// restart-on-crash and boot persistence, so this script only owns the poll loop.
//
// DASH_WATCHER_SKIP_CORE=1 disables dash-backend tracking entirely (for a host
// running purely off a published DASH_IMAGE, e.g. with docker-compose.image-only.yml,
// with no dash-backend checkout on disk at all) — without it, every cycle would
// fail its `git fetch` against a path that doesn't exist and warn forever.
//
// DASH_WATCHER_SKIP_FRONTEND=1 disables the FRONTEND_REPOS deploy hook entirely.
// Which Cloudflare Pages projects the hook publishes to is picked by
// INAMAP_FRONTEND_ENV (see inamap-frontend-deploy.js): unset = the *staging*
// projects, `production` = the production ones. A host that tracks `production`
// must either set INAMAP_FRONTEND_ENV=production or this flag, otherwise a moved
// inamap-frontend-domain commit there would overwrite the staging frontends.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const POLL_INTERVAL_MS = 60_000;
const ACTIVE_PROJECTS_FILE = path.join(PROJECT_DIR, '.env.projects');
// Config-driven so switching which branch preprod tracks (e.g. development ->
// production) is a supervisor-level env change, not a code edit + redeploy.
const BRANCH = process.env.DASH_WATCHER_BRANCH || 'development';
const SKIP_CORE = process.env.DASH_WATCHER_SKIP_CORE === '1';
const SKIP_FRONTEND = process.env.DASH_WATCHER_SKIP_FRONTEND === '1';

// Domain repos map 1:1 to a running docker-compose project; dash-backend (core) is
// shared and, when it changes, affects every project that mounts it (see
// usesCoreImage in PROJECT_CONFIG below).
const DOMAIN_REPOS = [
  { name: 'kitchntabs-backend-domain', path: '../kitchntabs-backend-domain', project: 'kitchntabs' },
  { name: 'vanexa-backend-domain', path: '../vanexa-backend-domain', project: 'vanexa' },
  { name: 'inamap-backend-domain', path: '../inamap-backend-domain', project: 'inamap' },
];
const CORE_REPO = { name: 'dash-backend', path: '../dash-backend' };

// Per-project docker-compose invocation shape. kitchntabs/vanexa share THIS
// repo's docker-compose.yml and build local/dash-backend-core:latest FROM
// dash-backend source (see CORE_REPO handling below) — selected via
// --env-file .env.<project>, hence usesCoreImage:true. inamap-backend-docker
// is a fully separate repo/compose project (its own .env, no --env-file flag
// needed) that runs purely off a published DASH_IMAGE tag — a dash-backend
// source change has nothing to do with it, so usesCoreImage:false skips the
// core-triggered force-recreate for it entirely (there's nothing for it to
// pick up; bumping its DASH_IMAGE tag is a separate, manual action).
const PROJECT_CONFIG = {
  kitchntabs: { composeDir: PROJECT_DIR, composeArgs: ['--env-file', '.env.kitchntabs'], usesCoreImage: true },
  vanexa: { composeDir: PROJECT_DIR, composeArgs: ['--env-file', '.env.vanexa'], usesCoreImage: true },
  inamap: {
    composeDir: path.resolve(PROJECT_DIR, '../inamap-backend-docker'),
    composeArgs: [],
    usesCoreImage: false,
  },
};
const PROJECTS = Object.keys(PROJECT_CONFIG);

// Frontend repos aren't a docker-compose project at all — a moved commit here
// triggers a build + `wrangler pages deploy`, not composer/migrate/supervisorctl.
// See scripts/inamap-frontend-deploy.js for why (no GitHub App Git integration;
// this box drives the deploy directly instead).
const FRONTEND_RETRY_MS = 15 * 60_000;
const frontendRetryAfter = {};
// inamap-frontend-deploy.js records the commit it last published here; it is keyed
// by the same INAMAP_FRONTEND_ENV profile name the script reads.
function deployedFrontendSha() {
  const file = path.join(
    PROJECT_DIR,
    'storage',
    `inamap-frontend-${process.env.INAMAP_FRONTEND_ENV || 'staging'}.sha`
  );
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}
const FRONTEND_REPOS = [
  { name: 'inamap-frontend-domain', path: '../inamap-frontend-domain', deployScript: 'inamap-frontend-deploy.js' },
];

// Which projects this box actually manages right now — not every project a
// fresh clone knows about is one this specific machine has the capacity to
// run (confirmed live: a third full stack alongside kitchntabs/vanexa pushed
// this box's Docker Desktop into repeated OOM territory). Read fresh every
// cycle (not cached at startup) so toggling scripts/toggle-project.sh takes
// effect within one poll interval, no pm2 restart of dash-watcher needed.
// Missing file or missing/empty ACTIVE_PROJECTS = every known project is
// active — the pre-existing default, so a fresh clone with no .env.projects
// behaves exactly as before this existed.
function activeProjects() {
  if (!fs.existsSync(ACTIVE_PROJECTS_FILE)) return null;
  const content = fs.readFileSync(ACTIVE_PROJECTS_FILE, 'utf8');
  const match = content.match(/^ACTIVE_PROJECTS=(.*)$/m);
  if (!match) return null;
  const list = match[1].trim();
  if (!list) return null;
  return new Set(list.split(',').map((p) => p.trim()).filter(Boolean));
}

// A host runs a subset of the projects (the preview box gets inamap only after its
// repos are cloned). A missing checkout is logged once per process, not every 60s;
// a checkout that exists but is on the wrong branch / dirty still warns every cycle
// via syncRepo, because that one is a real problem someone has to act on.
const missingLogged = new Set();
function repoPresent(repo) {
  if (fs.existsSync(path.resolve(PROJECT_DIR, repo.path, '.git'))) return true;
  if (!missingLogged.has(repo.name)) {
    missingLogged.add(repo.name);
    warn(`${repo.name}: no checkout at ${repo.path} — skipping until it is cloned (logged once; restart to re-check)`);
  }
  return false;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function warn(msg) {
  console.warn(`[${new Date().toISOString()}] WARN: ${msg}`);
}

function err(msg) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`);
}

// Blocks until Docker actually responds. Repo polling itself doesn't need
// Docker, but the deploy steps (composer/migrate/supervisorctl/image build)
// do — waiting once before the first cycle avoids those failing immediately
// if pm2 resurrects this right at boot, before Docker Desktop itself is up.
// Later cycles don't wait: they already log-and-skip cleanly on failure.
function waitForDocker() {
  let announced = false;
  for (;;) {
    const check = spawnSync('docker', ['info'], { stdio: 'ignore' });
    if (check.status === 0) return;
    if (!announced) {
      log('Docker not ready yet, waiting...');
      announced = true;
    }
    spawnSync('sleep', ['3']);
  }
}

// Runs a command, returns { ok, stdout } — never throws. `cwd` is resolved relative
// to PROJECT_DIR so repo paths like '../dash-backend' work regardless of where this
// script is invoked from.
function run(cwd, cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: path.resolve(PROJECT_DIR, cwd),
    encoding: 'utf8',
  });
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  const ok = !result.error && result.status === 0;
  return { ok, stdout, stderr, error: result.error };
}

// kitchntabs/vanexa compose invocations always get --env-file .env.<project> —
// this is the one mistake that already bit this project once (compose silently
// targeting the wrong/empty project when the flag is missing), so it's
// structurally baked into PROJECT_CONFIG rather than left to be remembered at
// each call site. inamap runs from its own directory with no --env-file flag
// (its compose file auto-reads the plain `.env` sitting next to it).
function compose(project, ...args) {
  const cfg = PROJECT_CONFIG[project];
  return run(cfg.composeDir, 'docker', ['compose', ...cfg.composeArgs, ...args]);
}

function composeExecApp(project, ...args) {
  return compose(project, 'exec', 'app', ...args);
}

// Fetches origin/<BRANCH> and reports what (if anything) should happen: 'skip' (not
// on BRANCH, dirty tree, or diverged from origin — never auto-resolved), 'none'
// (already up to date), or 'pulled' (cleanly fast-forwarded, repo now points at the
// new commit).
function syncRepo(repo) {
  const fetch = run(repo.path, 'git', ['fetch', 'origin', BRANCH]);
  if (!fetch.ok) {
    warn(`${repo.name}: git fetch failed — ${fetch.stderr || fetch.error?.message}`);
    return 'skip';
  }

  const branch = run(repo.path, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.ok || branch.stdout !== BRANCH) {
    warn(`${repo.name}: not on ${BRANCH} (currently "${branch.stdout || '?'}") — skipping`);
    return 'skip';
  }

  const status = run(repo.path, 'git', ['status', '--porcelain']);
  if (!status.ok) {
    warn(`${repo.name}: git status failed — ${status.stderr}`);
    return 'skip';
  }
  if (status.stdout !== '') {
    warn(`${repo.name}: has uncommitted changes — skipping (never auto-stash/reset)`);
    return 'skip';
  }

  const local = run(repo.path, 'git', ['rev-parse', BRANCH]);
  const remote = run(repo.path, 'git', ['rev-parse', `origin/${BRANCH}`]);
  if (!local.ok || !remote.ok) {
    warn(`${repo.name}: could not resolve local/remote SHA — skipping`);
    return 'skip';
  }
  if (local.stdout === remote.stdout) {
    return 'none';
  }

  const base = run(repo.path, 'git', ['merge-base', BRANCH, `origin/${BRANCH}`]);
  if (base.ok && base.stdout === local.stdout) {
    const pull = run(repo.path, 'git', ['pull', '--ff-only', 'origin', BRANCH]);
    if (!pull.ok) {
      err(`${repo.name}: git pull --ff-only failed — ${pull.stderr}`);
      return 'skip';
    }
    log(`${repo.name}: pulled ${local.stdout.slice(0, 7)} -> ${remote.stdout.slice(0, 7)}`);
    return 'pulled';
  }

  warn(`${repo.name}: local and origin/${BRANCH} have diverged — needs a human, skipping`);
  return 'skip';
}

// composer install, falling back to composer update on lock/domain composer.json
// mismatch — same pattern already used in scripts/run-local-mac.sh.
function composerSync(project) {
  const install = composeExecApp(project, 'composer', 'install', '--no-interaction');
  if (install.ok) return true;

  warn(`${project}: composer install failed, falling back to composer update`);
  const update = composeExecApp(project, 'composer', 'update', '--no-interaction');
  if (!update.ok) {
    err(`${project}: composer update also failed — ${update.stderr}`);
    return false;
  }
  return true;
}

function updateProject(project, { coreChanged }) {
  log(`${project}: applying update (coreChanged=${coreChanged})`);

  if (coreChanged) {
    const recreate = compose(project, 'up', '-d', '--force-recreate', 'app');
    if (!recreate.ok) {
      err(`${project}: force-recreate failed — ${recreate.stderr}`);
      return;
    }
  }

  if (!composerSync(project)) return;

  // composer's post-autoload-dump hook auto-runs `config:cache`. Its bootstrap/cache/
  // is bind-mounted from ../dash-backend on the HOST — the same directory for both
  // kitchntabs and vanexa (see docker-compose.yml) — so if this project's env was
  // ever unresolvable for any reason (a broken mount, mid-recreate timing, ...), the
  // resulting bad cache silently poisons the OTHER project too, not just this one.
  // optimize:clear is the only thing that cleans it up, so it must run unconditionally
  // — including when migrate fails below — never gated behind migrate's success.
  const migrate = composeExecApp(project, 'php', 'artisan', 'migrate', '--force', '--no-interaction');

  const clear = composeExecApp(project, 'php', 'artisan', 'optimize:clear');
  if (!clear.ok) {
    warn(`${project}: optimize:clear failed — ${clear.stderr}`);
  }

  if (!migrate.ok) {
    err(`${project}: migrate failed — ${migrate.stderr}`);
    return;
  }

  if (!coreChanged) {
    // Container wasn't recreated, so Horizon/Reverb/the scheduler AND php-fpm are
    // still holding the old code. `supervisorctl restart all` is not enough: php-fpm
    // is not supervised and runs with opcache.validate_timestamps=Off, so web
    // requests keep serving the previously compiled routes/controllers (a new route
    // stays a 404) — confirmed on the preview box 2026-10-02. Restarting the
    // container is the only thing that refreshes it; ~1 min of API downtime per
    // domain deploy, accepted. (A core-triggered recreate already did this above.)
    const restart = compose(project, 'restart', 'app');
    if (!restart.ok) {
      err(`${project}: app restart failed — ${restart.stderr}`);
      return;
    }
  }

  log(`${project}: update complete`);
}

let isRunning = false;

function runCycle() {
  if (isRunning) {
    warn('previous cycle still running, skipping this tick');
    return;
  }
  isRunning = true;

  try {
    const active = activeProjects();
    const isActive = (project) => !active || active.has(project);

    const coreResult = SKIP_CORE ? 'none' : syncRepo(CORE_REPO);
    const coreChanged = coreResult === 'pulled';

    if (coreChanged) {
      log('dash-backend changed — rebuilding core image (containers keep serving in the meantime)');
      const build = run(CORE_REPO.path, 'docker', [
        'build',
        '-f',
        'Dockerfile.core.production',
        '-t',
        'local/dash-backend-core:latest',
        '--build-arg',
        'INSTALL_DEV_DEPS=true',
        '.',
      ]);
      if (!build.ok) {
        err(`core image build failed — ${build.stderr}`);
        // Don't touch any running containers on a failed build — they keep
        // serving the old (still-working) image.
        return;
      }
      log('core image rebuilt');
    }

    const domainChanged = {};
    for (const repo of DOMAIN_REPOS) {
      if (!isActive(repo.project)) continue; // no fetch, no action — fully quiet while disabled
      if (!repoPresent(repo)) continue;
      domainChanged[repo.project] = syncRepo(repo) === 'pulled';
    }

    for (const project of PROJECTS) {
      if (!isActive(project)) continue;
      const projectCoreChanged = coreChanged && PROJECT_CONFIG[project].usesCoreImage;
      const needsUpdate = projectCoreChanged || domainChanged[project];
      if (!needsUpdate) continue;
      updateProject(project, { coreChanged: projectCoreChanged });
    }

    let anyFrontendChanged = false;
    for (const repo of SKIP_FRONTEND ? [] : FRONTEND_REPOS) {
      if (!repoPresent(repo)) continue;
      const synced = syncRepo(repo);
      if (synced === 'skip') continue;

      // Deploy when the branch just moved, or when what is deployed (recorded by the
      // deploy script on success) no longer matches HEAD — so a failed deploy is
      // retried instead of waiting for the next commit. No state file = unknown, so
      // never deploy on that alone. A failure backs off for FRONTEND_RETRY_MS so a
      // broken build can't re-run every 60s on a box shared with the app containers.
      const head = run(repo.path, 'git', ['rev-parse', 'HEAD']).stdout;
      const deployed = deployedFrontendSha();
      const stale = Boolean(deployed) && deployed !== head;
      const retryDue = Date.now() >= (frontendRetryAfter[repo.name] || 0);
      if (synced !== 'pulled' && !(stale && retryDue)) continue;

      anyFrontendChanged = true;
      log(`${repo.name}: ${synced === 'pulled' ? 'changed' : 'deployed commit is stale'} — running ${repo.deployScript}`);
      const deploy = run(PROJECT_DIR, 'node', [path.join('scripts', repo.deployScript)]);
      if (!deploy.ok) {
        err(`${repo.name}: ${repo.deployScript} failed — ${deploy.stderr}`);
        frontendRetryAfter[repo.name] = Date.now() + FRONTEND_RETRY_MS;
      } else {
        log(`${repo.name}: deploy complete`);
        delete frontendRetryAfter[repo.name];
      }
    }

    if (!coreChanged && !Object.values(domainChanged).some(Boolean) && !anyFrontendChanged) {
      log('no changes');
    }
  } finally {
    isRunning = false;
  }
}

log(`git-watcher starting — polling every ${POLL_INTERVAL_MS / 1000}s`);
waitForDocker();
runCycle();
setInterval(runCycle, POLL_INTERVAL_MS);
