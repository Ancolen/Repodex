#!/usr/bin/env bash
#
# repodex / cidx — CLONE-FREE installation (single command)
#
#   curl -fsSL https://raw.githubusercontent.com/Ancolen/repodex/main/web-install.sh | bash
#
# What it does (without cloning the repo):
#   1. Detects the OS + architecture (linux/darwin · x64/arm64).
#   2. Downloads the appropriate PREBUILT single-binary from GitHub Releases + verifies sha256.
#   3. Installs the `cidx` and `repodex` commands to PATH (~/.local/bin).
#   4. Checks Ollama + the embedding model.
#   5. On Linux/systemd, installs a user service -> automatic daemon on every startup.
#      (Otherwise the daemon is started manually with `cidx start`.)
#   6. Starts the daemon and performs a health check.
#
# Bun or source code is NOT REQUIRED — the binary carries everything within itself.
# A running Ollama is still required as an embedding provider.
#
# Behavior via environment variables:
#   REPODEX_VERSION=v2.2.0  -> install a specific version (default: latest)
#   BIN_DIR=~/bin           -> directory where cidx/repodex are placed
#   NO_SERVICE=1            -> do not install the systemd service (only manual `cidx start`)
#   ASSUME_YES=1           -> automatically answer "yes" to interactive prompts
#   CIDX_HOME=...    -> explicitly set the data root (passed to the service + CLI)
#   OLLAMA_MODEL=...        -> embedding model (default: qwen3-embedding)
#   REPODEX_REPO=owner/name -> source repo (default: Ancolen/repodex)
#
set -euo pipefail

REPO="${REPODEX_REPO:-Ancolen/repodex}"
SERVICE_NAME="cidx"
MODEL="${OLLAMA_MODEL:-qwen3-embedding}"

# ----------------------------------------------------------------- helpers
if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; BOLD=""; NC=""
fi
info()  { printf "%s==>%s %s\n" "$BLUE$BOLD" "$NC" "$*"; }
ok()    { printf "%s  ✓%s %s\n" "$GREEN" "$NC" "$*"; }
warn()  { printf "%s  !%s %s\n" "$YELLOW" "$NC" "$*"; }
err()   { printf "%s  ✗%s %s\n" "$RED" "$NC" "$*" >&2; }
die()   { err "$*"; exit 1; }

# When running via curl | bash, stdin is the script itself; we read prompts from
# /dev/tty. If there is no tty, default to "no".
ask() {
  [ "${ASSUME_YES:-0}" = "1" ] && return 0
  [ -e /dev/tty ] || return 1
  local reply
  printf "%s  ?%s %s [y/N] " "$YELLOW" "$NC" "$1" > /dev/tty
  read -r reply < /dev/tty || return 1
  case "$reply" in [yY]*) return 0;; *) return 1;; esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# Download: curl if available, otherwise wget.
download() {
  # download <url> <target-file>
  local url="$1" out="$2"
  if have curl; then
    curl -fsSL "$url" -o "$out"
  elif have wget; then
    wget -qO "$out" "$url"
  else
    die "curl or wget is required."
  fi
}

printf "\n%srepodex — clone-free installation%s\n\n" "$BOLD" "$NC"

# --------------------------------------------- 1) platform detection
info "Detecting platform..."
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in
  Linux)  os="linux" ;;
  Darwin) os="darwin" ;;
  *) die "Unsupported operating system: $OS (Linux/macOS only). For source install: https://github.com/$REPO" ;;
esac
case "$ARCH" in
  x86_64|amd64)  arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) die "Unsupported architecture: $ARCH. For source install: https://github.com/$REPO" ;;
esac
ASSET="cidx-${os}-${arch}"
ok "Platform: $os/$arch  → asset: $ASSET"

# --------------------------------------------- 2) download + verify binary
VERSION="${REPODEX_VERSION:-latest}"
if [ "$VERSION" = "latest" ]; then
  BASE_URL="https://github.com/$REPO/releases/latest/download"
else
  BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

info "Downloading binary ($VERSION)..."
if ! download "$BASE_URL/$ASSET" "$TMP/$ASSET"; then
  err "Failed to download binary: $BASE_URL/$ASSET"
  err "There may be no published release for this platform."
  cat >&2 <<EOF

  Source install (Bun required):
      git clone https://github.com/$REPO cidx
      cd cidx && ./install.sh
EOF
  exit 1
fi
ok "Downloaded: $ASSET ($(du -h "$TMP/$ASSET" | cut -f1))"

# verify sha256 (if present)
if download "$BASE_URL/$ASSET.sha256" "$TMP/$ASSET.sha256" 2>/dev/null; then
  info "Verifying checksum (sha256)..."
  ( cd "$TMP"
    if have sha256sum; then
      sha256sum -c "$ASSET.sha256" >/dev/null
    elif have shasum; then
      shasum -a 256 -c "$ASSET.sha256" >/dev/null
    else
      warn "No sha256sum/shasum — verification skipped."
      exit 0
    fi
  ) && ok "Checksum valid." || die "Checksum verification FAILED — the downloaded file may be corrupt."
else
  warn "sha256 file not found — verification skipped."
fi

chmod +x "$TMP/$ASSET"

# --------------------------------------------- 3) install cidx / repodex
info "Installing cidx / repodex commands..."
choose_bin_dir() {
  if [ -n "${BIN_DIR:-}" ]; then echo "$BIN_DIR"; return; fi
  case ":$PATH:" in *":$HOME/.local/bin:"*) echo "$HOME/.local/bin"; return;; esac
  case ":$PATH:" in *":$HOME/bin:"*)        echo "$HOME/bin";        return;; esac
  echo "$HOME/.local/bin"
}
BIN_DIR="$(choose_bin_dir)"
mkdir -p "$BIN_DIR"

install -m 0755 "$TMP/$ASSET" "$BIN_DIR/cidx"
cp -f "$BIN_DIR/cidx" "$BIN_DIR/repodex"
chmod +x "$BIN_DIR/repodex"
BIN="$BIN_DIR/cidx"
ok "Installed: $BIN_DIR/{cidx,repodex}"

case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is already in PATH." ;;
  *) warn "$BIN_DIR is not in PATH. Add it to your shell profile:"
     printf "      %sexport PATH=\"%s:\$PATH\"%s\n" "$BOLD" "$BIN_DIR" "$NC" ;;
esac

# --------------------------------------------- 4) Ollama / model
info "Checking Ollama..."
if have ollama; then
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

# --------------------------------------------- 5) systemd service (Linux only)
HOME_OVERRIDE="${CIDX_HOME:-}"
DATA_HOME="${CIDX_HOME:-$HOME/.cidx}"

setup_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit="$unit_dir/$SERVICE_NAME.service"
  mkdir -p "$unit_dir"
  local home_env=""
  [ -n "$HOME_OVERRIDE" ] && home_env="Environment=CIDX_HOME=$HOME_OVERRIDE"
  # The compiled binary starts the daemon with the hidden `__daemon` sub-command.
  cat > "$unit" <<EOF
[Unit]
Description=cidx daemon (repodex)
Documentation=https://github.com/$REPO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN __daemon
Restart=on-failure
RestartSec=3
$home_env
# Settings can be overridden via environment variables:
# Environment=OLLAMA_URL=http://127.0.0.1:11434
# Environment=OLLAMA_MODEL=$MODEL

[Install]
WantedBy=default.target
EOF
  ok "Service file written: $unit"

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME.service" >/dev/null 2>&1 || true

  if have loginctl; then
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

SERVICE_INSTALLED=0
if [ "${NO_SERVICE:-0}" = "1" ]; then
  warn "NO_SERVICE=1 → systemd service not installed. Start manually: cidx start"
elif [ "$os" = "linux" ] && have systemctl && [ -d /run/systemd/system ]; then
  info "Installing systemd user service (automatic startup)..."
  setup_systemd
  SERVICE_INSTALLED=1
else
  warn "No systemd (e.g. macOS). Automatic startup skipped; start the daemon manually: cidx start"
fi

# --------------------------------------------- 6) start + health check
info "Daemon health check..."
CONTROL_PORT="${CONTROL_PORT:-9372}"
HOST="${HOST:-127.0.0.1}"

if [ "$SERVICE_INSTALLED" != "1" ]; then
  "$BIN" start || true
fi

UP=0
for _ in $(seq 1 40); do
  if have curl && curl -fsS "http://$HOST:$CONTROL_PORT/ping" >/dev/null 2>&1; then UP=1; break; fi
  if ! have curl && have wget && wget -qO- "http://$HOST:$CONTROL_PORT/ping" >/dev/null 2>&1; then UP=1; break; fi
  sleep 0.5
done

printf "\n"
if [ "$UP" = "1" ]; then
  ok "Daemon running: http://$HOST:$CONTROL_PORT"
else
  warn "Daemon did not respond. Check the logs:"
  [ "$SERVICE_INSTALLED" = "1" ] && printf "      journalctl --user -u %s -e\n" "$SERVICE_NAME"
  printf "      or: %s/daemon.log\n" "$DATA_HOME"
fi

# --------------------------------------------- summary
cat <<EOF

${BOLD}Installation complete.${NC}

  Commands:    cidx help    (alias: repodex help)
  Add project: cidx index /path/project --name backend
  List:        cidx list
  Search:      cidx search "user authentication"
EOF
if [ "$SERVICE_INSTALLED" = "1" ]; then
  cat <<EOF

  Service management (automatic startup):
    systemctl --user status  $SERVICE_NAME
    systemctl --user restart $SERVICE_NAME
    journalctl  --user -u    $SERVICE_NAME -f
EOF
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) printf "\n%sNote:%s open a new terminal before using the 'cidx' command, or:\n      export PATH=\"%s:\$PATH\"\n" "$YELLOW$BOLD" "$NC" "$BIN_DIR" ;;
esac
