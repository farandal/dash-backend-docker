@echo off
setlocal
rem No default project: this repo is shared across all domain checkouts
rem (vanexa, fablabos, reddorada, kitchntabs, ...), so the project must
rem always be passed explicitly rather than baked in here per clone.
set PROJECT_NAME=%~1
if "%PROJECT_NAME%"=="" set PROJECT_NAME=%DASH_PROJECT%
if "%PROJECT_NAME%"=="" (
  echo Project not specified. Usage: run-local.bat ^<project^> [environment]. Or set DASH_PROJECT. 1>&2
  exit /b 1
)
set ENV_NAME=%~2
if "%ENV_NAME%"=="" set ENV_NAME=local

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-local.ps1" -Project "%PROJECT_NAME%" -Environment "%ENV_NAME%"
