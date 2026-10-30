@echo off
setlocal
title Crackio
cd /d "%~dp0"
if "%CRACKIO_PORT%"=="" set "CRACKIO_PORT=3211"
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"

echo.
echo   Crackio
echo   -------
echo.

rem 1. Node.js 22.13 or newer.
where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto oldnode
for /f "delims=" %%v in ('node -v') do echo   Node.js %%v found.

rem 2. pnpm, through Corepack, which comes with Node.js; npx when Corepack isn't there.
set "PNPM=corepack pnpm"
where corepack >nul 2>nul
if errorlevel 1 set "PNPM=npx --yes pnpm@11.15.1"

rem 3. Packages.
echo   Installing what Crackio needs. The first time takes a few minutes...
call %PNPM% install
if errorlevel 1 goto failed

rem 4. Build, only when the code changed.
node scripts\launch\needs-build.mjs
if errorlevel 1 goto built
echo   Building Crackio. A few minutes, only after an update...
call %PNPM% build
if errorlevel 1 goto failed
:built

rem 5. Start, and open the browser once Crackio answers.
echo.
echo   Starting Crackio at http://localhost:%CRACKIO_PORT%
echo   Your browser opens by itself. Keep this window open while you use Crackio: closing it stops Crackio.
echo.
start "" /b node scripts\launch\open-when-ready.mjs http://localhost:%CRACKIO_PORT%
call %PNPM% start -p %CRACKIO_PORT%
echo.
echo   Crackio stopped.
pause
exit /b 0

:nonode
echo   Crackio needs Node.js, version 22.13 or newer. The download page is opening: install Node.js, then double-click this file again.
start "" https://nodejs.org/en/download
pause
exit /b 1

:oldnode
for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
echo   Your Node.js is %NODEV%, and Crackio needs 22.13 or newer. The download page is opening: install the newest one, then double-click this file again.
start "" https://nodejs.org/en/download
pause
exit /b 1

:failed
echo.
echo   Something went wrong above. Check your internet connection and try again. If it keeps failing, copy the messages above into an issue on GitHub.
pause
exit /b 1
