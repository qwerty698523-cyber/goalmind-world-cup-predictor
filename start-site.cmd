@echo off
title GoalMind World Cup Predictor
cd /d "%~dp0"

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_FOUND set "NODE_FOUND=%%I"
if not exist "%NODE_EXE%" set "NODE_EXE=%NODE_FOUND%"

if not exist "%NODE_EXE%" (
  echo Node.js was not found.
  echo Install Node.js from https://nodejs.org/
  pause
  exit /b 1
)

echo Node.js detected:
"%NODE_EXE%" -v
echo.
echo Starting GoalMind. The browser will open when ready.
echo Keep this window open while using the website.
echo.

if not defined GOALMIND_OPEN_BROWSER set "GOALMIND_OPEN_BROWSER=1"
"%NODE_EXE%" server.js

echo.
echo GoalMind has stopped.
pause
