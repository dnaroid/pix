@echo off
setlocal DisableDelayedExpansion
set "PATH=%~dp0runtime;%PATH%"
"%~dp0runtime\node.exe" "%~dp0app\bin\pix.mjs" %*
exit /b %ERRORLEVEL%
