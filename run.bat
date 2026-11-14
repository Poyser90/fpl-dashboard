@echo off
cd /d "%~dp0"
node fpl.js %*
if errorlevel 1 (
  pause
  exit /b 1
)
start "" dashboard.html
