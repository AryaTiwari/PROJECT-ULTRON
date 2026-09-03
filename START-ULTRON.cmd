@echo off
setlocal
cd /d "%~dp0"
title ULTRON Mark 3

rem Open the interface only after the local server becomes reachable.
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "$u='http://127.0.0.1:8790'; for($i=0;$i -lt 180;$i++){ try { Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 1 | Out-Null; Start-Process $u; break } catch { Start-Sleep -Seconds 1 } }"

cd /d "%~dp0mark3-development"
call npm start

if errorlevel 1 (
  echo.
  echo ULTRON stopped with an error. Review the messages above.
  pause
)
