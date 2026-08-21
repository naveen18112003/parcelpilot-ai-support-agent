@echo off
echo ParcelPilot AI Support - Starting Backend
echo.

REM Check for .env file
if not exist ".env" (
    echo WARNING: .env file not found. Copying from .env.example...
    copy .env.example .env
    echo Please edit .env and add your OPENAI_API_KEY, then run this script again.
    pause
    exit /b 1
)

REM Load .env variables
for /f "tokens=1,2 delims==" %%a in (.env) do (
    if not "%%a"=="" if not "%%a:~0,1%"=="#" set %%a=%%b
)

echo Starting server on http://localhost:8000
echo Open frontend/index.html in your browser after the server starts.
echo (First start may take 1-2 minutes to build the document index)
echo.

python3 -m uvicorn app.main:app --reload --port 8000
