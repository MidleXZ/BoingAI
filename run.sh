#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOING="$ROOT/boingai"

# Ensure rust toolchain on PATH
if [ -f "$HOME/.cargo/env" ]; then source "$HOME/.cargo/env"; fi
DOTNET="/snap/dotnet-sdk-100/current/usr/bin/dotnet"

# Build C++ lib
echo "==> Building C++ text library"
(cd "$BOING/cpp-lib" && make)

# Build Rust server
echo "==> Building Rust server"
(cd "$BOING/rust-server" && cargo build)

# Build C# service
echo "==> Building C# memory service"
(cd "$BOING/csharp-service" && "$DOTNET" build)

# Start C# service
echo "==> Starting C# memory service on :5001"
(cd "$BOING/csharp-service" && "$DOTNET" run --no-build) &
CSHARP_PID=$!

# Start Rust server
echo "==> Starting Rust server on :8080"
export FRONTEND_DIR="$BOING/frontend"
export CSHARP_URL="http://localhost:5001"
export OLLAMA_URL="http://localhost:11434"
export MODEL="qwen2.5:1.5b"
(cd "$BOING/rust-server" && LD_LIBRARY_PATH="$BOING/cpp-lib:${LD_LIBRARY_PATH:-}" ./target/debug/boingai-server) &
RUST_PID=$!

echo ""
echo "BoingAI is running:"
echo "  UI:        http://localhost:8080"
echo "  Memory:    http://localhost:5001/health"
echo "  Ollama:    http://localhost:11434"
echo ""
echo "Press Ctrl+C to stop."

trap 'echo "Stopping..."; kill $RUST_PID $CSHARP_PID 2>/dev/null || true' INT TERM EXIT
wait
