@echo off
title Staffbot
:run
echo.
echo  Starting Staffbot... keep this window open.
echo  Close it and the bot goes offline.
echo.
call npm start
echo.
echo  Bot stopped. Restarting in 10 seconds - close this window to stop for good.
timeout /t 10 /nobreak >nul
goto run
