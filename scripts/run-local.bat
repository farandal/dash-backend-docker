@echo off
setlocal
set PROJECT_NAME=%~1
if "%PROJECT_NAME%"=="" set PROJECT_NAME=kitchntabs
set ENV_NAME=%~2
if "%ENV_NAME%"=="" set ENV_NAME=local

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-local.ps1" -Project "%PROJECT_NAME%" -Environment "%ENV_NAME%"
