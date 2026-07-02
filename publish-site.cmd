@echo off
title Publish GoalMind Online
cd /d "%~dp0"

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "NPX_EXE=C:\Program Files\nodejs\npx.cmd"
if not exist "%NODE_EXE%" for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_FOUND set "NODE_FOUND=%%I"
if not exist "%NODE_EXE%" set "NODE_EXE=%NODE_FOUND%"
if not exist "%NPX_EXE%" for /f "delims=" %%I in ('where npx.cmd 2^>nul') do if not defined NPX_FOUND set "NPX_FOUND=%%I"
if not exist "%NPX_EXE%" set "NPX_EXE=%NPX_FOUND%"

if not exist "%NODE_EXE%" (
  echo Node.js was not found.
  echo Install Node.js from https://nodejs.org/
  pause
  exit /b 1
)
if not exist "%NPX_EXE%" (
  echo npx.cmd was not found. Reinstall Node.js with npm enabled.
  pause
  exit /b 1
)

set "VERCEL_HOME=%CD%\.vercel-global"
set "VERCEL_ARGS=--yes --cache .\.npm-cache vercel@39.4.2"

echo Node.js detected:
"%NODE_EXE%" -v
echo.
echo Step 1 of 3: Checking Vercel login...
call "%NPX_EXE%" %VERCEL_ARGS% whoami --global-config "%VERCEL_HOME%"
if errorlevel 1 (
  echo.
  echo Opening the official GitHub/Vercel login page...
  echo After login, enter the verification code from your browser here.
  echo Do not close this window until verification finishes.
  echo.
  start "" "https://vercel.com/api/registration/login-with-github?mode=login&next=https%%3A%%2F%%2Fvercel.com%%2Fnotifications%%2Fcli-login-oob"
  call "%NPX_EXE%" %VERCEL_ARGS% login --github --oob --global-config "%VERCEL_HOME%"
  if errorlevel 1 goto :failed
)

call "%NPX_EXE%" %VERCEL_ARGS% whoami --global-config "%VERCEL_HOME%"
if errorlevel 1 goto :failed

echo.
echo Step 2 of 3: Creating the online project...
call "%NPX_EXE%" %VERCEL_ARGS% link --yes --project goalmind-world-cup-predictor --global-config "%VERCEL_HOME%"
if errorlevel 1 goto :failed

echo.
echo Step 3 of 3: Publishing the production website...
call "%NPX_EXE%" %VERCEL_ARGS% deploy --prod --yes --global-config "%VERCEL_HOME%" > deployment-url.txt
if errorlevel 1 goto :failed

set /p SITE_URL=<deployment-url.txt
echo.
echo Published successfully: %SITE_URL%
echo This URL works on other computers and phones.
echo.
start "" "%SITE_URL%"
pause
exit /b 0

:failed
echo.
echo Publishing did not complete. Keep this window open and report the error above.
pause
exit /b 1
