@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build\build.ps1" %*
pause
