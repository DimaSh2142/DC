@echo off
title DSLand - public tunnel (localtunnel)
echo ============================================
echo   DSLand -- public internet tunnel (localtunnel)
echo ============================================
echo.
echo IMPORTANT: start-dsgame.bat must already be running in another window
echo (the server must be listening on port 3000) before you run this.
echo.
echo Requesting a public URL... this does NOT need any account/signup.
echo Look below for a line like: "your url is: https://something.loca.lt"
echo That URL works from ANY device with internet, not just your wifi.
echo It stops working the moment you close this window.
echo.
npx --yes localtunnel --port 3000
pause
