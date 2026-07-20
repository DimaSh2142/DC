@echo off
title DSGame - public tunnel (cloudflared)
echo ============================================
echo   DSGame -- public internet tunnel (cloudflared)
echo ============================================
echo.
echo IMPORTANT: start-dsgame.bat must already be running in another window
echo (the server must be listening on port 3000) before you run this.
echo.
echo This does NOT need any account/signup (this is the free "quick tunnel" mode).
echo Look below for a line with a URL like: https://something.trycloudflare.com
echo That URL works from ANY device with internet, not just your wifi.
echo It stops working the moment you close this window.
echo.
npx --yes cloudflared tunnel --url http://localhost:3000
pause
