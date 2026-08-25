@echo off
setlocal
title Staffbot - Setup
cd /d "%~dp0"

echo.
echo  ============================================
echo   Staffbot setup
echo  ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  [X] Node.js is not installed, or is not on your PATH.
  echo.
  echo      Install the LTS build from https://nodejs.org
  echo      then RESTART your PC and run this again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo  Node.js %NODEVER% detected.
echo.
echo  Installing dependencies. This can take a couple of minutes.
echo.

call npm install --no-audit --no-fund
if not errorlevel 1 goto deploy

echo.
echo  First attempt failed. Clearing a half-finished install and retrying...
echo.
if exist node_modules rmdir /s /q node_modules
if exist package-lock.json del /q package-lock.json
call npm cache clean --force >nul 2>&1
call npm install --no-audit --no-fund
if errorlevel 1 goto installfail

:deploy
echo.
echo  Registering slash commands with Discord...
echo.
call npm run deploy
if errorlevel 1 goto deployfail

echo.
echo  ============================================
echo   Setup complete.
echo.
echo   Next: run check.bat to see which IDs
echo   still need filling in.
echo  ============================================
echo.
pause
exit /b 0

:installfail
echo.
echo  ============================================
echo   Dependency install failed.
echo  ============================================
echo.
echo  Scroll up and look for "gyp ERR" in the output.
echo.
echo  If you see it, npm tried to COMPILE the database library
echo  instead of downloading a ready-made one. That happens when
echo  your Node.js version is newer than the prebuilt binaries.
echo.
echo  The fix, in order of preference:
echo.
echo    1. Install Node.js 22 LTS from https://nodejs.org/en/download
echo       (uninstall your current Node first, then re-run this)
echo.
echo    2. Or install the C++ build tools so it can compile:
echo       https://visualstudio.microsoft.com/visual-cpp-build-tools/
echo       Tick "Desktop development with C++". It is a big download.
echo.
echo  Any other error is usually no internet, a VPN or firewall
echo  blocking npm, or the folder being read-only. Do not run this
echo  from inside a zip file - unzip it properly first.
echo.
pause
exit /b 1

:deployfail
echo.
echo  ============================================
echo   Could not register the slash commands.
echo  ============================================
echo.
echo  Dependencies installed fine, so this is your .env file.
echo  Check that:
echo    - the file is named exactly .env  (not .env.txt)
echo    - DISCORD_TOKEN is the current token
echo      (hit Reset Token in the Developer Portal and paste the new one)
echo    - CLIENT_ID is the Application ID
echo    - GUILD_ID is your server ID
echo.
pause
exit /b 1
