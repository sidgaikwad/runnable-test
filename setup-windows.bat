@echo off
echo ================================================
echo   Context-Compacting Agent - Windows Setup
echo ================================================
echo.

echo [1/6] Checking Bun installation...
bun --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Bun is not installed!
    echo Please install from: https://bun.sh/
    echo Or run: powershell -c "irm bun.sh/install.ps1 | iex"
    pause
    exit /b 1
)
echo OK - Bun is installed
echo.

echo [2/6] Checking Docker...
docker ps >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker is not running!
    echo Please start Docker Desktop
    pause
    exit /b 1
)
echo OK - Docker is running
echo.

echo [3/6] Checking Docker TCP (port 2375)...
curl -s http://localhost:2375/_ping >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker TCP is not enabled!
    echo.
    echo Please enable it:
    echo 1. Open Docker Desktop
    echo 2. Go to Settings ^> General
    echo 3. Enable "Expose daemon on tcp://localhost:2375 without TLS"
    echo 4. Click "Apply & Restart"
    echo.
    pause
    exit /b 1
)
echo OK - Docker TCP is enabled
echo.

echo [4/6] Installing dependencies...
bun install
if errorlevel 1 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)
echo OK - Dependencies installed
echo.

echo [5/6] Checking .env file...
if not exist .env (
    echo WARNING: .env file not found!
    echo Creating from template...
    copy .env.example .env >nul
    echo.
    echo IMPORTANT: Edit .env file and add your OPENAI_API_KEY
    echo.
    notepad .env
)
echo OK - .env file exists
echo.

echo [6/6] Pulling Docker image...
docker pull node:20-alpine
if errorlevel 1 (
    echo ERROR: Failed to pull Docker image
    pause
    exit /b 1
)
echo OK - Docker image ready
echo.

echo ================================================
echo   Setup Complete!
echo ================================================
echo.
echo To run the agent:
echo   bun run index.ts
echo.
echo To test Docker connection:
echo   bun run test-docker.ts
echo.
pause