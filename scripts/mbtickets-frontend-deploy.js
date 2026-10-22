#!/usr/bin/env node

'use strict';

// Builds the four mbtickets-frontend-domain apps and publishes each to its own
// Cloudflare Pages project with `wrangler pages deploy` (direct upload, no GitHub App /
// dashboard Git integration). Invoked by git-watcher.js whenever mbtickets-frontend-domain's
// tracked branch moves, exactly like inamap-frontend-deploy.js (see it for the rationale).
//
// ONE profile, and it must be named: MBTICKETS_FRONTEND_ENV=production. There is
// deliberately no default: the staging frontends are published from the Mac with
// mbtickets-frontend-domain/scripts/publish-staging.mjs, and a host that forgot the variable
// must fail loudly here instead of overwriting them.
//
//   production  env files GENERATED here on every run (hostnames below + the Reverb key
//               read from the backend's env file), Pages projects mbtickets-<app>-preview,
//               branch `production`, Cloudflare creds from .env.mbtickets-pages
//               (a Pages:Edit-only token, untracked).
//
//   web     https://web-preview.mbtickets.dev     public site: billboard and purchase
//   dash    https://dash-preview.mbtickets.dev    venues and chains
//   system  https://system-preview.mbtickets.dev  platform
//   app     https://app-preview.mbtickets.dev     staff: box office and access control
//
// Options (environment):
//   MBTICKETS_FRONTEND_BUILD_ONLY=1  build everything, publish nothing, need no Cloudflare
//                                    credentials, do not record state.
//   MBTICKETS_FRONTEND_DIR           checkout to build (default ../mbtickets-frontend-domain)
//   MBTICKETS_TOOLCHAIN_BIN          directory with the node (>=20.19) and pnpm to build with,
//                                    prepended to PATH for every child process
//   MBTICKETS_BACKEND_ENV_FILE       backend env to read REVERB_APP_KEY from
//   MBTICKETS_REVERB_KEY             the Reverb key itself (wins over the env file; for a
//                                    first publish from a workstation with no backend env)
//   MBTICKETS_RELEASE_STAGE          VITE_APP_RELEASE_STAGE (default `release`)
//   CF_API_TOKEN / CF_ACCOUNT_ID     override whatever the credentials file says
//
// On success it records the deployed commit in .mbtickets-frontend-production.sha
// (git-ignored), which git-watcher.js reads to retry a deploy that failed or never happened.
//
// Also runnable standalone for a manual redeploy:
//   MBTICKETS_FRONTEND_ENV=production node scripts/mbtickets-frontend-deploy.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.resolve(PROJECT_DIR, process.env.MBTICKETS_FRONTEND_DIR || '../mbtickets-frontend-domain');

// Same pinned wrangler as inamap-frontend-deploy.js / publish-staging.mjs.
const WRANGLER_VERSION = '3.114.17';

const ZONE = 'mbtickets.dev';
const PROFILES = {
  production: {
    name: 'production',
    branch: 'production',
    cfEnvFile: '.env.mbtickets-pages',
    pages: {
      web: 'mbtickets-web-preview',
      dash: 'mbtickets-dash-preview',
      system: 'mbtickets-system-preview',
      app: 'mbtickets-app-preview',
    },
    // `pnpm install` rewriting pnpm-lock.yaml would leave the checkout dirty, and
    // git-watcher skips a dirty checkout forever — so never let install write it.
    frozenLockfile: true,
    // Venue sites: {slug}-preview.mbtickets.dev, once the venue-sites Worker serves preview (then venueSites: true).
    siteSuffix: '-preview',
    venueSites: false,
    hosts: {
      web: `web-preview.${ZONE}`,
      dash: `dash-preview.${ZONE}`,
      system: `system-preview.${ZONE}`,
      app: `app-preview.${ZONE}`,
      api: `api-preview.${ZONE}`,
      ws: `ws-preview.${ZONE}`,
    },
  },
};

const PROFILE_NAME = process.env.MBTICKETS_FRONTEND_ENV || '';
const PROFILE = PROFILES[PROFILE_NAME];
const BUILD_ONLY = process.env.MBTICKETS_FRONTEND_BUILD_ONLY === '1';
const STATE_FILE = path.join(PROJECT_DIR, `.mbtickets-frontend-${PROFILE_NAME}.sha`);

// Keeps a shared box usable while Vite builds run, and caps node's heap so one build
// can't take the OOM killer to the app containers next to it (dash/system raise it to
// 4 GB themselves in their own build script).
const NICE = process.platform === 'linux' ? ['nice', '-n', '10'] : [];
const BUILD_ENV = { NODE_OPTIONS: process.env.MBTICKETS_BUILD_NODE_OPTIONS || '--max-old-space-size=3072' };

function log(msg) {
  console.log(`[mbtickets-frontend-deploy] ${msg}`);
}
function err(msg) {
  console.error(`[mbtickets-frontend-deploy] ERROR: ${msg}`);
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
  if (process.env.MBTICKETS_TOOLCHAIN_BIN) {
    env.PATH = `${process.env.MBTICKETS_TOOLCHAIN_BIN}${path.delimiter}${env.PATH || ''}`;
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
  if (process.env.MBTICKETS_REVERB_KEY) return process.env.MBTICKETS_REVERB_KEY;
  const file = path.resolve(
    PROJECT_DIR,
    process.env.MBTICKETS_BACKEND_ENV_FILE || '../mbtickets-backend-docker/.env.app.production'
  );
  if (!fs.existsSync(file)) throw new Error(`backend env file not found: ${file}`);
  const key = parseEnvFile(file).REVERB_APP_KEY;
  if (!key) throw new Error(`REVERB_APP_KEY is empty in ${file}`);
  return key;
}

// dash and system read the same variable set (only the app's own public URL differs).
// The Reverb key is the public Pusher-style key the browser sends, not the secret.
function dashAdminEnv(h, selfHost, reverbKey, opts = {}) {
  const stage = process.env.MBTICKETS_RELEASE_STAGE || 'release';
  return [
    "VITE_ENV_PREFIX='VITE_'",
    `VITE_APP_FRONTEND_URL=https://${selfHost}`,
    `VITE_APP_BACKEND_URL=https://${h.api}`,
    `VITE_APP_ADMIN_API_URL=https://${h.api}/api`,
    `VITE_APP_DEFAULT_REDIRECT=${opts.redirect || '/dash'}`,
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
    ...(opts.extra || []),
    '',
  ].join('\n');
}

function writeProductionEnvFiles() {
  const h = PROFILE.hosts;
  const reverbKey = backendReverbKey();
  const files = [
    // mbtickets-web runs on dash-admin since F11: same variable set, its own home, and the venue sites
    // ({slug}<suffix>.<zone>). VITE_SITE_BASE_DOMAIN stays empty until the venue-sites Worker serves this
    // environment (edge/venue-sites in mbtickets-frontend-domain); until then a venue is ?site=<slug>.
    ['apps/mbtickets-web/.env.mbtickets-web.production', dashAdminEnv(h, h.web, reverbKey, {
      redirect: '/',
      extra: [`VITE_SITE_BASE_DOMAIN=${PROFILE.venueSites ? ZONE : ''}`, `VITE_SITE_HOST_SUFFIX=${PROFILE.siteSuffix || ''}`],
    })],
    ['apps/mbtickets-app/.env.production', `VITE_API_URL=https://${h.api}/api\n`],
    ['apps/mbtickets-dash/.env.mbtickets-dash.production', dashAdminEnv(h, h.dash, reverbKey)],
    ['apps/mbtickets-system/.env.mbtickets-system.production', dashAdminEnv(h, h.system, reverbKey)],
  ];
  for (const [rel, content] of files) {
    fs.writeFileSync(path.join(FRONTEND_DIR, rel), content, { mode: 0o640 });
    log(`wrote ${rel}`);
  }
}

// ---- build / deploy ---------------------------------------------------------

function appsFor(profile) {
  return [
    {
      name: 'mbtickets-web',
      // dash-admin build since F11: CUSTOM_MODE=mbtickets-web.production (apps/mbtickets-web/.env.mbtickets-web.production).
      build: () => pnpm(FRONTEND_DIR, ['run', 'build:web'], { MBT_ENV: 'production' }),
      dist: 'apps/mbtickets-web/dist',
      pagesProject: profile.pages.web,
    },
    {
      name: 'mbtickets-dash',
      build: () => pnpm(FRONTEND_DIR, ['run', 'build:dash'], { MBT_ENV: 'production' }),
      dist: 'apps/mbtickets-dash/dist',
      pagesProject: profile.pages.dash,
    },
    {
      name: 'mbtickets-system',
      build: () => pnpm(FRONTEND_DIR, ['run', 'build:system'], { MBT_ENV: 'production' }),
      dist: 'apps/mbtickets-system/dist',
      pagesProject: profile.pages.system,
    },
    {
      name: 'mbtickets-app',
      build: () => pnpm(FRONTEND_DIR, ['--filter', 'mbtickets-app', 'build']),
      dist: 'apps/mbtickets-app/dist',
      pagesProject: profile.pages.app,
    },
  ];
}

function deployApp(app, cfEnv) {
  log(`${app.name}: building (${PROFILE.name})...`);
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
    err(`MBTICKETS_FRONTEND_ENV is "${PROFILE_NAME}" (expected: ${Object.keys(PROFILES).join(', ')}) — refusing to guess a target`);
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

  try {
    writeProductionEnvFiles();
  } catch (e) {
    err(`could not write production env files — ${e.message}`);
    process.exitCode = 1;
    return;
  }

  log('installing dependencies...');
  const install = ['install', ...(PROFILE.frozenLockfile ? ['--frozen-lockfile'] : [])];
  if (!pnpm(FRONTEND_DIR, install)) {
    process.exitCode = 1;
    return;
  }

  log('building shared packages (mbt-*)...');
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
    fs.writeFileSync(STATE_FILE, `${sha}\n`);
    log(`recorded deployed commit ${sha.slice(0, 7)} in ${path.relative(PROJECT_DIR, STATE_FILE)}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
