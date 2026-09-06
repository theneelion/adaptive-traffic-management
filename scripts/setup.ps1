#!/usr/bin/env pwsh
# Interactive setup + run script for the AI Traffic Management Sandbox (Windows).
# Checks prerequisites, offers to install anything missing (via winget), installs project
# dependencies, then lets you choose how to run the stack.
#
# Usage (PowerShell): .\scripts\setup.ps1
# If script execution is blocked, run PowerShell as: powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1

$ErrorActionPreference = "Continue"

function Write-Ok    { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn2 { param($msg) Write-Host "[!]  $msg" -ForegroundColor Yellow }
function Write-Err2  { param($msg) Write-Host "[X]  $msg" -ForegroundColor Red }
function Write-Info  { param($msg) Write-Host $msg -ForegroundColor DarkGray }
function Write-Header{ param($msg) Write-Host ""; Write-Host $msg -ForegroundColor White }

function Ask-YesNo {
    param([string]$Prompt)
    $reply = Read-Host "$Prompt [y/N]"
    return ($reply -match '^(y|Y|yes|Yes|YES)$')
}

function Test-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "AI Traffic Management Sandbox - setup" -ForegroundColor White
Write-Info "Repo: $RepoRoot"

$HasWinget = Test-Command "winget"
$Missing = $false

# ---------------------------------------------------------------------------
# 1. Node.js >= 20
# ---------------------------------------------------------------------------
Write-Header "Checking Node.js (>= 20)..."
if (Test-Command "node") {
    $nodeVersion = (node --version) -replace 'v', ''
    $nodeMajor = [int]($nodeVersion.Split('.')[0])
    if ($nodeMajor -ge 20) {
        Write-Ok "Node.js v$nodeVersion found"
    } else {
        Write-Warn2 "Node.js v$nodeVersion found, but 20+ is required"
        $Missing = $true
    }
} else {
    Write-Warn2 "Node.js not found"
    if ($HasWinget -and (Ask-YesNo "Install Node.js 20 LTS via winget now?")) {
        winget install --id OpenJS.NodeJS.LTS -e
        Write-Ok "Node.js installed (restart this terminal for PATH changes to take effect)"
    } else {
        Write-Err2 "Install Node.js 20+ manually: https://nodejs.org/en/download"
        $Missing = $true
    }
}

# ---------------------------------------------------------------------------
# 2. pnpm
# ---------------------------------------------------------------------------
Write-Header "Checking pnpm..."
if (Test-Command "pnpm") {
    Write-Ok "pnpm $(pnpm --version) found"
} else {
    Write-Warn2 "pnpm not found"
    if (Test-Command "corepack") {
        if (Ask-YesNo "Enable pnpm via corepack (ships with Node.js 16.13+)?") {
            corepack enable
            corepack prepare pnpm@9 --activate
            Write-Ok "pnpm enabled via corepack"
        } else {
            $Missing = $true
        }
    } elseif ($HasWinget -and (Ask-YesNo "Install pnpm via winget now?")) {
        winget install --id pnpm.pnpm -e
        Write-Ok "pnpm installed"
    } else {
        Write-Err2 "Install pnpm manually: https://pnpm.io/installation"
        $Missing = $true
    }
}

# ---------------------------------------------------------------------------
# 3. Python >= 3.12
# ---------------------------------------------------------------------------
Write-Header "Checking Python (>= 3.12)..."
$PythonCmd = $null
foreach ($candidate in @("python3.12", "python3.13", "python3.14", "python", "python3")) {
    if (Test-Command $candidate) {
        try {
            $verOutput = & $candidate --version 2>&1
            if ($verOutput -match "Python (\d+)\.(\d+)") {
                $maj = [int]$matches[1]; $min = [int]$matches[2]
                if ($maj -ge 3 -and $min -ge 12) {
                    $PythonCmd = $candidate
                    Write-Ok "$verOutput found ($candidate)"
                    break
                }
            }
        } catch {}
    }
}
if (-not $PythonCmd) {
    Write-Warn2 "Python 3.12+ not found"
    if ($HasWinget -and (Ask-YesNo "Install Python 3.12 via winget now?")) {
        winget install --id Python.Python.3.12 -e
        Write-Ok "Python installed (restart this terminal for PATH changes to take effect)"
    } else {
        Write-Err2 "Install Python 3.12+ manually: https://www.python.org/downloads/"
        $Missing = $true
    }
}

# ---------------------------------------------------------------------------
# 4. uv (Python package manager, used by ai-service)
# ---------------------------------------------------------------------------
Write-Header "Checking uv..."
if (Test-Command "uv") {
    Write-Ok "uv found: $(uv --version)"
} else {
    Write-Warn2 "uv not found"
    if (Ask-YesNo "Install uv now via the official installer?") {
        powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
        Write-Ok "uv installed (restart this terminal for PATH changes to take effect)"
    } elseif ($HasWinget -and (Ask-YesNo "Install uv via winget instead?")) {
        winget install --id astral-sh.uv -e
        Write-Ok "uv installed"
    } else {
        Write-Err2 "Install uv manually: https://docs.astral.sh/uv/getting-started/installation/"
        $Missing = $true
    }
}

# ---------------------------------------------------------------------------
# 5. Docker Desktop (optional — only needed for Docker Compose mode)
# ---------------------------------------------------------------------------
Write-Header "Checking Docker (optional, only needed for Docker Compose mode)..."
$HasDocker = $false
if (Test-Command "docker") {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "Docker found and daemon is running"
        $HasDocker = $true
    } else {
        Write-Warn2 "Docker is installed but the daemon isn't running - start Docker Desktop if you want Docker Compose mode"
    }
} else {
    Write-Warn2 "Docker not found - local dev mode will still work without it"
    Write-Info "  Install from https://www.docker.com/products/docker-desktop/ if you want the single-command Compose mode"
}

if ($Missing) {
    Write-Host ""
    Write-Err2 "One or more required tools are still missing. Install them (restart your terminal if you just installed something) and re-run this script."
    exit 1
}

# ---------------------------------------------------------------------------
# Install project dependencies
# ---------------------------------------------------------------------------
Write-Header "Installing JS/TS workspace dependencies (pnpm install)..."
pnpm install
if ($LASTEXITCODE -ne 0) { Write-Err2 "pnpm install failed"; exit 1 }
Write-Ok "Workspace dependencies installed"

Write-Header "Generating shared contracts (TS + Python types from JSON Schema)..."
pnpm --filter shared-contracts generate
if ($LASTEXITCODE -ne 0) { Write-Err2 "Contract generation failed"; exit 1 }
Write-Ok "Contracts generated"

Write-Header "Syncing ai-service Python environment (uv sync)..."
Push-Location ai-service
uv sync
$uvSyncExit = $LASTEXITCODE
Pop-Location
if ($uvSyncExit -ne 0) { Write-Err2 "uv sync failed"; exit 1 }
Write-Ok "ai-service environment ready"

# ---------------------------------------------------------------------------
# Fly.io deployment (optional - most people setting up local dev can skip this)
# ---------------------------------------------------------------------------
# App names/region are read from the committed infra/fly/*.toml files rather than duplicated
# here, so this section can never drift from what actually gets deployed.
function Get-FlyTomlValue {
    param([string]$Path, [string]$Key)
    $line = Select-String -Path $Path -Pattern "^$Key\s*=\s*`"(.*)`"" | Select-Object -First 1
    if ($line -and $line.Matches[0].Groups[1].Success) { return $line.Matches[0].Groups[1].Value }
    return $null
}
$SimServerApp = Get-FlyTomlValue "infra/fly/sim-server.fly.toml" "app"
$AiServiceApp = Get-FlyTomlValue "infra/fly/ai-service.fly.toml" "app"
$FlyRegion = Get-FlyTomlValue "infra/fly/sim-server.fly.toml" "primary_region"
$FlyVolume = "sessions_data"

Write-Header "Fly.io deployment (optional - only needed if you plan to deploy this app)"
if (Ask-YesNo "Set up Fly.io deployment now (installs flyctl, logs in, creates the two apps + persistent volume if they don't already exist)?") {
    if (Test-Command "flyctl") {
        Write-Ok "flyctl found"
    } else {
        Write-Warn2 "flyctl not found"
        if ($HasWinget -and (Ask-YesNo "Install flyctl via winget?")) {
            winget install --id Fly-io.flyctl -e
            Write-Ok "flyctl installed (restart this terminal for PATH changes to take effect)"
        } elseif (Ask-YesNo "Install flyctl via the official installer now?") {
            iwr https://fly.io/install.ps1 -useb | iex
            Write-Ok "flyctl installed (restart this terminal for PATH changes to take effect)"
        } else {
            Write-Err2 "Install flyctl manually: https://fly.io/docs/flyctl/install/ - then re-run this script to continue Fly.io setup"
        }
    }

    if (Test-Command "flyctl") {
        flyctl auth whoami *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Logged in to Fly.io as $(flyctl auth whoami)"
        } else {
            Write-Warn2 "Not logged in to Fly.io"
            if (Ask-YesNo "Run 'flyctl auth login' now (opens a browser)?") {
                flyctl auth login
            }
        }

        flyctl auth whoami *> $null
        if ($LASTEXITCODE -eq 0) {
            foreach ($app in @($SimServerApp, $AiServiceApp)) {
                flyctl status --app $app *> $null
                if ($LASTEXITCODE -eq 0) {
                    Write-Ok "Fly app '$app' already exists"
                } else {
                    Write-Warn2 "Fly app '$app' not found"
                    if (Ask-YesNo "Create Fly app '$app' now?") {
                        flyctl apps create $app
                        if ($LASTEXITCODE -eq 0) {
                            Write-Ok "Created '$app'"
                        } else {
                            Write-Err2 "Failed to create '$app' - Fly app names are globally unique, so this name may already be taken by someone else. If so, pick a new name and update it in infra/fly/sim-server.fly.toml / ai-service.fly.toml, then re-run this script."
                        }
                    }
                }
            }

            flyctl status --app $SimServerApp *> $null
            if ($LASTEXITCODE -eq 0) {
                $volumes = flyctl volumes list --app $SimServerApp 2>$null
                if ($volumes -match $FlyVolume) {
                    Write-Ok "Volume '$FlyVolume' already exists on $SimServerApp"
                } else {
                    Write-Warn2 "Volume '$FlyVolume' not found on $SimServerApp"
                    if (Ask-YesNo "Create it now (1GB, region $FlyRegion)?") {
                        flyctl volumes create $FlyVolume --app $SimServerApp --size 1 --region $FlyRegion --yes
                        if ($LASTEXITCODE -eq 0) { Write-Ok "Volume created" }
                    }
                }
            }

            Write-Host ""
            Write-Info "Apps/volume are ready. Deploys are a deliberate manual step, not part of CI - run"
            Write-Info "'flyctl deploy --config infra/fly/ai-service.fly.toml' and the sim-server equivalent"
            Write-Info "yourself whenever you're ready to ship a new version (see README's CI/CD Pipeline"
            Write-Info "section)."
        } else {
            Write-Warn2 "Skipping app/volume checks - not logged in to Fly.io."
        }
    }
} else {
    Write-Info "Skipped. Re-run this script anytime to set up Fly.io deployment."
}

# ---------------------------------------------------------------------------
# Run mode
# ---------------------------------------------------------------------------
Write-Header "How would you like to run the app?"
Write-Host "  1) Docker Compose - one command, closest to production (requires Docker running)"
Write-Host "  2) Local dev processes - opens 3 new terminal windows (ai-service, sim-server, frontend)"
Write-Host "  3) Just set up, don't run anything now"
$RunMode = Read-Host "Choose [1/2/3]"

switch ($RunMode) {
    "1" {
        if (-not $HasDocker) {
            Write-Err2 "Docker isn't available/running. Start Docker Desktop and re-run, or choose option 2."
            exit 1
        }
        Write-Header "Starting via Docker Compose..."
        Write-Info "This builds all 3 images the first time - it can take a few minutes."
        docker compose -f infra/docker-compose.yml up --build
    }
    "2" {
        Write-Header "Opening 3 terminal windows for ai-service, sim-server, and frontend..."
        Write-Info "Close each window (or Ctrl+C inside it) to stop that service."

        Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$RepoRoot\ai-service'; uv run uvicorn app.main:app --port 8000"
        Start-Sleep -Seconds 1

        Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$RepoRoot\sim-server'; `$env:AI_SERVICE_URL='http://localhost:8000'; pnpm dev"
        Start-Sleep -Seconds 1

        Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$RepoRoot\frontend'; pnpm exec vite"

        Write-Host ""
        Write-Ok "ai-service   -> http://localhost:8000"
        Write-Ok "sim-server   -> ws://localhost:8080"
        Write-Ok "frontend     -> http://localhost:5173"
    }
    default {
        Write-Ok "Setup complete. Run this script again anytime to start the stack."
    }
}
