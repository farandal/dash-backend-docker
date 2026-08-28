#!/usr/bin/env node

'use strict';

// Thin wrapper so each log stream can be registered as its own tiny pm2 app —
// `pm2 monit` then gives a real-time split-pane dashboard across all of them.
// Usage: node scripts/log-tail.js <project> <logtype>
//   project: kitchntabs | vanexa
//   logtype: laravel | horizon | reverb | ai-agents | container

const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const LOG_DIR = '/var/www/dash/storage/logs';
const WAIT_POLL_MS = 3000;

// Blocks until `docker compose ... exec app true` actually succeeds — i.e. the
// container exists AND is running AND is accepting execs (not just "created").
// Right after boot, Docker Desktop itself is often still starting when pm2
// resurrects all apps at once; without this gate, every log-tail app would
// crash-loop on "no such container" until pm2's own restart backoff gives up,
// which is what actually destabilized the pm2 daemon on 2026-08-08 (8 apps
// hammering restarts simultaneously, competing with Docker Desktop's own
// cold-start for CPU). Waiting quietly here instead of crash-looping avoids
// that entirely.
function waitForContainer(project) {
  let announced = false;
  for (;;) {
    const check = spawnSync('docker', ['compose', '--env-file', `.env.${project}`, 'exec', 'app', 'true'], {
      cwd: PROJECT_DIR,
    });
    if (check.status === 0) return;
    if (!announced) {
      console.log(`[log-tail] ${project}: container not ready yet, waiting...`);
      announced = true;
    }
    spawnSync('sleep', [String(WAIT_POLL_MS / 1000)]);
  }
}

const LOG_FILES = {
  laravel: [`${LOG_DIR}/laravel.log`],
  horizon: [`${LOG_DIR}/supervisor-horizon.log`, `${LOG_DIR}/supervisor-horizon-error.log`],
  reverb: [`${LOG_DIR}/supervisor-reverb.log`, `${LOG_DIR}/supervisor-reverb-error.log`],
  'ai-agents': null, // resolved dynamically below (date-suffixed file)
};

const project = process.argv[2];
const logtype = process.argv[3];

if (!['kitchntabs', 'vanexa'].includes(project)) {
  console.error(`Unknown project "${project}". Usage: node scripts/log-tail.js <kitchntabs|vanexa> <laravel|horizon|reverb|ai-agents|container>`);
  process.exit(1);
}
if (!['laravel', 'horizon', 'reverb', 'ai-agents', 'container'].includes(logtype)) {
  console.error(`Unknown logtype "${logtype}". Usage: node scripts/log-tail.js <kitchntabs|vanexa> <laravel|horizon|reverb|ai-agents|container>`);
  process.exit(1);
}

// "container" is the container's own stdout/stderr (nginx/entrypoint startup
// trace) via `docker compose logs`, not a file inside it — everything else is
// a `tail -f` on a supervisor-managed log file, same paths QUICK_COMMANDS.md
// documents for manual use.
//
// "ai-agents" is date-suffixed (ai-agents-YYYY-MM-DD.log), so we need to find
// today's file dynamically. If it doesn't exist yet, we wait for it.
let logFiles = LOG_FILES[logtype];
let aiAgentsLogFile = null;
if (logtype === 'ai-agents') {
  // Find today's ai-agents log file
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  aiAgentsLogFile = `${LOG_DIR}/ai-agents-${today}.log`;
  logFiles = [aiAgentsLogFile];
}

const args = logtype === 'container'
  ? ['compose', '--env-file', `.env.${project}`, 'logs', '-f', '--tail', '50', 'app']
  : ['compose', '--env-file', `.env.${project}`, 'exec', 'app', 'tail', '-f', ...logFiles];

waitForContainer(project);

// For ai-agents logs, wait for the file to exist before trying to tail it
// (it's only created when there's actual AI agent activity)
if (aiAgentsLogFile) {
  let announced = false;
  for (;;) {
    const check = spawnSync('docker', ['compose', '--env-file', `.env.${project}`, 'exec', 'app', 'test', '-f', aiAgentsLogFile], {
      cwd: PROJECT_DIR,
    });
    if (check.status === 0) break;
    if (!announced) {
      console.log(`[log-tail] ${project}/ai-agents: log file doesn't exist yet (no activity), waiting...`);
      announced = true;
    }
    spawnSync('sleep', [String(WAIT_POLL_MS / 1000)]);
  }
}

console.log(`[log-tail] ${project}/${logtype}: docker ${args.join(' ')}`);

const child = spawn('docker', args, { cwd: PROJECT_DIR, stdio: 'inherit' });

// Exit with the child's code so pm2's own restart/backoff handles retries —
// e.g. right after boot, before the container is up yet, `exec` fails fast
// and pm2 just retries until it succeeds. No custom retry loop needed.
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
