param(
    # No default project: this repo is shared across all domain checkouts
    # (vanexa, fablabos, reddorada, kitchntabs, ...), so the project must
    # always be passed explicitly rather than baked in here per clone.
    [string]$Project = $env:DASH_PROJECT,
    [string]$Environment = "local",
    [int]$StartupDelaySeconds = 4,
    [int]$WindowDelaySeconds = 3
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrEmpty($Project)) {
    Write-Error "Project not specified. Usage: run-local.ps1 -Project <project> [-Environment <environment>]. Or set `$env:DASH_PROJECT."
}
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

# Reverb and Horizon are no longer started here: the core image is always
# built from Dockerfile.core.production, which runs supervisord and
# auto-starts/auto-restarts both (see docker/app/custom-supervisor.conf).
# To restart them manually after a code change, use:
#   docker compose exec app supervisorctl -c /etc/supervisor/supervisord.conf restart reverb horizon
# We still tail their supervisor-managed log files below for visibility.

Write-Host "[4/8] Opening Reverb log tail terminal window"
Open-CommandWindow -Title "dash-backend-docker | $Project | Reverb logs" -Command "docker compose exec app tail -f /var/www/dash/storage/logs/supervisor-reverb.log /var/www/dash/storage/logs/supervisor-reverb-error.log"
Start-Sleep -Seconds $WindowDelaySeconds

Write-Host "[5/8] Opening Horizon log tail terminal window"
Open-CommandWindow -Title "dash-backend-docker | $Project | Horizon logs" -Command "docker compose exec app tail -f /var/www/dash/storage/logs/supervisor-horizon.log /var/www/dash/storage/logs/supervisor-horizon-error.log"
Start-Sleep -Seconds $WindowDelaySeconds

Write-Host "[6/8] Opening Laravel log tail terminal window"
Open-CommandWindow -Title "dash-backend-docker | $Project | Laravel logs" -Command "docker compose exec app tail -f /var/www/dash/storage/logs/laravel.log"
Start-Sleep -Seconds $WindowDelaySeconds

Write-Host "[7/8] Opening tests terminal window (Core+Domain)"
Open-CommandWindow -Title "dash-backend-docker | $Project | Tests" -Command "docker compose exec app php artisan test --testsuite=Core,Domain --log-junit /var/www/dash/reports/test_results.xml --no-ansi"

if ($Environment -eq "tunnel") {
    Write-Host "[8/8] Opening Cloudflare tunnel terminal window"
    # CF_TUNNEL_* config lives in the Compose-level file, not the Laravel app
    # env file, so the tunnel script needs its own explicit --env-file too.
    Open-CommandWindow -Title "dash-backend-docker | $Project | Cloudflare Tunnel" -Command "node ./scripts/cloudflare-tunnel.js --env-file '$composeEnvFile'"
}

Write-Host "Done. Reverb and Horizon run automatically via supervisord inside the container; their logs, the Laravel log, and tests are tailing in separate terminal windows."
