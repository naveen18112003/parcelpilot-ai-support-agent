@echo off
echo =====================================================
echo  ParcelPilot AI Support - Live Link Generator
echo =====================================================
echo.

REM Check if ngrok is already installed
where ngrok >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [OK] ngrok found, starting tunnel...
    goto :start_tunnel
)

REM Try winget (built into Windows 10/11)
echo [INFO] ngrok not found. Installing via winget...
winget install ngrok.ngrok --silent
if %ERRORLEVEL% EQU 0 goto :start_tunnel

REM Manual fallback
echo.
echo [ACTION NEEDED] Could not auto-install ngrok.
echo.
echo  1. Go to: https://ngrok.com/download
echo  2. Download ngrok for Windows
echo  3. Extract ngrok.exe to this folder
echo  4. Run this script again
echo.
pause
exit /b 1

:start_tunnel
echo.
echo [INFO] Starting ngrok tunnel to http://localhost:8000
echo [INFO] Your live link will appear below in a moment...
echo [INFO] Press Ctrl+C to stop the tunnel.
echo.
ngrok http 8000
