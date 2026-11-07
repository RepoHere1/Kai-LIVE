@echo off
rem Start the LIVE server hidden via kctl, which checks the port first
rem so a double-click cannot open a second node window that dies with EADDRINUSE.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "ops\kctl.ps1" live start