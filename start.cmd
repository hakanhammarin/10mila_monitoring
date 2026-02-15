@echo off
REM Network Monitoring System - Startup Script (Windows)

echo =========================================
echo Network Monitoring System
echo =========================================
echo.

REM Check if node_modules exists
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    echo.
)

REM Start the server
echo Starting monitoring server...
call npm start
