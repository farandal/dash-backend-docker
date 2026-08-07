param(
    # No default project: this repo is shared across all domain checkouts
    # (vanexa, fablabos, reddorada, kitchntabs, ...), so the project must
    # always be passed explicitly rather than baked in here per clone.
    [string]$Project = $env:DASH_PROJECT,
    [string]$Environment = "local",
    [int]$StartupDelaySeconds = 4,
    [int]$WindowDelaySeconds = 3,
    # Off by default: `php artisan test`'s base TestCase uses RefreshDatabase,
    # which runs `migrate:fresh` (drops every table) against whatever
    # DB_DATABASE the process resolves to. Nothing isolates that to the test
    # database on its own - see $dbDatabaseTest below - so this used to run
    # unconditionally on every dash:start and silently wipe real dev data.
    [switch]$Tests
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

# The database `php artisan test` must run against - same extraction pattern
# as $composeProjectName above. Read from the COMPOSE env file (not the
# mounted Laravel .env) because it's the one place this is already correctly
# set PER PROJECT (pgsql_setup creates it there on every boot); the Laravel
# .env only carries DB_DATABASE, the dev database.
$dbDatabaseTestLine = Get-Content $composeEnvFile | Where-Object { $_ -match '^DB_DATABASE_TEST=' } | Select-Object -Last 1
$dbDatabaseTest = if ($dbDatabaseTestLine) { ($dbDatabaseTestLine -replace '^DB_DATABASE_TEST=', '') } else { "" }

# Total varies with what actually runs below, so the [n/N] counter stays
# accurate instead of a stale hardcoded "/9" regardless of flags.
$totalSteps = 7
if ($Tests) { $totalSteps++ }
if ($Environment -eq "tunnel") { $totalSteps++ }
$step = 0

$env:ENV_FILE = $selectedEnvFile
Write-Host "Project:           $Project"
Write-Host "Using ENV_FILE=$($env:ENV_FILE) (Laravel app env, mounted into container)"
Write-Host "Using COMPOSE_ENV_FILE=$composeEnvFile (Docker Compose config — provides DOMAIN_PATH, DASH_IMAGE, ports)"
Write-Host "Working directory: $projectRoot"
if ($Tests) {
    Write-Host "Tests:              will run (DB_DATABASE=$dbDatabaseTest, isolated from dev data)"
} else {
    Write-Host "Tests:              skipped (pass -Tests to run them)"
}

$step++
Write-Host "[$step/$totalSteps] docker compose up -d"
docker compose --env-file $composeEnvFile up -d

Write-Host "Waiting $StartupDelaySeconds second(s) before migrations..."
Start-Sleep -Seconds $StartupDelaySeconds

# vendor/, composer.json and composer.lock are baked into the image, not
# host-mounted (see docker-compose.yml), but domain/ IS live-mounted here by
# this point. `composer install` is the fast path (no-op if the image's lock
# already satisfies domain/composer.json). If the domain added/changed a
# composer dependency since the image was built (e.g. box/spout), install
# fails with "required package ... is not present in the lock file" — fall
# back to a full `composer update` to re-resolve against the live domain, so
# domain-only composer changes never require a core image rebuild.
# Deliberately NOT --no-scripts: Composer's post-autoload-dump hook is what
# runs `php artisan package:discover`, which rebuilds
# bootstrap/cache/packages.php. Skipping it leaves that cache stale relative
# to vendor/, silently dropping newly (re)installed packages' service
# providers/commands (e.g. nunomaduro/collision's `artisan test` command).
$step++
Write-Host "[$step/$totalSteps] docker compose exec app composer install (sync vendor/ with live-mounted domain/composer.json)"
docker compose --env-file $composeEnvFile exec app composer install --no-interaction
if ($LASTEXITCODE -ne 0) {
    Write-Host "  composer.lock is out of sync with domain/composer.json — re-resolving via composer update..."
    docker compose --env-file $composeEnvFile exec app composer update --no-interaction
}

$step++
Write-Host "[$step/$totalSteps] docker compose exec app php artisan migrate"
docker compose --env-file $composeEnvFile exec app php artisan migrate

$step++
Write-Host "[$step/$totalSteps] generate API docs"
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

$step++
Write-Host "[$step/$totalSteps] Opening Reverb log tail terminal window"
Open-CommandWindow -Title "dash-backend-docker | $Project | Reverb logs" -Command "docker compose exec app tail -f /var/www/dash/storage/logs/supervisor-reverb.log /var/www/dash/storage/logs/supervisor-reverb-error.log"
Start-Sleep -Seconds $WindowDelaySeconds

$step++
Write-Host "[$step/$totalSteps] Opening Horizon log tail terminal window"
Open-CommandWindow -Title "dash-backend-docker | $Project | Horizon logs" -Command "docker compose exec app tail -f /var/www/dash/storage/logs/supervisor-horizon.log /var/www/dash/storage/logs/supervisor-horizon-error.log"
Start-Sleep -Seconds $WindowDelaySeconds

$step++
Write-Host "[$step/$totalSteps] Opening Laravel log tail terminal window"
Open-CommandWindow -Title "dash-backend-docker | $Project | Laravel logs" -Command "docker compose exec app tail -f /var/www/dash/storage/logs/laravel.log"
Start-Sleep -Seconds $WindowDelaySeconds

if ($Tests) {
    $step++
    if ([string]::IsNullOrEmpty($dbDatabaseTest)) {
        Write-Host "[$step/$totalSteps] Skipping tests: DB_DATABASE_TEST is not set in $composeEnvFile"
        Write-Host "  Refusing to guess - running against the wrong database is exactly the bug this guards against."
    } else {
        Write-Host "[$step/$totalSteps] Opening tests terminal window (Core+Domain), DB_DATABASE=$dbDatabaseTest"
        # -e overrides DB_DATABASE for THIS exec only - the running app/queue
        # containers, using the mounted .env's DB_DATABASE (the dev database),
        # are untouched.
        Open-CommandWindow -Title "dash-backend-docker | $Project | Tests" -Command "docker compose exec -e DB_DATABASE=$dbDatabaseTest app php artisan test --testsuite=Core,Domain --log-junit /var/www/dash/reports/test_results.xml --no-ansi"
    }
}

if ($Environment -eq "tunnel") {
    $step++
    Write-Host "[$step/$totalSteps] Opening Cloudflare tunnel terminal window"
    # CF_TUNNEL_* config lives in the Compose-level file, not the Laravel app
    # env file, so the tunnel script needs its own explicit --env-file too.
    Open-CommandWindow -Title "dash-backend-docker | $Project | Cloudflare Tunnel" -Command "node ./scripts/cloudflare-tunnel.js --env-file '$composeEnvFile'"
}

$testsNote = if ($Tests) { " Tests are tailing too." } else { "" }
Write-Host "Done. Reverb and Horizon run automatically via supervisord inside the container; their logs and the Laravel log are tailing in separate terminal windows.$testsNote"
