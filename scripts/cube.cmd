@echo off
setlocal
set "CUBE_LAUNCHER=%~f0"
set "PATH=%~dp0runtime;%PATH%"
"%~dp0runtime\node.exe" "%~dp0app\dist\main.js" %*
if "%errorlevel%"=="75" (
  call "%~dp0..\..\.update\run.cmd"
  exit /b
)
exit /b %errorlevel%
