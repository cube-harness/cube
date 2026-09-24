@echo off
setlocal
set "PATH=%~dp0runtime;%PATH%"
"%~dp0runtime\node.exe" "%~dp0app\dist\main.js" %*
exit /b %errorlevel%
