#!/usr/bin/env node

'use strict';

// Builds the three inamap-frontend-domain apps against their .staging env files
// and publishes each to its own Cloudflare Pages project via `wrangler pages
// deploy` (direct upload — no GitHub App / dashboard Git integration involved,
// since authorizing that needs a manual click in the Cloudflare dashboard this
// box can't do on its own). Invoked by git-watcher.js whenever
// inamap-frontend-domain's `development` branch moves, exactly like the
// backend's composer/migrate/supervisorctl update — see
// inamap-backend-docker/INAMAP_STAGING_SETUP.md.
//
// Also runnable standalone for a manual redeploy:
//   node scripts/inamap-frontend-deploy.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.resolve(PROJECT_DIR, '../inamap-frontend-domain');
const CF_ENV_FILE = path.join(PROJECT_DIR, '.env.vanexa');

// Pinned (never a bare `wrangler`/`latest`) — resolved once via `pnpm dlx
// wrangler@3 --version` on 2026-10-12. `pages deploy` only uploads static
// files over the API; it does not need the local Workers runtime (workerd),
// which is why this works fine despite workerd's own postinstall warning
// about this machine's macOS version being below what it supports for
// *local* `wrangler dev`.
const WRANGLER_VERSION = '3.114.17';

// name: pnpm workspace app name. dist: build output relative to FRONTEND_DIR.
// pagesProject: Cloudflare Pages project created for it (see
// INAMAP_STAGING_SETUP.md — account 08c4599e3c05798074bf0fc00642c6d1).
const APPS = [
  {
    name: 'inamap-web',
    build: () => run(FRONTEND_DIR, 'pnpm', ['run', 'build:web'], { INAMAP_ENV: 'staging' }),
    dist: 'apps/inamap-web/dist',
    pagesProject: 'inamap-web-staging',
  },
  {
    name: 'inamap-system',
    build: () => run(FRONTEND_DIR, 'pnpm', ['run', 'build:system'], { INAMAP_ENV: 'staging' }),
    dist: 'apps/inamap-system/dist',
    pagesProject: 'inamap-system-staging',
  },
  {
    name: 'inamap-app',
    // Plain Vite app, no CUSTOM_MODE — `--mode staging` makes Vite load
    // apps/inamap-app/.env.staging via its own standard convention.
    build: () => run(FRONTEND_DIR, 'pnpm', ['--filter', 'inamap-app', 'build', '--', '--mode', 'staging']),
    dist: 'apps/inamap-app/dist',
    pagesProject: 'inamap-app-staging',
  },
];

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

function run(cwd, cmd, args, extraEnv) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...(extraEnv || {}) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ok = !result.error && result.status === 0;
  if (!ok) {
    err(`${cmd} ${args.join(' ')} failed (cwd=${cwd})`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return ok;
}

function deployApp(app, cfEnv) {
  log(`${app.name}: building (staging)...`);
  if (!app.build()) {
    err(`${app.name}: build failed — skipping deploy`);
    return false;
  }

  const distPath = path.join(FRONTEND_DIR, app.dist);
  if (!fs.existsSync(distPath)) {
    err(`${app.name}: expected build output at ${distPath}, not found`);
    return false;
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
      'development',
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

function main() {
  const cfEnv = parseEnvFile(CF_ENV_FILE);
  if (!cfEnv.CF_API_TOKEN || !cfEnv.CF_ACCOUNT_ID) {
    err(`missing CF_API_TOKEN/CF_ACCOUNT_ID in ${CF_ENV_FILE}`);
    process.exitCode = 1;
    return;
  }

  log('installing dependencies...');
  if (!run(FRONTEND_DIR, 'pnpm', ['install'])) {
    process.exitCode = 1;
    return;
  }

  log('building shared packages (ina-*)...');
  if (!run(FRONTEND_DIR, 'pnpm', ['run', 'build:packages'])) {
    process.exitCode = 1;
    return;
  }

  let allOk = true;
  for (const app of APPS) {
    if (!deployApp(app, cfEnv)) allOk = false;
  }

  if (!allOk) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = { main };
