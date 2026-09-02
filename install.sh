#!/usr/bin/env bash
#
# mcp-code-indexer — single-script installer
#
#   ./install.sh
#
# What it does (all idempotent — can be run repeatedly):
#   1. Checks for Bun, installs it with the OFFICIAL installer if missing (does NOT use snap).
#   2. Installs dependencies (bun install).
#   3. Adds the `cidx` and `repodex` commands to PATH (wrapper).
#   4. Checks Ollama and the embedding model.
#   5. Installs a systemd user service -> automatic daemon on every startup.
#   6. Starts the daemon and performs a health check.
#
# Note: If Bun is installed via snap, snap gives the app its own isolated HOME and
# data/settings end up in an unexpected place. This script REJECTS a snap bun and
# asks you to install it with the official installer. The default data root is
# ~/.mcp-indexer; no machine-specific path is forced (only MCP_INDEXER_HOME is
# honored if YOU provide it).
#
# Behavior via environment variables:
#   NO_SERVICE=1        -> do not install the systemd service (only manual `cidx start`)
#   BIN_DIR=...         -> directory where the cidx/repodex wrappers are placed
#   ASSUME_YES=1        -> automatically answer "yes" to interactive prompts
#   MCP_INDEXER_HOME=.. -> explicitly set the data root (passed to the service + CLI)
#
set -euo pipefail

# ----------------------------------------------------------------- helpers
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
info()  { printf "%s==>%s %s\n" "$BLUE$BOLD" "$NC" "$*"; }
ok()    { printf "%s  ✓%s %s\n" "$GREEN" "$NC" "$*"; }
warn()  { printf "%s  !%s %s\n" "$YELLOW" "$NC" "$*"; }
err()   { printf "%s  ✗%s %s\n" "$RED" "$NC" "$*" >&2; }
die()   { err "$*"; exit 1; }

ask() {
  # ask "question" -> 0 (yes) / 1 (no)
  [ "${ASSUME_YES:-0}" = "1" ] && return 0
  [ -t 0 ] || return 1            # default no if non-interactive
  local reply
  printf "%s  ?%s %s [y/N] " "$YELLOW" "$NC" "$1"
  read -r reply
  case "$reply" in [yY]*) return 0;; *) return 1;; esac
}

# Absolute path of the repo (correct even when called via a symlink).
REPO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
SERVICE_NAME="mcp-code-indexer"

# Data root. By default we do NOT pin it anywhere: on a non-snap bun,
# os.homedir() already returns the real ~ and the daemon uses ~/.mcp-indexer.
# Only if the user EXPLICITLY provides MCP_INDEXER_HOME do we pass it to the service/CLI.
if [ -n "${MCP_INDEXER_HOME:-}" ]; then
  HOME_OVERRIDE="$MCP_INDEXER_HOME"
  DATA_HOME="$MCP_INDEXER_HOME"
else
  HOME_OVERRIDE=""
  DATA_HOME="$HOME/.mcp-indexer"   # for informational messages only
fi

printf "\n%smcp-code-indexer installation%s\n" "$BOLD" "$NC"
printf "repo: %s\n\n" "$REPO_DIR"

# --------------------------------------------------------------- 1) bun check
info "Checking Bun..."

# is bun installed via snap? (path under /snap or a symlink to snap)
is_snap_bun() {
  local b rp
  b="$(command -v bun 2>/dev/null || true)"
  [ -n "$b" ] || return 1
  case "$b" in /snap/*) return 0;; esac
  rp="$(readlink -f "$b" 2>/dev/null || true)"
  case "$rp" in /snap/*) return 0;; esac
  return 1
}

install_official_bun() {
  info "Running the official Bun installer (https://bun.sh/install)..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"   # make the official bun take precedence in this session
}

if command -v bun >/dev/null 2>&1 && is_snap_bun; then
  err "Bun appears to be installed via snap: $(command -v bun)"
  err "Because snap gives the app an isolated HOME, data/settings end up in the wrong place."
  cat >&2 <<'EOF'

  Please remove the snap bun and install it with the official installer:

      sudo snap remove bun-js        # (if your snap name differs: snap list | grep -i bun)
      curl -fsSL https://bun.sh/install | bash
      source ~/.bashrc               # or open a new terminal

  Then run this script again: ./install.sh
EOF
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  warn "Bun not found."
  if ask "Should I install Bun with the official installer? (snap is NOT used)"; then
    install_official_bun
  else
    die "Bun is required. Official install: curl -fsSL https://bun.sh/install | bash"
  fi
fi
command -v bun >/dev/null 2>&1 || die "Bun not found in PATH. Reopen the terminal and try again."
BUN_BIN="$(command -v bun)"
ok "Bun ready: $BUN_BIN ($(bun --version))"

# ----------------------------------------------------- 2) install dependencies
info "Installing dependencies (bun install)..."
( cd "$REPO_DIR" && bun install )
ok "Dependencies installed."

# --------------------------------------------- 3) cidx / repodex commands
info "Adding cidx / repodex commands to PATH..."
choose_bin_dir() {
  if [ -n "${BIN_DIR:-}" ]; then echo "$BIN_DIR"; return; fi
  case ":$PATH:" in *":$HOME/.local/bin:"*) echo "$HOME/.local/bin"; return;; esac
  case ":$PATH:" in *":$HOME/.bun/bin:"*)   echo "$HOME/.bun/bin";   return;; esac
  echo "$HOME/.local/bin"   # put it here even if not in PATH, then warn
}
BIN_DIR="$(choose_bin_dir)"
mkdir -p "$BIN_DIR"

make_wrapper() {
  local name="$1" target="$REPO_DIR/src/cli.ts"
  local home_line=""
  # Only pass the data root to the CLI if the user explicitly provided one.
  [ -n "$HOME_OVERRIDE" ] && home_line="export MCP_INDEXER_HOME=\"\${MCP_INDEXER_HOME:-$HOME_OVERRIDE}\""
  cat > "$BIN_DIR/$name" <<EOF
#!/usr/bin/env bash
# mcp-code-indexer CLI wrapper (generated by install.sh)
$home_line
exec "$BUN_BIN" run "$target" "\$@"
EOF
  chmod +x "$BIN_DIR/$name"
}
make_wrapper cidx
make_wrapper repodex
ok "Wrappers created: $BIN_DIR/{cidx,repodex}"

case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is already in PATH." ;;
  *) warn "$BIN_DIR is not in PATH. Add this to your shell profile:"
     printf "      %sexport PATH=\"%s:\$PATH\"%s\n" "$BOLD" "$BIN_DIR" "$NC" ;;
esac

# ------------------------------------------------------ 4) Ollama / model
info "Checking Ollama..."
MODEL="${OLLAMA_MODEL:-qwen3-embedding}"
if command -v ollama >/dev/null 2>&1; then
  ok "Ollama found: $(command -v ollama)"
  if ollama list 2>/dev/null | awk '{print $1}' | grep -q "^${MODEL}\(:latest\)\?$"; then
    ok "Embedding model present: $MODEL"
  else
    warn "Embedding model '$MODEL' not found."
    if ask "Should I download it now? (ollama pull $MODEL — may be large)"; then
      ollama pull "$MODEL" || warn "Failed to download model; later: ollama pull $MODEL"
    else
      warn "Skipped. Before searching: ollama pull $MODEL"
    fi
  fi
else
  warn "Ollama not found. Install: https://ollama.com  then: ollama pull $MODEL"
fi

# ---------------------------------------------- 5) systemd user service
setup_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit="$unit_dir/$SERVICE_NAME.service"
  mkdir -p "$unit_dir"
  # Only pass the data root to the service if the user explicitly provided one;
  # otherwise the daemon uses the natural ~/.mcp-indexer (no machine-specific path forced).
  local home_env=""
  [ -n "$HOME_OVERRIDE" ] && home_env="Environment=MCP_INDEXER_HOME=$HOME_OVERRIDE"
  cat > "$unit" <<EOF
[Unit]
Description=MCP Code Indexer Daemon
Documentation=https://github.com/  (mcp-code-indexer)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BUN_BIN run $REPO_DIR/src/index.ts
Restart=on-failure
RestartSec=3
$home_env
# Settings can also be overridden via environment variables:
# Environment=OLLAMA_URL=http://127.0.0.1:11434
# Environment=OLLAMA_MODEL=$MODEL

[Install]
WantedBy=default.target
EOF
  ok "Service file written: $unit"

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME.service" >/dev/null 2>&1 || true

  # linger so it runs at boot even when the session is not open.
  if command -v loginctl >/dev/null 2>&1; then
    if loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
      ok "Linger already enabled (starts automatically at boot)."
    elif loginctl enable-linger "$USER" 2>/dev/null; then
      ok "Linger enabled (starts automatically at boot)."
    else
      warn "Could not enable linger. For boot automation: sudo loginctl enable-linger $USER"
    fi
  fi

  info "Starting the service..."
  systemctl --user restart "$SERVICE_NAME.service"
}

if [ "${NO_SERVICE:-0}" = "1" ]; then
  warn "NO_SERVICE=1 → systemd service not installed. Start manually: cidx start"
elif command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  info "Installing systemd user service (automatic startup)..."
  setup_systemd
else
  warn "systemd not found. Automatic startup skipped; start the daemon manually: cidx start"
fi

# ----------------------------------------------------- 6) health check
info "Daemon health check..."
CONTROL_PORT="${CONTROL_PORT:-9372}"
HOST="${HOST:-127.0.0.1}"

# If the service was not installed, start manually.
if [ "${NO_SERVICE:-0}" = "1" ] || ! command -v systemctl >/dev/null 2>&1; then
  "$BIN_DIR/cidx" start || true
fi

UP=0
for _ in $(seq 1 40); do
  if curl -fsS "http://$HOST:$CONTROL_PORT/ping" >/dev/null 2>&1; then UP=1; break; fi
  sleep 0.5
done

printf "\n"
if [ "$UP" = "1" ]; then
  ok "Daemon running: http://$HOST:$CONTROL_PORT"
else
  warn "Daemon did not respond. Check the logs:"
  printf "      journalctl --user -u %s -e   (systemd)\n" "$SERVICE_NAME"
  printf "      or: %s/daemon.log\n" "$DATA_HOME"
fi

# --------------------------------------------------------------- summary
cat <<EOF

${BOLD}Installation complete.${NC}

  Commands:    cidx help    (alias: repodex help)
  Add project: cidx index /path/project --name backend
  List:        cidx list
  Search:      cidx search "user authentication"

  Service management (automatic startup):
    systemctl --user status  $SERVICE_NAME
    systemctl --user restart $SERVICE_NAME
    systemctl --user stop    $SERVICE_NAME
    journalctl  --user -u    $SERVICE_NAME -f

  Uninstall:   ./uninstall.sh
EOF

# Remind if PATH is missing in this session.
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) printf "\n%sNote:%s open a new terminal before using the 'cidx' command, or:\n      export PATH=\"%s:\$PATH\"\n" "$YELLOW$BOLD" "$NC" "$BIN_DIR" ;;
esac
