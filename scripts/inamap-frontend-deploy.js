#!/usr/bin/env node

'use strict';

// Builds the three inamap-frontend-domain apps and publishes each to its own
// Cloudflare Pages project with `wrangler pages deploy` (direct upload — no
// GitHub App / dashboard Git integration involved, since authorizing that needs a
// manual click in the Cloudflare dashboard this box can't do on its own).
// Invoked by git-watcher.js whenever inamap-frontend-domain's tracked branch
// moves, exactly like the backend's composer/migrate update.
//
// Two profiles, picked by INAMAP_FRONTEND_ENV (default `staging`, so the
// existing Mac staging box needs no change):
//
//   staging     env files already on the box (apps/*/.env.*.staging, gitignored),
//               Pages projects inamap-{web,system,app}-staging, branch
//               `development`, Cloudflare creds from .env.vanexa.
//   production  env files GENERATED here on every run (hostnames below + the
//               Reverb key read from the backend's env file), Pages projects
//               inamap-{web,system,app}, branch `production`, Cloudflare creds
//               from .env.inamap-pages (a Pages:Edit-only token, untracked).
//
// Options (environment):
//   INAMAP_FRONTEND_BUILD_ONLY=1   build everything, publish nothing, need no
//                                  Cloudflare credentials, do not record state.
//   INAMAP_FRONTEND_DIR            checkout to build (default ../inamap-frontend-domain)
//   INAMAP_TOOLCHAIN_BIN           directory with the node (>=20.19) and pnpm to build
//                                  with, prepended to PATH for every child process
//                                  (the preview box's system node is 18)
//   INAMAP_BACKEND_ENV_FILE        backend env to read REVERB_APP_KEY from
//   INAMAP_RELEASE_STAGE           VITE_APP_RELEASE_STAGE for production (default `release`)
//   CF_API_TOKEN / CF_ACCOUNT_ID   override whatever the credentials file says
//
// On success it records the deployed commit in storage/inamap-frontend-<profile>.sha,
// which git-watcher.js reads to retry a deploy that failed or never happened.
//
// Also runnable standalone for a manual redeploy:
//   INAMAP_FRONTEND_ENV=production node scripts/inamap-frontend-deploy.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.resolve(PROJECT_DIR, process.env.INAMAP_FRONTEND_DIR || '../inamap-frontend-domain');

// Pinned (never a bare `wrangler`/`latest`) — resolved once via `pnpm dlx
// wrangler@3 --version` on 2026-10-12. `pages deploy` only uploads static
// files over the API; it does not need the local Workers runtime (workerd).
const WRANGLER_VERSION = '3.114.17';

const PROFILES = {
  staging: {
    name: 'staging',
    envName: 'staging',
    branch: 'development',
    cfEnvFile: '.env.vanexa',
    pages: { web: 'inamap-web-staging', system: 'inamap-system-staging', app: 'inamap-app-staging' },
    generateEnv: false,
    frozenLockfile: false,
  },
  production: {
    name: 'production',
    envName: 'production',
    branch: 'production',
    cfEnvFile: '.env.inamap-pages',
    pages: { web: 'inamap-web', system: 'inamap-system', app: 'inamap-app' },
    generateEnv: true,
    // `pnpm install` rewriting pnpm-lock.yaml would leave the checkout dirty, and
    // git-watcher skips a dirty checkout forever — so never let install write it.
    frozenLockfile: true,
    hosts: {
      web: 'inamap.space',
      system: 'system.inamap.space',
      app: 'app.inamap.space',
      api: 'api.inamap.space',
      ws: 'ws.inamap.space',
    },
  },
};

const PROFILE_NAME = process.env.INAMAP_FRONTEND_ENV || 'staging';
const PROFILE = PROFILES[PROFILE_NAME];
const BUILD_ONLY = process.env.INAMAP_FRONTEND_BUILD_ONLY === '1';
const STATE_FILE = path.join(PROJECT_DIR, 'storage', `inamap-frontend-${PROFILE_NAME}.sha`);

// Keeps a shared box usable while three Vite builds run, and caps node's heap so
// one build can't take the OOM killer to the app containers next to it.
const NICE = process.platform === 'linux' ? ['nice', '-n', '10'] : [];
const BUILD_ENV = { NODE_OPTIONS: process.env.INAMAP_BUILD_NODE_OPTIONS || '--max-old-space-size=3072' };

function log(msg) {
  console.log(`[inamap-frontend-deploy] ${msg}`);
}
function err(msg) {
  console.error(`[inamap-frontend-deploy] ERROR: ${msg}`);
}

function parseEnvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function childEnv(extraEnv) {
  const env = { ...process.env, ...(extraEnv || {}) };
  if (process.env.INAMAP_TOOLCHAIN_BIN) {
    env.PATH = `${process.env.INAMAP_TOOLCHAIN_BIN}${path.delimiter}${env.PATH || ''}`;
  }
  return env;
}

function run(cwd, cmd, args, extraEnv) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: childEnv(extraEnv),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const ok = !result.error && result.status === 0;
  if (!ok) {
    err(`${cmd} ${args.join(' ')} failed (cwd=${cwd})`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return ok;
}

// `nice pnpm ...` on Linux, plain `pnpm ...` elsewhere.
function pnpm(cwd, args, extraEnv) {
  const [cmd, ...pre] = NICE.length ? [...NICE, 'pnpm'] : ['pnpm'];
  return run(cwd, cmd, [...pre, ...args], { ...BUILD_ENV, ...(extraEnv || {}) });
}

// ---- production env files ---------------------------------------------------

function backendReverbKey() {
  const file = path.resolve(
    PROJECT_DIR,
    process.env.INAMAP_BACKEND_ENV_FILE || '../inamap-backend-docker/.env.app.production'
  );
  if (!fs.existsSync(file)) throw new Error(`backend env file not found: ${file}`);
  const key = parseEnvFile(file).REVERB_APP_KEY;
  if (!key) throw new Error(`REVERB_APP_KEY is empty in ${file}`);
  return key;
}

// inamap-web and inamap-system read the same variable set (only the app's own
// public URL differs). The Reverb key is the public Pusher-style key the browser
// sends, not the secret.
function dashAdminEnv(h, selfHost, reverbKey) {
  const stage = process.env.INAMAP_RELEASE_STAGE || 'release';
  return [
    "VITE_ENV_PREFIX='VITE_'",
    `VITE_APP_FRONTEND_URL=https://${selfHost}`,
    `VITE_APP_BACKEND_URL=https://${h.api}`,
    `VITE_APP_ADMIN_API_URL=https://${h.api}/api`,
    `VITE_APP_INAMAP_APP_URL=https://${h.app}`,
    'VITE_APP_DEFAULT_REDIRECT=/dash',
    "VITE_APP_GETAUTH_ENDPOINT='auth/getauth'",
    'VITE_APP_SOCKETS_ENABLED=true',
    'VITE_APP_SOCKETS_BROADCASTER=pusher',
    `VITE_APP_SOCKETS_HOST=${h.ws}`,
    'VITE_APP_SOCKETS_PORT=443',
    'VITE_APP_SOCKETS_SCHEME=https',
    `VITE_APP_SOCKETS_KEY=${reverbKey}`,
    'VITE_APP_SOCKETS_AUTH_ENDPOINT=api/ws/auth',
    'VITE_SIDEBAR_WIDH=280',
    'VITE_SIDEBAR_COLLAPSED_WIDH=80',
    "VITE_DASH_ADMIN_ROLE='System'",
    'VITE_ENABLE_TENANT_LOGIC=true',
    'VITE_ENABLE_TENANT_IMPERSONATION=true',
    'VITE_ENABLE_LOGS_AND_NOTIFICATIONS=false',
    'VITE_FILTERS_COLLAPSE_COUNT=5',
    'VITE_FILTERS_COLLAPSE_SIZE="0px"',
    'VITE_APP_RECAPTCHA_ENABLED=false',
    'VITE_APP_RECAPTCHA_TOKEN=',
    `VITE_APP_RELEASE_STAGE=${stage}`,
    'VITE_APP_PRERELEASE_INVITATION_CODE=',
    '',
  ].join('\n');
}

function writeProductionEnvFiles() {
  const h = PROFILE.hosts;
  const reverbKey = backendReverbKey();
  const files = [
    ['apps/inamap-web/.env.inamap-web.production', dashAdminEnv(h, h.web, reverbKey)],
    ['apps/inamap-system/.env.inamap-system.production', dashAdminEnv(h, h.system, reverbKey)],
    ['apps/inamap-app/.env.production', `VITE_API_URL=https://${h.api}/api\n`],
  ];
  for (const [rel, content] of files) {
    fs.writeFileSync(path.join(FRONTEND_DIR, rel), content, { mode: 0o640 });
    log(`wrote ${rel}`);
  }
}

// ---- build / deploy ---------------------------------------------------------

function appsFor(profile) {
  const env = profile.envName;
  return [
    {
      name: 'inamap-web',
      build: () => pnpm(FRONTEND_DIR, ['run', 'build:web'], { INAMAP_ENV: env }),
      dist: 'apps/inamap-web/dist',
      pagesProject: profile.pages.web,
    },
    {
      name: 'inamap-system',
      build: () => pnpm(FRONTEND_DIR, ['run', 'build:system'], { INAMAP_ENV: env }),
      dist: 'apps/inamap-system/dist',
      pagesProject: profile.pages.system,
    },
    {
      name: 'inamap-app',
      // Plain Vite app, no CUSTOM_MODE — `--mode <env>` makes Vite load
      // apps/inamap-app/.env.<env> via its own standard convention.
      build: () => pnpm(FRONTEND_DIR, ['--filter', 'inamap-app', 'build', '--', '--mode', env]),
      dist: 'apps/inamap-app/dist',
      pagesProject: profile.pages.app,
    },
  ];
}

function deployApp(app, cfEnv) {
  log(`${app.name}: building (${PROFILE.envName})...`);
  if (!app.build()) {
    err(`${app.name}: build failed — skipping deploy`);
    return false;
  }

  const distPath = path.join(FRONTEND_DIR, app.dist);
  if (!fs.existsSync(distPath)) {
    err(`${app.name}: expected build output at ${distPath}, not found`);
    return false;
  }

  if (BUILD_ONLY) {
    log(`${app.name}: built (${app.dist}); build-only, not publishing.`);
    return true;
  }

  log(`${app.name}: deploying ${app.dist} -> Cloudflare Pages project "${app.pagesProject}"...`);
  const ok = run(
    FRONTEND_DIR,
    'pnpm',
    [
      'dlx',
      `wrangler@${WRANGLER_VERSION}`,
      'pages',
      'deploy',
      distPath,
      '--project-name',
      app.pagesProject,
      '--branch',
      PROFILE.branch,
      '--commit-dirty=true',
    ],
    {
      CLOUDFLARE_API_TOKEN: cfEnv.CF_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: cfEnv.CF_ACCOUNT_ID,
    }
  );
  if (ok) log(`${app.name}: deployed.`);
  return ok;
}

function cloudflareCredentials() {
  const file = path.join(PROJECT_DIR, PROFILE.cfEnvFile);
  const fromFile = fs.existsSync(file) ? parseEnvFile(file) : {};
  return {
    CF_API_TOKEN: process.env.CF_API_TOKEN || fromFile.CF_API_TOKEN,
    CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID || fromFile.CF_ACCOUNT_ID,
    file,
  };
}

function headSha() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: FRONTEND_DIR, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function main() {
  if (!PROFILE) {
    err(`unknown INAMAP_FRONTEND_ENV "${PROFILE_NAME}" (expected: ${Object.keys(PROFILES).join(', ')})`);
    process.exitCode = 1;
    return;
  }
  log(`profile=${PROFILE.name} branch=${PROFILE.branch}${BUILD_ONLY ? ' (build-only)' : ''} dir=${FRONTEND_DIR}`);

  const cf = cloudflareCredentials();
  if (!BUILD_ONLY && (!cf.CF_API_TOKEN || !cf.CF_ACCOUNT_ID)) {
    err(`missing CF_API_TOKEN/CF_ACCOUNT_ID in ${cf.file}`);
    process.exitCode = 1;
    return;
  }

  const sha = headSha();

  if (PROFILE.generateEnv) {
    try {
      writeProductionEnvFiles();
    } catch (e) {
      err(`could not write production env files — ${e.message}`);
      process.exitCode = 1;
      return;
    }
  }

  log('installing dependencies...');
  const install = ['install', ...(PROFILE.frozenLockfile ? ['--frozen-lockfile'] : [])];
  if (!pnpm(FRONTEND_DIR, install)) {
    process.exitCode = 1;
    return;
  }

  log('building shared packages (ina-*)...');
  if (!pnpm(FRONTEND_DIR, ['run', 'build:packages'])) {
    process.exitCode = 1;
    return;
  }

  let allOk = true;
  for (const app of appsFor(PROFILE)) {
    if (!deployApp(app, cf)) allOk = false;
  }

  if (!allOk) {
    process.exitCode = 1;
    return;
  }

  if (!BUILD_ONLY && sha) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${sha}\n`);
    log(`recorded deployed commit ${sha.slice(0, 7)} in ${path.relative(PROJECT_DIR, STATE_FILE)}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
