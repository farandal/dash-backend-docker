#!/usr/bin/env node

'use strict';

// Polls dash-backend (core) + the two domain repos for new commits on `development`
// every 60s, and if anything changed, brings the running staging containers up to
// date:
//   - domain repo changed  -> git pull (already live-mounted), composer/migrate,
//                             then supervisorctl restart (no container downtime)
//   - dash-backend changed -> rebuild the core image, --force-recreate the app
//                             container for BOTH projects (they share one image),
//                             then composer/migrate on each
//
// Deliberately not fancy: no SHA-tracking/retry state, no notifications, no config
// file. Meant to run under pm2 (`pnpm exec pm2 start scripts/git-watcher.js --name
// dash-watcher`), which supervises restart-on-crash and (via `pm2 startup`) boot
// persistence, so this script only owns the poll loop itself.

const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const POLL_INTERVAL_MS = 60_000;
const BRANCH = 'development';

// Domain repos map 1:1 to a running docker-compose project; dash-backend (core) is
// shared and, when it changes, affects every project below.
const DOMAIN_REPOS = [
  { name: 'kitchntabs-backend-domain', path: '../kitchntabs-backend-domain', project: 'kitchntabs' },
  { name: 'vanexa-backend-domain', path: '../vanexa-backend-domain', project: 'vanexa' },
];
const CORE_REPO = { name: 'dash-backend', path: '../dash-backend' };
const PROJECTS = ['kitchntabs', 'vanexa'];

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

// Every docker compose invocation always gets --env-file .env.<project> — this is
// the one mistake that already bit this project once (compose silently targeting
// the wrong/empty project when the flag is missing), so it's structurally baked in
// here rather than left to be remembered at each call site.
function compose(project, ...args) {
  return run(PROJECT_DIR, 'docker', ['compose', '--env-file', `.env.${project}`, ...args]);
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
    // Container wasn't recreated, so Horizon/Reverb/the scheduler are still
    // holding the old code in memory — restart them explicitly to pick up the
    // pull. (A core-triggered recreate gets this for free via a fresh supervisord.)
    const restart = composeExecApp(
      project,
      'supervisorctl',
      '-c',
      '/etc/supervisor/supervisord.conf',
      'restart',
      'all'
    );
    if (!restart.ok) {
      err(`${project}: supervisorctl restart failed — ${restart.stderr}`);
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
    const coreResult = syncRepo(CORE_REPO);
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
      domainChanged[repo.project] = syncRepo(repo) === 'pulled';
    }

    for (const project of PROJECTS) {
      const needsUpdate = coreChanged || domainChanged[project];
      if (!needsUpdate) continue;
      updateProject(project, { coreChanged });
    }

    if (!coreChanged && !Object.values(domainChanged).some(Boolean)) {
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
