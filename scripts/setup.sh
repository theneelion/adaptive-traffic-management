#!/usr/bin/env bash
# Interactive setup + run script for the AI Traffic Management Sandbox (macOS / Linux).
# Checks prerequisites, offers to install anything missing, installs project dependencies,
# then lets you choose how to run the stack.
#
# Usage: ./scripts/setup.sh
set -uo pipefail
set -m # job control on: each background job below gets its own process group, so cleanup() can
       # kill the whole tree (uv run's child uvicorn process, tsx's child node process, etc.)
       # instead of only the immediate wrapper PID and leaving orphans behind.

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
BOLD=$(tput bold 2>/dev/null || echo "")
DIM=$(tput dim 2>/dev/null || echo "")
GREEN=$(tput setaf 2 2>/dev/null || echo "")
YELLOW=$(tput setaf 3 2>/dev/null || echo "")
RED=$(tput setaf 1 2>/dev/null || echo "")
RESET=$(tput sgr0 2>/dev/null || echo "")

ok()    { echo "${GREEN}✓${RESET} $1"; }
warn()  { echo "${YELLOW}!${RESET} $1"; }
err()   { echo "${RED}✗${RESET} $1"; }
info()  { echo "${DIM}$1${RESET}"; }
header(){ echo ""; echo "${BOLD}$1${RESET}"; }

ask_yes_no() {
  # ask_yes_no "question" -> returns 0 for yes, 1 for no. Defaults to No on empty/EOF input.
  local prompt="$1"
  local reply
  read -r -p "${prompt} [y/N] " reply </dev/tty || reply=""
  case "$reply" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

OS="$(uname -s)"
HAS_BREW=0
command -v brew >/dev/null 2>&1 && HAS_BREW=1

echo "${BOLD}AI Traffic Management Sandbox — setup${RESET}"
info "Repo: $REPO_ROOT"
info "Detected OS: $OS"

MISSING=0

# ---------------------------------------------------------------------------
# 1. Node.js >= 20
# ---------------------------------------------------------------------------
header "Checking Node.js (>= 20)..."
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 20 ] 2>/dev/null; then
    ok "Node.js $(node --version) found"
  else
    warn "Node.js $(node --version) found, but 20+ is required"
    MISSING=1
  fi
else
  warn "Node.js not found"
  MISSING=1
  if [ "$HAS_BREW" = "1" ]; then
    if ask_yes_no "Install Node.js 20 via Homebrew now?"; then
      brew install node@20 && ok "Node.js installed" && MISSING=0
    fi
  else
    err "Install Node.js 20+ manually: https://nodejs.org/en/download (or install Homebrew first: https://brew.sh)"
  fi
fi

# ---------------------------------------------------------------------------
# 2. pnpm
# ---------------------------------------------------------------------------
header "Checking pnpm..."
if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm --version) found"
else
  warn "pnpm not found"
  if command -v corepack >/dev/null 2>&1; then
    if ask_yes_no "Enable pnpm via corepack (ships with Node.js 16.13+)?"; then
      corepack enable && corepack prepare pnpm@9 --activate && ok "pnpm enabled via corepack"
    else
      MISSING=1
    fi
  elif [ "$HAS_BREW" = "1" ]; then
    if ask_yes_no "Install pnpm via Homebrew now?"; then
      brew install pnpm && ok "pnpm installed"
    else
      MISSING=1
    fi
  else
    err "Install pnpm manually: https://pnpm.io/installation"
    MISSING=1
  fi
fi

# ---------------------------------------------------------------------------
# 3. Python >= 3.12
# ---------------------------------------------------------------------------
header "Checking Python (>= 3.12)..."
PYTHON_BIN=""
for candidate in python3.12 python3.13 python3.14 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PY_VERSION="$("$candidate" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "0.0")"
    PY_MAJOR="${PY_VERSION%%.*}"
    PY_MINOR="${PY_VERSION##*.}"
    if [ "$PY_MAJOR" -ge 3 ] 2>/dev/null && [ "$PY_MINOR" -ge 12 ] 2>/dev/null; then
      PYTHON_BIN="$candidate"
      break
    fi
  fi
done
if [ -n "$PYTHON_BIN" ]; then
  ok "$($PYTHON_BIN --version) found ($PYTHON_BIN)"
else
  warn "Python 3.12+ not found"
  if [ "$HAS_BREW" = "1" ]; then
    if ask_yes_no "Install Python 3.12 via Homebrew now?"; then
      brew install python@3.12 && ok "Python installed" && PYTHON_BIN="python3.12"
    else
      MISSING=1
    fi
  else
    err "Install Python 3.12+ manually: https://www.python.org/downloads/"
    MISSING=1
  fi
fi

# ---------------------------------------------------------------------------
# 4. uv (Python package manager, used by ai-service)
# ---------------------------------------------------------------------------
header "Checking uv..."
if command -v uv >/dev/null 2>&1; then
  ok "uv $(uv --version | awk '{print $2}') found"
else
  warn "uv not found"
  if ask_yes_no "Install uv now via the official installer (curl | sh)?"; then
    curl -LsSf https://astral.sh/uv/install.sh | sh && ok "uv installed (you may need to restart your shell or 'source ~/.cargo/env')"
    export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
  elif [ "$HAS_BREW" = "1" ] && ask_yes_no "Install uv via Homebrew instead?"; then
    brew install uv && ok "uv installed"
  else
    err "Install uv manually: https://docs.astral.sh/uv/getting-started/installation/"
    MISSING=1
  fi
fi

# ---------------------------------------------------------------------------
# 5. Docker (optional — only needed for the Docker Compose run mode)
# ---------------------------------------------------------------------------
header "Checking Docker (optional, only needed for Docker Compose mode)..."
HAS_DOCKER=0
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "Docker + Docker Compose found and daemon is running"
    HAS_DOCKER=1
  else
    warn "Docker is installed but the daemon isn't running — start Docker Desktop if you want Docker Compose mode"
  fi
else
  warn "Docker / Docker Compose not found — local dev mode will still work without it"
  info "  Install from https://www.docker.com/products/docker-desktop/ if you want the single-command Compose mode"
fi

if [ "$MISSING" = "1" ]; then
  echo ""
  err "One or more required tools are still missing. Install them and re-run this script."
  exit 1
fi

# ---------------------------------------------------------------------------
# Install project dependencies
# ---------------------------------------------------------------------------
header "Installing JS/TS workspace dependencies (pnpm install)..."
pnpm install || { err "pnpm install failed"; exit 1; }
ok "Workspace dependencies installed"

header "Generating shared contracts (TS + Python types from JSON Schema)..."
pnpm --filter shared-contracts generate || { err "Contract generation failed"; exit 1; }
ok "Contracts generated"

header "Syncing ai-service Python environment (uv sync)..."
(cd ai-service && uv sync) || { err "uv sync failed"; exit 1; }
ok "ai-service environment ready"

# ---------------------------------------------------------------------------
# Fly.io deployment (optional — most people setting up local dev can skip this)
# ---------------------------------------------------------------------------
# App names/region are read from the committed infra/fly/*.toml files rather than duplicated here,
# so this section can never drift from what actually gets deployed.
SIM_SERVER_APP="$(grep -m1 '^app = ' infra/fly/sim-server.fly.toml | sed -E 's/app = "(.*)"/\1/')"
AI_SERVICE_APP="$(grep -m1 '^app = ' infra/fly/ai-service.fly.toml | sed -E 's/app = "(.*)"/\1/')"
FLY_REGION="$(grep -m1 '^primary_region = ' infra/fly/sim-server.fly.toml | sed -E 's/primary_region = "(.*)"/\1/')"
FLY_VOLUME="sessions_data"

header "Fly.io deployment (optional — only needed if you plan to deploy this app)"
if ask_yes_no "Set up Fly.io deployment now (installs flyctl, logs in, creates the two apps + persistent volume if they don't already exist)?"; then
  if command -v flyctl >/dev/null 2>&1; then
    ok "flyctl found ($(flyctl version 2>/dev/null | head -1))"
  else
    warn "flyctl not found"
    if [ "$HAS_BREW" = "1" ] && ask_yes_no "Install flyctl via Homebrew?"; then
      brew install flyctl && ok "flyctl installed"
    elif ask_yes_no "Install flyctl via the official installer (curl | sh)?"; then
      curl -L https://fly.io/install.sh | sh
      export FLYCTL_INSTALL="$HOME/.fly"
      export PATH="$FLYCTL_INSTALL/bin:$PATH"
      command -v flyctl >/dev/null 2>&1 && ok "flyctl installed" || warn "flyctl installed but not yet on PATH — restart your shell, or run: export PATH=\"\$HOME/.fly/bin:\$PATH\""
    else
      err "Install flyctl manually: https://fly.io/docs/flyctl/install/ — then re-run this script to continue Fly.io setup"
    fi
  fi

  if command -v flyctl >/dev/null 2>&1; then
    if flyctl auth whoami >/dev/null 2>&1; then
      ok "Logged in to Fly.io as $(flyctl auth whoami 2>/dev/null)"
    else
      warn "Not logged in to Fly.io"
      if ask_yes_no "Run 'flyctl auth login' now (opens a browser)?"; then
        flyctl auth login
      fi
    fi

    if flyctl auth whoami >/dev/null 2>&1; then
      for app in "$SIM_SERVER_APP" "$AI_SERVICE_APP"; do
        if flyctl status --app "$app" >/dev/null 2>&1; then
          ok "Fly app '$app' already exists"
        else
          warn "Fly app '$app' not found"
          if ask_yes_no "Create Fly app '$app' now?"; then
            if flyctl apps create "$app"; then
              ok "Created '$app'"
            else
              err "Failed to create '$app' — Fly app names are globally unique, so this name may already be taken by someone else. If so, pick a new name and update it in infra/fly/sim-server.fly.toml / ai-service.fly.toml, then re-run this script."
            fi
          fi
        fi
      done

      if flyctl status --app "$SIM_SERVER_APP" >/dev/null 2>&1; then
        if flyctl volumes list --app "$SIM_SERVER_APP" 2>/dev/null | grep -q "$FLY_VOLUME"; then
          ok "Volume '$FLY_VOLUME' already exists on $SIM_SERVER_APP"
        else
          warn "Volume '$FLY_VOLUME' not found on $SIM_SERVER_APP"
          if ask_yes_no "Create it now (1GB, region $FLY_REGION)?"; then
            flyctl volumes create "$FLY_VOLUME" --app "$SIM_SERVER_APP" --size 1 --region "$FLY_REGION" --yes && ok "Volume created"
          fi
        fi
      fi

      echo ""
      info "Apps/volume are ready. Deploys are a deliberate manual step, not part of CI — run"
      info "'flyctl deploy --config infra/fly/ai-service.fly.toml' and the sim-server equivalent"
      info "yourself whenever you're ready to ship a new version (see README's CI/CD Pipeline"
      info "section)."
    else
      warn "Skipping app/volume checks — not logged in to Fly.io."
    fi
  fi
else
  info "Skipped. Re-run this script anytime to set up Fly.io deployment."
fi

# ---------------------------------------------------------------------------
# Run mode
# ---------------------------------------------------------------------------
header "How would you like to run the app?"
echo "  1) Docker Compose — one command, closest to production (requires Docker running)"
echo "  2) Local dev processes — 3 processes (ai-service, sim-server, frontend), faster iteration"
echo "  3) Just set up, don't run anything now"
read -r -p "Choose [1/2/3]: " RUN_MODE </dev/tty || RUN_MODE=3

case "$RUN_MODE" in
  1)
    if [ "$HAS_DOCKER" != "1" ]; then
      err "Docker isn't available/running. Start Docker Desktop and re-run, or choose option 2."
      exit 1
    fi
    header "Starting via Docker Compose..."
    info "This builds all 3 images the first time — it can take a few minutes."
    docker compose -f infra/docker-compose.yml up --build
    ;;
  2)
    header "Starting local dev processes..."
    info "Logs from all 3 services will interleave below. Press Ctrl+C to stop everything."
    PIDS=()
    cleanup() {
      echo ""
      warn "Stopping all dev processes..."
      for pid in "${PIDS[@]}"; do
        # Negative PID targets the whole process group (see `set -m` above), so this also reaches
        # e.g. uv run's child uvicorn process and tsx watch's child node process, not just the
        # immediate wrapper — falls back to a plain kill if group-kill isn't permitted for some reason.
        kill -- "-$pid" >/dev/null 2>&1 || kill "$pid" >/dev/null 2>&1 || true
      done
      wait >/dev/null 2>&1 || true
    }
    trap cleanup EXIT INT TERM

    (cd ai-service && exec uv run uvicorn app.main:app --port 8000) &
    PIDS+=("$!")
    sleep 1

    (cd sim-server && AI_SERVICE_URL=http://localhost:8000 exec pnpm dev) &
    PIDS+=("$!")
    sleep 1

    (exec pnpm --filter frontend exec vite) &
    PIDS+=("$!")

    echo ""
    ok "ai-service   → http://localhost:8000"
    ok "sim-server   → ws://localhost:8080"
    ok "frontend     → http://localhost:5173"
    echo ""
    wait
    ;;
  *)
    ok "Setup complete. Run this script again anytime to start the stack."
    ;;
esac
