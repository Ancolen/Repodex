#!/usr/bin/env bash
#
# Builds the vendored GDScript grammar wasm for cidx.
#
# Why this exists: the 15 bundled grammars come from `tree-sitter-wasms@0.1.13`
# (frozen, no gdscript). The npm `tree-sitter-gdscript` package ships only native
# prebuilds, so we build the wasm ourselves and vendor it at
# src/chunking/wasm/tree-sitter-gdscript.wasm.
#
# ABI constraint (docs/architecture.md): web-tree-sitter@0.22.6 accepts language
# ABI 13-14 only. tree-sitter-gdscript@2.0.0's shipped src/parser.c declares
# LANGUAGE_VERSION 14 — we compile it AS-IS (no `tree-sitter generate`, which
# could shift the ABI/node shapes) with the 0.20.x-era CLI that produces the
# side-module shape the pinned runtime's dylink loader expects.
#
# Provenance: tree-sitter-gdscript@2.0.0 (MIT, PrestonKnopp) +
# tree-sitter-cli@0.20.8 + emscripten/emsdk:3.1.61 (matches the tree-sitter-wasms
# emscripten era). Requires docker.

set -euo pipefail

GRAMMAR_PKG="tree-sitter-gdscript"
GRAMMAR_VERSION="2.0.0"
TS_CLI_VERSION="0.20.8"
EMSDK_IMAGE="emscripten/emsdk:3.1.61"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/src/chunking/wasm"
OUT_PATH="$OUT_DIR/tree-sitter-gdscript.wasm"

WORK="$(mktemp -d /tmp/gdscript-wasm.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "==> fetching ${GRAMMAR_PKG}@${GRAMMAR_VERSION}"
curl -fsSL "https://registry.npmjs.org/${GRAMMAR_PKG}/-/${GRAMMAR_PKG}-${GRAMMAR_VERSION}.tgz" -o "$WORK/pkg.tgz"
tar -xzf "$WORK/pkg.tgz" -C "$WORK"
GR="$WORK/package"

# Fail loudly on ABI drift: the pinned runtime rejects anything outside 13-14.
if ! grep -q '#define LANGUAGE_VERSION 14' "$GR/src/parser.c"; then
	echo "ERROR: ABI drift — ${GRAMMAR_PKG}@${GRAMMAR_VERSION} parser.c no longer declares LANGUAGE_VERSION 14." >&2
	echo "       web-tree-sitter@0.22.6 (pinned) accepts 13-14 only. Do not ship this build." >&2
	exit 1
fi

# tree-sitter build-wasm (0.20.x) reads a "tree-sitter" metadata section from
# package.json; the published tarball does not carry one.
node -e '
const fs = require("fs");
const path = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
if (!pkg["tree-sitter"]) {
	pkg["tree-sitter"] = [{ scope: "source.gdscript", "file-types": ["gd"] }];
	fs.writeFileSync(path, JSON.stringify(pkg, null, 2));
}
' "$GR/package.json"

echo "==> building wasm in docker (emcc via ${EMSDK_IMAGE}, tree-sitter-cli@${TS_CLI_VERSION})"
# Use host networking on Linux only: some WSL2 setups have broken DNS on the
# docker bridge (getent EAI_AGAIN for registry.npmjs.org) where host networking
# resolves fine. Docker Desktop (macOS/Windows) doesn't support --network host,
# so fall back to the default bridge there.
NETWORK_ARGS=""
if [[ "$(uname -s)" == "Linux" ]]; then
	NETWORK_ARGS="--network host"
fi
docker run --rm $NETWORK_ARGS -v "$GR":/work -w /work "$EMSDK_IMAGE" \
	sh -lc "npm install -g tree-sitter-cli@${TS_CLI_VERSION} && tree-sitter build-wasm"

BUILT="$(find "$GR" -maxdepth 1 -name '*.wasm' | head -1)"
if [[ -z "$BUILT" ]]; then
	echo "ERROR: build produced no wasm in $GR" >&2
	exit 1
fi

mkdir -p "$OUT_DIR"
cp "$BUILT" "$OUT_PATH"
echo "==> vendored → $OUT_PATH ($(stat -c%s "$OUT_PATH") bytes)"
sha256sum "$OUT_PATH"
