@echo off
rem Starts the web server (8765) and the doctor API (8766, offline answers unless AWS credentials work)
cd /d "%~dp0.."
start "doctor api" cmd /c "python scripts\dev_api.py"
start "" "http://localhost:8765/"
python scripts\serve.py
