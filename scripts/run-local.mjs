import { spawnSync } from "node:child_process";

// No default project: this repo is shared across all domain checkouts
// (vanexa, fablabos, reddorada, kitchntabs, ...), so the project must always
// be passed explicitly (arg or DASH_PROJECT) rather than baked in per clone.
const project = process.argv[2] || process.env.DASH_PROJECT;
if (!project) {
  console.error("Project not specified. Usage: pnpm dash:start <project> [environment]");
  console.error("Or set DASH_PROJECT=<project>.");
  process.exit(1);
}
const environment = process.argv[3] || process.env.DASH_ENV || "local";
const isWindows = process.platform === "win32";

// Off by default - `php artisan test` used to run unconditionally on every
// dash:start and, absent test-database isolation, could wipe real dev data
// (see run-local-mac.sh / run-local.ps1 for the actual guard). Anywhere in
// the remaining args, e.g. `pnpm dash:start vanexa tunnel --tests`.
const runTests = process.argv.slice(4).includes("--tests") || process.env.DASH_RUN_TESTS === "1";

// Explicit flag rather than inferring from `environment === "tunnel"`: any
// environment (local, staging, production, ...) may need its Cloudflare
// tunnel opened, not just one literally named "tunnel". The `environment`
// arg still controls which .env.<project>.<environment> app env is mounted;
// this only controls whether the tunnel window opens alongside it.
const openTunnel = process.argv.slice(4).includes("--tunnel") || process.env.DASH_TUNNEL === "1";

const command = isWindows ? "powershell" : "bash";
const args = isWindows
  ? [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "./scripts/run-local.ps1",
      "-Project",
      project,
      "-Environment",
      environment,
      ...(runTests ? ["-Tests"] : []),
      ...(openTunnel ? ["-Tunnel"] : []),
    ]
  : [
      "./scripts/run-local-mac.sh",
      project,
      environment,
      ...(runTests ? ["--tests"] : []),
      ...(openTunnel ? ["--tunnel"] : []),
    ];

console.log(`Starting local stack for project: ${project} (environment: ${environment})`);
console.log(`Launcher platform: ${isWindows ? "windows" : "unix"}`);
console.log(`Tests: ${runTests ? "will run (isolated test database)" : "skipped by default - pass --tests to run them"}`);

const result = spawnSync(command, args, {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
