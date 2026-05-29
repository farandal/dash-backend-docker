import { spawnSync } from "node:child_process";

const environment = process.argv[2] || process.env.DASH_ENV || "local";
const isWindows = process.platform === "win32";

const command = isWindows ? "powershell" : "bash";
const args = isWindows
  ? [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "./scripts/run-local.ps1",
      "-Environment",
      environment,
    ]
  : ["./scripts/run-local-mac.sh", environment];

console.log(`Starting local stack with environment: ${environment}`);
console.log(`Launcher platform: ${isWindows ? "windows" : "unix"}`);

const result = spawnSync(command, args, {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
