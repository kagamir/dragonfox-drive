## AGENTS.md notes

### Toolchain
- Rust is installed at `%USERPROFILE%\.cargo\bin` but not on the default PATH
  for new shells. Use the absolute path
  `& "$env:USERPROFILE\.cargo\bin\cargo.exe" ...` or refresh PATH first:
  `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")`

### Useful commands

| Task                         | Command                                  |
|------------------------------|------------------------------------------|
| Check Rust backend           | `cargo check --manifest-path server\Cargo.toml` |
| Run backend                  | `cargo run --manifest-path server\Cargo.toml` |
| Install frontend deps        | `npm install --prefix web`               |
| Vite dev server              | `npm run dev --prefix web`               |
| Build frontend               | `npm run build --prefix web`             |
| Typecheck frontend           | `npm run typecheck --prefix web`         |
| Full production build        | build `web/` first, then `cargo build --release --manifest-path server\Cargo.toml` |

### Architecture
- See `docs/crypto-design.md` for the key hierarchy & threat model.
- See `docs/api.md` for the HTTP API contract.
- See `docs/streaming.md` for the Range+MSE video pipeline.

### Known gotchas
- `libsodium-wrappers-sumo` ships a broken relative import to
  `./libsodium-sumo.mjs`. A custom Vite plugin (`fixLibsodiumImport` in
  `web/vite.config.ts`) rewrites it to the real path inside `libsodium-sumo`.
  Do not remove that plugin or the production build will fail.
- `vue-tsc -b` (project references) conflicts with Vite's ESM loading of
  `vite.config.ts`. The `build` script intentionally runs `vite build` only;
  typecheck is a separate script.
