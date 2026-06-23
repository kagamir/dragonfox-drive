# DragonFox Drive

A high-performance **end-to-end encrypted** cloud drive with a **zero-trust** backend.

- Browser-first: users access everything via a web UI.
- All encryption happens in the browser - the server only stores opaque
  encrypted blobs and never sees plaintext, file names, or keys.
- Stream large videos with seek support via HTTP Range + Media Source Extensions.
- Backend written in Rust; frontend is Vue 3 + TypeScript.

## Architecture in one paragraph

The user's password is run through Argon2id in the browser to derive a
`password_key`, which is used to (a) derive an `auth_verifier` sent to the
server for login and (b) unwrap the user's `master_key`. The `master_key`
wraps per-file `file_key`s (AES-256-GCM). Files are split into 4 MiB chunks,
each encrypted with its own IV, so any chunk can be fetched and decrypted
independently for HTTP Range-based video streaming.

Detailed design: [docs/crypto-design.md](docs/crypto-design.md),
[docs/api.md](docs/api.md), [docs/streaming.md](docs/streaming.md).

## Repo layout

```
dragonfox-drive/
├── server/          # Rust backend (axum + sqlx + local FS)
│   ├── src/
│   ├── migrations/  # SQL migrations
│   ├── Cargo.toml
│   └── config.toml
├── web/             # Vue 3 + TypeScript frontend (Vite)
│   ├── src/
│   │   ├── crypto/      # KDF, symmetric, key hierarchy
│   │   ├── workers/     # Web Workers (crypto offload)
│   │   ├── api/         # HTTP client + endpoint modules
│   │   ├── stores/      # Pinia state
│   │   ├── views/       # Route-level pages
│   │   └── router/      # vue-router setup
│   ├── vite.config.ts
│   └── package.json
├── docs/            # Design documents
└── docker-compose.yml
```

## Quick start (development)

### Prerequisites
- Rust 1.75+ (https://rustup.rs)
- Node.js 20+ & npm
- A C compiler (for SQLite's build-time `cc`)

### Run the backend
```bash
cd server
cargo run
# Listening on http://127.0.0.1:8080
```

### Run the frontend (separate terminal)
```bash
cd web
npm install
npm run dev
# Open http://localhost:5173 (proxies /api → :8080)
```

## Production build (single binary)

```bash
# Build the frontend first
cd web && npm install && npm run build && cd ..

# Build the backend - it embeds web/dist via rust-embed
cd server && cargo build --release
# Binary: server/target/release/dragonfox-drive
```

Then run the binary - it serves both the API and the SPA on the same port.

Configuration: edit `server/config.toml` or set `DRAGONFOX__*` environment
variables (e.g. `DRAGONFOX__JWT__SECRET=...`).

## Status

| Phase | Scope | Status |
|-------|-------|--------|
| P1 | Scaffolding, E2EE auth, single-chunk upload/download | ✅ complete |
| P2 | Chunked upload/download, video streaming via Service-Worker proxy | ✅ complete (P2b: streaming uses a Service-Worker proxy rather than MSE) |
| P3 | Link sharing, encrypted folder tree | ⏳ planned |
| P4 | Device management & revocation, polish | ⏳ planned |

## License

GNU AFFERO GENERAL PUBLIC LICENSE Version 3
