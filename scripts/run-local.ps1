param(
    [string]$Environment = "local",
    [int]$StartupDelaySeconds = 4,
    [int]$WindowDelaySeconds = 3
)

$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

function Resolve-AppEnvFile {
    param([string]$Environment)

    if ($Environment -match "^\.env(\..+)?$") {
        return $Environment
    }

    return ".env.$Environment"
}

$selectedEnvFile = Resolve-AppEnvFile -Environment $Environment
if (-not (Test-Path -LiteralPath $selectedEnvFile)) {
    Write-Error "Env file not found: $selectedEnvFile"
}

$env:ENV_FILE = $selectedEnvFile
Write-Host "Using ENV_FILE=$($env:ENV_FILE)"
Write-Host "Working directory: $projectRoot"

Write-Host "[1/8] docker compose up -d"
docker compose up -d

Write-Host "Waiting $StartupDelaySeconds second(s) before migrations..."
Start-Sleep -Seconds $StartupDelaySeconds

Write-Host "[2/8] docker compose exec app php artisan migrate"
docker compose exec app php artisan migrate

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
Open-CommandWindow -Title "dash-backend-docker | Reverb" -Command "docker compose exec app sh -lc \"ps aux | grep -E 'php artisan reverb:start' | grep -v grep >/dev/null && echo Reverb is already running on port 25001 || php artisan reverb:start\""
Start-Sleep -Seconds $WindowDelaySeconds

Write-Host "[5/8] Opening Horizon terminal window"
Open-CommandWindow -Title "dash-backend-docker | Horizon" -Command "docker compose exec app php artisan horizon"
Start-Sleep -Seconds $WindowDelaySeconds

Write-Host "[6/8] Opening Laravel log tail terminal window"
Open-CommandWindow -Title "dash-backend-docker | Laravel logs" -Command "docker compose exec app tail -f /var/www/html/storage/logs/laravel.log"
Start-Sleep -Seconds $WindowDelaySeconds

Write-Host "[7/7] Opening tests terminal window (Core+Domain)"
Open-CommandWindow -Title "dash-backend-docker | Tests" -Command "docker compose exec app php artisan test --testsuite=Core,Domain --log-junit /var/www/html/reports/test_results.xml --no-ansi"

if ($Environment -eq "tunnel") {
    Write-Host "[8/8] Opening Cloudflare tunnel terminal window"
    Open-CommandWindow -Title "dash-backend-docker | Cloudflare Tunnel" -Command "pnpm cloudflare:tunnel"
}

Write-Host "Done. Reverb, Horizon, log tail, and tests are running in separate terminal windows. Tests run in a single Core+Domain command."
