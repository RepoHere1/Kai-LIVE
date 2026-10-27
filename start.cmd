@echo off
REM Kai-LIVE unified startup: server + monitor
cd /d "%~dp0"
echo Starting Kai-LIVE server on port 8788...
start /b node server.js >server.log 2>&1
timeout /t 2 /nobreak >nul
echo Starting Kai-LIVE monitor...
start /b node monitor.js >monitor.log 2>&1
echo Both started. Logs: server.log, monitor.log