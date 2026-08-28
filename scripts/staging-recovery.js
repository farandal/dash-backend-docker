#!/usr/bin/env node

'use strict';

// Emergency recovery toolkit for the staging box, exposed as pm2 custom actions, triggered via
// `pm2 trigger staging-recovery <action>` from any terminal (plain `pm2 monit` has no
// clickable action buttons — that's a PM2 Plus/paid-dashboard feature, not this). This process
// does nothing on its own; it just idles, listens for triggers, and periodically reprints the
// command cheat sheet to its own stdout so it's visible in pm2 monit's log pane for that
// process without needing to trigger anything first (see PM2_AUTOMATION.md).
//
// Every action runs against both kitchntabs and vanexa (the two projects this staging box
// serves) and reports a per-project ok/error map back to the caller.

const { execSync } = require('child_process');
const path = require('path');
const io = require('@pm2/io');

const REPO_ROOT = path.join(__dirname, '..');

const PROJECTS = [
  { name: 'kitchntabs', envFile: '.env.kitchntabs', stagingEnv: '.env.kitchntabs.staging' },
  { name: 'vanexa', envFile: '.env.vanexa', stagingEnv: '.env.vanexa.staging' },
];

function run(command, extraEnv) {
  console.log(`$ ${command}`);
  return execSync(command, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180000,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
}

function forEachProject(fn) {
  const results = {};
  for (const project of PROJECTS) {
    try {
      results[project.name] = { ok: true, output: fn(project).trim() };
    } catch (err) {
      results[project.name] = { ok: false, error: (err.stderr || err.message || String(err)).toString().trim() };
    }
  }
  return results;
}

const SUPERVISORCTL = 'supervisorctl -c /etc/supervisor/supervisord.conf';

const ACTIONS = [
  ['restart:supervisor', 'horizon + reverb + scheduler, both projects'],
  ['restart:reverb', 'websockets only'],
  ['restart:horizon', 'queue worker only'],
  ['clear:cache', 'artisan optimize:clear'],
  ['migrate', 'artisan migrate --force'],
  ['restart:docker', 'force-recreate + composer install — last resort, slower'],
  ['help', 'print this list again'],
];

function printHelp() {
  const width = Math.max(...ACTIONS.map(([name]) => name.length));
  const lines = [
    '',
    '========== staging-recovery — emergency actions (kitchntabs + vanexa) ==========',
    ...ACTIONS.map(
      ([name, desc]) => `  pm2 trigger staging-recovery ${name.padEnd(width)}  # ${desc}`
    ),
    '==================================================================================',
    '',
  ];
  console.log(lines.join('\n'));
}

io.action('restart:supervisor', (cb) => {
  cb(forEachProject((p) =>
    run(`docker compose --env-file ${p.envFile} exec -T app ${SUPERVISORCTL} restart all`)
  ));
});

io.action('restart:reverb', (cb) => {
  cb(forEachProject((p) =>
    run(`docker compose --env-file ${p.envFile} exec -T app ${SUPERVISORCTL} restart reverb:dash-reverb`)
  ));
});

io.action('restart:horizon', (cb) => {
  cb(forEachProject((p) =>
    run(`docker compose --env-file ${p.envFile} exec -T app ${SUPERVISORCTL} restart horizon:dash-horizon`)
  ));
});

io.action('clear:cache', (cb) => {
  cb(forEachProject((p) =>
    run(`docker compose --env-file ${p.envFile} exec -T app php artisan optimize:clear`)
  ));
});

io.action('migrate', (cb) => {
  cb(forEachProject((p) =>
    run(`docker compose --env-file ${p.envFile} exec -T app php artisan migrate --force`)
  ));
});

io.action('restart:docker', (cb) => {
  cb(forEachProject((p) => {
    // ENV_FILE must be exported before --force-recreate, or the container silently falls back
    // to local mode instead of staging (see README.md Troubleshooting — bit us for real on
    // 2026-08-08). --force-recreate also resets vendor/ to the image baseline, so composer
    // install is not optional cleanup here — without it the container comes back up broken.
    run(`docker compose --env-file ${p.envFile} up -d --force-recreate app`, { ENV_FILE: p.stagingEnv });
    return run(`docker compose --env-file ${p.envFile} exec -T app composer install --no-interaction`);
  }));
});

io.action('help', (cb) => {
  printHelp();
  cb({ actions: ACTIONS.map(([name]) => name) });
});

printHelp();

// @pm2/io's action listeners alone don't reliably keep the event loop open — without
// something pending, node exits right after the synchronous setup above and pm2's
// autorestart immediately relaunches it, which crash-loops the process (confirmed: 9
// restarts within seconds of first starting this). Reusing that same interval to reprint the
// cheat sheet means anyone who opens `pm2 monit` and selects this process — without knowing
// to trigger `help` first — still sees it within a few minutes, not just at process boot.
setInterval(printHelp, 5 * 60 * 1000);
