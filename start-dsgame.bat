@echo off
title DSLand - server
cd /d "%~dp0app"
echo ============================================
echo   DSLand -- install + start
echo ============================================
echo.
echo Installing dependencies (only needed once, or after code changes)...
call npm install
if errorlevel 1 (
  echo.
  echo NPM INSTALL FAILED -- see the errors above.
  echo If this is a network/proxy issue, check your internet connection and try again.
  pause
  exit /b 1
)
echo.
echo Starting DSLand server... (leave this window open while you play)
echo Press Ctrl+C in this window to stop the server.
echo.
call npm start
pause
