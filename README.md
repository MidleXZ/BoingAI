# BoingAI

A minimal, polished AI chat application powered by **MiniCPM-V 4.6 1B** (`minicpm-v4.6:1b`), running locally via Ollama.

BoingAI is built across four languages, each with a distinct responsibility:

| Language | Role |
|----------|------|
| **Rust** | HTTP backend / API gateway (axum). Orchestrates the other components, serves the UI, talks to Ollama. |
| **C++** | Native text library (`libboing_text.so`) for input sanitization, token estimation and prompt formatting, called from Rust via FFI. |
| **C#** | ASP.NET Core memory service for conversation & message persistence. |
| **HTML/CSS/JS** | Minimal, responsive chat interface. |

## Architecture

```
Browser (HTML/CSS/JS)
        │
        ▼
Rust server :8080  ──► C++ lib (FFI)        (sanitize / tokens)
        │
        ├──► C# service :5001              (conversations, messages)
        │
        └──► Ollama :11434  (minicpm-v4.6:1b)
```

## Prerequisites

- Ollama running locally with `minicpm-v4.6:1b` pulled (`ollama pull minicpm-v4.6:1b`)
- Rust toolchain (cargo)
- g++ (C++17)
- .NET SDK 10

## Run

```bash
./run.sh
```

Then open http://localhost:8080

## Endpoints

- `GET  /health` — service health (includes C++ lib version)
- `GET  /api/conversations` — list conversations
- `GET  /api/conversations/:id` — get a conversation
- `POST /api/chat` — `{ conversation_id?, message }` → `{ conversation_id, reply, tokens_in, tokens_out }`
- `DELETE /api/conversations/:id` — delete a conversation

## Layout

```
boingai/
├── frontend/        # HTML, CSS, JS
├── rust-server/     # Rust backend (axum)
├── cpp-lib/         # C++ shared library
└── csharp-service/  # .NET memory service
```
# BoingAI
