import { spawnSync } from "node:child_process";

// No default project: this repo is shared across all domain checkouts
// (vanexa, fablabos, reddorada, kitchntabs, ...), so the project must always
// be passed explicitly (arg or DASH_PROJECT) rather than baked in per clone.
const project = process.argv[2] || process.env.DASH_PROJECT;
if (!project) {
  console.error("Project not specified. Usage: pnpm dash:start -- <project> [environment]");
  console.error("Or set DASH_PROJECT=<project>.");
  process.exit(1);
}
const environment = process.argv[3] || process.env.DASH_ENV || "local";
const isWindows = process.platform === "win32";

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
    ]
  : ["./scripts/run-local-mac.sh", project, environment];

console.log(`Starting local stack for project: ${project} (environment: ${environment})`);
console.log(`Launcher platform: ${isWindows ? "windows" : "unix"}`);

const result = spawnSync(command, args, {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
