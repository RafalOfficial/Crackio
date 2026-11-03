@echo off
rem Crackio's GPU watcher (vast-monitor.py) in this window; arguments pass through, e.g. --lang it.
rem From any shell: wt -w new --title "Crackio GPU watch" cmd /c scripts\gpu\vast-watch.cmd
cd /d "%~dp0..\.."
title Crackio GPU watch
py -3 -u scripts\gpu\vast-monitor.py %*
echo.
pause
