@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-upstream.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    echo [OK] Upstream sync completed.
) else (
    echo [ERR] Upstream sync failed with exit code %EXIT_CODE%.
)
echo.
pause
exit /b %EXIT_CODE%
