import { spawnSync } from "node:child_process";

const environment = process.argv[2] || process.env.DASH_ENV || "local";
const tunnel = process.argv.includes("--tunnel");
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
      tunnel ? "-Tunnel" : "",
    ].filter(Boolean)
  : ["./scripts/run-local-mac.sh", environment, tunnel ? "--tunnel" : ""].filter(Boolean);

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
