@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Opening nodejs.org - install the LTS version, then double-click this file again.
  start https://nodejs.org
  pause
  exit /b 1
)
node launch.cjs
pause
