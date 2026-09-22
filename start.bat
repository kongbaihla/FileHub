@echo off
REM FileHub launcher (Windows). ASCII only, CRLF line endings: cmd reads this
REM file in the OEM codepage, so UTF-8 Chinese comments would be mangled into
REM stray commands and the "cd" would never run.
cd /d "%~dp0"

echo [FileHub] Installing dependencies...
python -m pip install -q -r requirements.txt
if errorlevel 1 (
  echo [FileHub] Dependency install failed. Is Python on PATH?
  pause
  exit /b 1
)

REM Prefer "python" from PATH, fall back to the py launcher. A bare "python"
REM can be the Microsoft Store stub, which silently does nothing.
set "PY=python"
where python >nul 2>nul || set "PY=py"

echo [FileHub] Starting on http://127.0.0.1:8000
echo [FileHub] Keep this window open. Press Ctrl+C to stop.
"%PY%" server\main.py

echo.
echo [FileHub] Server stopped.
pause
