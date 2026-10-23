#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOING="$ROOT/boingai"

# Ensure rust toolchain on PATH
if [ -f "$HOME/.cargo/env" ]; then source "$HOME/.cargo/env"; fi
DOTNET="/snap/dotnet-sdk-100/current/usr/bin/dotnet"

echo "==> Building (if needed)"
(cd "$BOING/cpp-lib" && make >/dev/null 2>&1)
(cd "$BOING/rust-server" && cargo build --quiet 2>&1 | tail -3)
(cd "$BOING/csharp-service" && "$DOTNET" build -v q 2>&1 | tail -3)

if [ ! -d "$ROOT/desktop/node_modules" ]; then
  echo "==> Installing Electron (first run)"
  (cd "$ROOT/desktop" && npm install)
fi

echo "==> Opening BoingAI"
cd "$ROOT/desktop"
exec npm start
