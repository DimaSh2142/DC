@echo off
title DSGame - push to GitHub
cd /d "%~dp0"
echo ============================================
echo   DSGame -- push to github.com/DimaSh2142/DC
echo ============================================
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo Git is not installed (or not on PATH).
  echo Install it from https://git-scm.com/download/win (default options are fine),
  echo then double-click this file again.
  pause
  exit /b 1
)

if exist ".git\index.lock" del /f /q ".git\index.lock" >nul 2>&1

if not exist ".git" (
  echo Creating local git repo...
  git init
)

echo Staging files (node_modules, .env, and reference/ are excluded via .gitignore)...
git add .

echo Committing...
git commit -m "Initial commit: DSGame team quiz app"
if errorlevel 1 (
  echo.
  echo Nothing to commit, or commit failed -- see messages above.
  echo If this is your second run and there's nothing new, that's fine, continuing to push.
)

git branch -M main
git remote remove origin >nul 2>&1
git remote add origin https://github.com/DimaSh2142/DC.git

echo.
echo Pushing to GitHub... a browser sign-in window may pop up the first time --
echo just log in to your GitHub account there and this will continue automatically.
echo.
git push -u origin main

echo.
echo Done. If you saw an error above instead of a success message, copy it and
echo show it in chat and it can be sorted out from there.
pause
