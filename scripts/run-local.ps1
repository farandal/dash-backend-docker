param(
    [string]$Project = "kitchntabs",
    [string]$Environment = "local",
    [int]$StartupDelaySeconds = 4,
    [int]$WindowDelaySeconds = 3
)

$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

# Compose-level config (DOMAIN_PATH, STORAGE_PATH, DASH_IMAGE, ports) lives in
# one file per project (.env.<project>). Docker Compose only auto-loads a
# literal `.env`, so this is always passed explicitly via --env-file below.
$composeEnvFile = ".env.$Project"
if (-not (Test-Path -LiteralPath $composeEnvFile)) {
    Write-Error "Compose env file not found: $composeEnvFile (create it, e.g. copy .env.example, with DOMAIN_PATH=../$Project-backend-domain)"
}

function Resolve-AppEnvFile {
    param([string]$Environment)

    if ($Environment -match "^\.env(\..+)?$") {
        return $Environment
    }

    return ".env.$Project.$Environment"
}

$selectedEnvFile = Resolve-AppEnvFile -Environment $Environment
if (-not (Test-Path -LiteralPath $selectedEnvFile)) {
    Write-Error "Env file not found: $selectedEnvFile"
}

# We must NOT pass $selectedEnvFile itself as --env-file, since that would
# replace $composeEnvFile as the substitution source and lose DOMAIN_PATH.
# Docker Compose resolves which running containers belong to "app" by project
# label, not just container name. That label comes from COMPOSE_PROJECT_NAME,
# which is normally only sourced from a literal `.env` (no longer present) or
# --env-file. Exporting it here makes every subsequent `docker compose exec`
# in this script AND child processes (pnpm docs:generate) resolve to the same
# project as the `up -d` call above, instead of falling back to the directory
# name and reporting "service app is not running".
$composeProjectNameLine = Get-Content $composeEnvFile | Where-Object { $_ -match '^COMPOSE_PROJECT_NAME=' } | Select-Object -Last 1
$composeProjectName = if ($composeProjectNameLine) { ($composeProjectNameLine -replace '^COMPOSE_PROJECT_NAME=', '') } else { "dash_image" }
$env:COMPOSE_PROJECT_NAME = $composeProjectName

$env:ENV_FILE = $selectedEnvFile
Write-Host "Project:           $Project"
Write-Host "Using ENV_FILE=$($env:ENV_FILE) (Laravel app env, mounted into container)"
Write-Host "Using COMPOSE_ENV_FILE=$composeEnvFile (Docker Compose config — provides DOMAIN_PATH, DASH_IMAGE, ports)"
Write-Host "Working directory: $projectRoot"

Write-Host "[1/8] docker compose up -d"
docker compose --env-file $composeEnvFile up -d

Write-Host "Waiting $StartupDelaySeconds second(s) before migrations..."
Start-Sleep -Seconds $StartupDelaySeconds

Write-Host "[2/8] docker compose exec app php artisan migrate"
docker compose --env-file $composeEnvFile exec app php artisan migrate

Write-Host "[3/8] generate API docs"
pnpm docs:generate

function Open-CommandWindow {
    param(
        [string]$Title,
        [string]$Command
    )

    $scriptBlock = @"
Set-Location '$projectRoot'
`$env:ENV_FILE = '$selectedEnvFile'
`$env:COMPOSE_PROJECT_NAME = '$composeProjectName'
`$host.UI.RawUI.WindowTitle = '$Title'
Write-Host 'Using ENV_FILE='`$env:ENV_FILE
Write-Host 'Running: $Command'
$Command
"@

    Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoExit",
        "-ExecutionPolicy", "Bypass",
        "-Command", $scriptBlock
    ) | Out-Null
}

Write-Host "[4/8] Opening Reverb terminal window"
Open-CommandWindow -Title "dash-backend-docker | $Project | Reverb" -Command "docker compose exec app sh -lc \"ps aux | grep -E 'php artisan reverb:start' | grep -v grep >/dev/null && echo Reverb is already running on port 25001 || php artisan reverb:start\""
Start-Sleep -Seconds $WindowDelaySeconds

Write-Host "[5/8] Opening Horizon terminal window"
Open-CommandWindow -Title "dash-backend-docker | $Project | Horizon" -Command "docker compose exec app php artisan horizon"
Start-Sleep -Seconds $WindowDelaySeconds

Write-Host "[6/8] Opening Laravel log tail terminal window"
Open-CommandWindow -Title "dash-backend-docker | $Project | Laravel logs" -Command "docker compose exec app tail -f /var/www/html/storage/logs/laravel.log"
Start-Sleep -Seconds $WindowDelaySeconds

Write-Host "[7/7] Opening tests terminal window (Core+Domain)"
Open-CommandWindow -Title "dash-backend-docker | $Project | Tests" -Command "docker compose exec app php artisan test --testsuite=Core,Domain --log-junit /var/www/html/reports/test_results.xml --no-ansi"

if ($Environment -eq "tunnel") {
    Write-Host "[8/8] Opening Cloudflare tunnel terminal window"
    # CF_TUNNEL_* config lives in the Compose-level file, not the Laravel app
    # env file, so the tunnel script needs its own explicit --env-file too.
    Open-CommandWindow -Title "dash-backend-docker | $Project | Cloudflare Tunnel" -Command "node ./scripts/cloudflare-tunnel.js --env-file '$composeEnvFile'"
}

Write-Host "Done. Reverb, Horizon, log tail, and tests are running in separate terminal windows. Tests run in a single Core+Domain command."
