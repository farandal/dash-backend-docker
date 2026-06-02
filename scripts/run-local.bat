@echo off
setlocal
set ENV_NAME=%~1
if "%ENV_NAME%"=="" set ENV_NAME=local

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-local.ps1" -Environment "%ENV_NAME%"
