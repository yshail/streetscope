@echo off
rem Starts the web server (8765) and the doctor API (8766).
rem The doctor uses Claude Sonnet 5.5 through your Claude Code login (no API key), or offline answers if claude is not installed.
cd /d "%~dp0.."
start "doctor api" cmd /k "python scripts\dev_api.py"
start "" "http://localhost:8765/"
python scripts\serve.py
