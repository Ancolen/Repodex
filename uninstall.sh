#!/usr/bin/env bash
#
# mcp-code-indexer — uninstall script
#
#   ./uninstall.sh
#
# What it does:
#   1. Stops the daemon, disables and removes the systemd service.
#   2. Removes the cidx / repodex wrappers.
#
# Data (~/.mcp-indexer) is PRESERVED. To delete it completely:
#   PURGE_DATA=1 ./uninstall.sh
#
set -euo pipefail

GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
info() { printf "%s==>%s %s\n" "$BLUE$BOLD" "$NC" "$*"; }
ok()   { printf "%s  ✓%s %s\n" "$GREEN" "$NC" "$*"; }
warn() { printf "%s  !%s %s\n" "$YELLOW" "$NC" "$*"; }

SERVICE_NAME="mcp-code-indexer"
REPO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

# 1) systemd service
if command -v systemctl >/dev/null 2>&1; then
  info "Removing systemd service..."
  systemctl --user stop    "$SERVICE_NAME.service" 2>/dev/null || true
  systemctl --user disable "$SERVICE_NAME.service" 2>/dev/null || true
  unit="$HOME/.config/systemd/user/$SERVICE_NAME.service"
  if [ -f "$unit" ]; then rm -f "$unit"; ok "Service file deleted: $unit"; fi
  systemctl --user daemon-reload 2>/dev/null || true
fi

# If there is no service, the daemon may still be running — stop it gracefully.
if [ -f "$REPO_DIR/src/cli.ts" ] || command -v cidx >/dev/null 2>&1; then
  "$REPO_DIR/src/cli.ts" stop 2>/dev/null || cidx stop 2>/dev/null || \
    { command -v bun >/dev/null 2>&1 && bun run "$REPO_DIR/src/cli.ts" stop 2>/dev/null; } || true
fi

# 2) wrappers
info "Removing cidx / repodex wrappers..."
removed=0
for d in "${BIN_DIR:-}" "$HOME/.local/bin" "$HOME/.bun/bin" "/usr/local/bin"; do
  [ -n "$d" ] || continue
  for name in cidx repodex; do
    f="$d/$name"
    # only delete the wrapper we generated
    if [ -f "$f" ] && grep -q "mcp-code-indexer CLI wrapper" "$f" 2>/dev/null; then
      rm -f "$f"; ok "Deleted: $f"; removed=1
    fi
  done
done
[ "$removed" = "1" ] || warn "No wrappers found to delete."

# 3) data (optional)
DATA_DIR="${MCP_INDEXER_HOME:-$HOME/.mcp-indexer}"
if [ "${PURGE_DATA:-0}" = "1" ]; then
  info "Deleting data: $DATA_DIR"
  rm -rf "$DATA_DIR"
  ok "Data deleted."
else
  warn "Data preserved: $DATA_DIR  (to delete: PURGE_DATA=1 ./uninstall.sh)"
fi

printf "\n%sUninstall complete.%s\n" "$BOLD" "$NC"
