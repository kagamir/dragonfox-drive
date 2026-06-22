# Unit Test Coverage — Design Spec

- **Date**: 2026-06-23
- **Status**: Approved (pre-implementation)
- **Scope**: Full testable surface, both `server/` (Rust) and `web/` (Vue 3 + TS)
- **Approach**: B — Conventional + property-based tests for crypto
- **Project state at time of writing**: single `init` commit; most API handlers are
  placeholders returning "not yet implemented". Only the pure logic layers are
  testable today.

---

## 1. Goal

Add unit test coverage for all currently-implemented logic in DragonFox Drive,
with extra rigor (property-based testing) on the end-to-end-encryption layer
where bugs are silent and catastrophic.

### In scope
- Frontend: `crypto/*`, `api/client.ts`, `workers/crypto.worker.ts`
- Backend: `auth/mod.rs`, `storage/mod.rs`, `config.rs`, `error.rs`, `db/mod.rs`

### Out of scope (YAGNI for this round)
- `stores/*.ts`, `views/*.vue`, `router/` — depend on unimplemented API
- Placeholder API handlers (`api/{auth,files,shares}.rs`, `api/health.rs`, `api/assets.rs`, `api/mod.rs`)
- Thin TS API wrappers (`api/{auth,files,shares}.ts`) — pure type-level re-exports
- `state.rs`, `main.rs` — trivial wiring
- Coverage gating / mutation testing (deferred to approach C)
- HTTP end-to-end integration tests (deferred to approach C)

---

## 2. Tooling & Dependencies

### Frontend (`web/`) — new devDependencies
| Package | Purpose |
|---|---|
| `vitest` | Vite-native test runner; inherits `vite.config.ts` |
| `happy-dom` | Provides `crypto.subtle`, `fetch`, `btoa`, `TextEncoder`, `crypto.getRandomValues` |
| `@vue/test-utils` | Reserved for future store/component tests |
| `fast-check` | Property-based testing (approach B core) |
| `msw` | Intercepts `fetch` for `api/client.ts` tests |

### Frontend — new `package.json` scripts
```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```
> `test:coverage` is an entry point only; no gate is enforced this round.

### Backend (`server/Cargo.toml`) — new `[dev-dependencies]`
| Crate | Purpose |
|---|---|
| `tempfile` | Real temporary directories for FS isolation |
| `proptest` | Property-based testing |
| `pretty_assertions` | Readable diff on assertion failure |

`tokio` is already a full-featured dependency; `#[tokio::test]` works out of the
box. sqlx in-memory SQLite uses the `sqlite::memory:` URL — no new dep.

### Explicitly NOT introduced
- `cargo-mutants`, `stryker`, `tarpaulin`, `c8` (approach C only)
- `mockall` (hand-written fakes are clearer)
- Vitest UI / snapshot plugins

---

## 3. Test Environment & Mocking Strategy

Principle: **use the real thing whenever possible; mock only browser-only APIs.**

### Frontend
- `web/vite.config.ts` gains a `test:` field (see §6 for exact shape). The
  existing `fixLibsodiumImport` plugin is preserved untouched (per AGENTS.md).
- `environment: 'happy-dom'`, `globals: true`,
  `setupFiles: ['./src/__test__/setup.ts']`.

#### `web/src/__test__/setup.ts` does three things
1. **`initCrypto` warm-up**: `beforeAll(() => initCrypto())` loads libsodium
   WASM once for the whole suite (WASM load is slow).
2. **`localforage` mock**: an in-memory `Map` implementing
   `getItem/setItem/removeItem`, registered via `vi.mock("localforage", ...)`.
   Makes `crypto/keys.ts` device-key persistence testable.
3. **`fetch` mock**: `msw`'s `setupServer(...)` started in `beforeAll`, reset in
   `beforeEach`, stopped in `afterEach`. All `api/client.ts` branches (success,
   error envelope, 204, network failure, rawBody, rawResponse, AbortSignal) go
   through msw routes.

#### Worker handling
`new Worker(...)` does not function under `happy-dom`. The Comlink-exposed
`api` object in `workers/crypto.worker.ts` is not currently exported. **The one
non-test source change in this round**: add `export` to that `api` object.
`Comlink.expose(api)` stays put. Tests then import the `api` object directly
and assert on its methods. This is a benign refactor.

### Backend
- **Filesystem**: each test gets its own `tempfile::tempdir()`. A temporary
  `Settings` is built with only `storage.data_dir` overridden; auto-cleaned on
  test end.
- **SQLite**: `db::connect("sqlite::memory:")` builds an in-memory pool;
  `db::migrate` runs the `sqlx::migrate!()` macro (migrations embedded at
  compile time; relative path resolves correctly under
  `cargo test --manifest-path server\Cargo.toml`).
- **JWT**: real `EncodingKey`/`DecodingKey`. A test `AppState` is built with
  `Settings::default()` whose `jwt.secret` is set to a known value. Covers
  issue/verify round-trip, wrong secret, expired, malformed. Expiry is simulated
  by hand-constructing `AccessClaims { exp: now - 1, ... }` and encoding it —
  no real waiting.
- **`AuthUser` extractor**: `axum::http::Request::builder()` builds requests
  with/without `Authorization: Bearer ...`; `Parts` is extracted and
  `FromRequestParts::from_request_parts` is invoked directly. No full server.

---

## 4. Test Inventory (by module)

Format: `file → test cases`. `[P]` = property-based test.

### Frontend `web/`

#### `src/crypto/kdf.ts` → `kdf.test.ts`
- `normaliseEmail`: trim + lowercase; mixed case/whitespace normalised
- `emailToSalt`: deterministic; length 16; different emails → different salts
- `derivePasswordKey`: deterministic; length 32; different password/email →
  different keys `[P random password]`
- `deriveAuthVerifier`: deterministic; length 32; different serverSalt →
  different output
- `deriveSubkey`: deterministic; different `info` → different subkey; honours
  `length` parameter `[P random info]`
- `randomBytes`: correct length; two consecutive calls differ
  `[P uniqueness over many calls]`

#### `src/crypto/symmetric.ts` → `symmetric.test.ts`
- `chunkIv`: throws on wrong ivBase length; `index=0` equals base; does not
  mutate input; different index → different IV; same (base,index) deterministic
  `[P index ∈ [0, 2^32)]`
- `encryptChunk`/`decryptChunk`: round-trip; ciphertext tamper → throws;
  AAD mismatch → throws; different IV → different ciphertext
  `[P random plaintext/key/AAD round-trip]`
- `encrypt`/`decrypt`: round-trip; each `encrypt` produces a fresh random IV
- `CONSTANTS`: exact value assertions (guards against accidental edits)

#### `src/crypto/keys.ts` → `keys.test.ts` (uses localforage mock)
- `generateMasterKey`/`generateFileKey`: 32 bytes; two consecutive calls differ
  `[P]`
- `wrapMasterKey`/`unwrapMasterKey`: round-trip; wrong wrapper → throws;
  does not mutate input
- `wrapWithPassword`/`unwrapWithPassword`: round-trip; wrong password → throws
- `getOrCreateDeviceKey`: generates and persists on first call; returns same
  value on second call (mock verifies `setItem` invoked)
- `persistDeviceWrap`/`loadDeviceWrap`/`clearDeviceWrap`: write→read round-trip;
  after `clear`, read returns null

#### `src/api/client.ts` → `client.test.ts` (uses msw)
- `setAuthToken`/`getAuthToken`: setter/getter
- `request` success path: parses JSON
- Error envelope `{error}` → `ApiError` carrying status/body
- `204` → returns `undefined`
- Network failure → `ApiError` with status 0
- `rawResponse: true` → returns the raw `Response`, skips JSON
- `rawBody` → body is passed through untouched
- Authorization header injection when token is set; `token: null` omits it
- `AbortSignal` is forwarded; aborting throws
- `http.get/post/put/delete` map to correct methods

#### `src/workers/crypto.worker.ts` → `crypto.worker.test.ts`
- Against the exported `api` object: `init()` is awaitable;
  `derivePasswordKey`/`deriveAuthVerifier` match direct calls;
  `encryptChunk`/`decryptChunk` (with ivBase + index) round-trip;
  `wrap`/`unwrap` round-trip; `newMasterKey`/`randomServerSalt` produce
  correctly-sized output

### Backend `server/`

#### `src/auth/mod.rs` → inline `mod tests`
- `issue_token_pair`: both access/refresh decode with the correct secret;
  `sub` and `dev` populated; refresh `exp` > access `exp`; the two token strings differ
- `verify_access_token`: round-trip; wrong secret → `Unauthorized`; malformed
  token → `Unauthorized`; expired (hand-encoded `exp = now - 1`) → `Unauthorized`
- `AuthUser` extractor: valid Bearer → extracts `user_id`/`device_id`; missing
  header → `Unauthorized`; non-`Bearer ` prefix → `Unauthorized`; invalid token
  → `Unauthorized`

#### `src/storage/mod.rs` → inline `mod tests` (uses tempfile)
- `chunk_path`: long id shards correctly (`/blobs/ab/cd/<id>/chunk_3`); short
  id (<2 / <4 chars) hits fallback branches; different index → different
  filename `[P id/index combinations]`
- `write_chunk`/`read_chunk`: round-trip; no `.tmp` residue after write;
  multi-level directories auto-created; reading missing chunk → `Ok(None)`
- `delete_file_chunks`: directory gone after delete; deleting again → `Ok(())`
  (NotFound swallowed); sibling directories untouched

#### `src/config.rs` → inline `mod tests`
- `Settings::default()`: every field equals documented default (port=8080,
  access_ttl=900, etc.)
- Each sub-struct's `Default` is correct
- `Settings::load()`: `tempfile::tempdir()` + `config.toml` file +
  `DRAGONFOX__SERVER__PORT` env var validates the override chain. Env tests
  use `std::env::set_var`/`remove_var` and the suite is run with
  `--test-threads=1` to avoid cross-test pollution (no `serial_test` dep).

#### `src/error.rs` → inline `mod tests`
- Each `ApiError` variant → correct `StatusCode`
- `From<sqlx::Error>`: `RowNotFound` → `NotFound`; other → `Internal`
- `IntoResponse`: `Internal` body message is `"internal server error"` (no
  detail leakage); `BadRequest("x")` body message contains `x`

#### `src/db/mod.rs` → inline `mod tests`
- `connect("sqlite::memory:")`: pool builds; connection count within limit
- `migrate`: afterwards `users`/`files`/`shares`/`devices`/`file_chunks`/
  `refresh_tokens` tables exist (`SELECT name FROM sqlite_master`);
  `PRAGMA foreign_keys` returns 1

---

## 5. Property-Based Invariants (approach B core)

Property tests assert a mathematical law over a class of inputs, not a single
example. Invariants per `[P]` test:

### Frontend (fast-check)

| Target | Input generator | Invariant (holds for any input) |
|---|---|---|
| `derivePasswordKey` | `fc.string(1..64)` × email-like | (a) same input → same output; (b) changing any char changes output; (c) length always 32 |
| `deriveSubkey` | `fc.hexaString(1..32)` as `info` | (a) deterministic; (b) different `info` → different output; (c) output length == `length` arg |
| `randomBytes` | `fc.integer(1..1024)` | length == n; 100 consecutive calls all distinct |
| `chunkIv` | `fc.uint8Array(12)` × `fc.integer(0..2^32-1)` | (a) does not mutate input; (b) index=0 → output == base; (c) same (base,index) deterministic; (d) changing index changes output |
| `encryptChunk/decryptChunk` | random plaintext ≤4096B × random 32B key × random 12B IV × optional AAD | **core law**: `decrypt(key, iv, encrypt(key, iv, pt, aad), aad) == pt`; flipping any ciphertext byte throws |
| `generateMasterKey/FileKey` | (no input) | 32 bytes; 100 consecutive calls all distinct |

**fast-check config**: `numRuns: 100` (default is sufficient); automatic
shrinking to the minimal counterexample on failure. A shared
`fc.uint8Array(maxLength)` helper lives in `src/__test__/fc-arbitrary.ts`.

### Backend (proptest)

| Target | Input strategy | Invariant |
|---|---|---|
| `chunk_path` | `prop::collection::vec(any::<char>(), 1..64)` as file_id (ASCII and short strings) × `0..u32::MAX` index | (a) path ends with `blobs/<s1>/<s2>/<id>/chunk_<index>`; (b) same input deterministic; (c) different index → different path; (d) short ids do not panic |

> **Known concern surfaced by proptest**: `chunk_path` slices `&file_id[..2]`
> by byte index. Non-ASCII multi-byte characters at a slice boundary will
> panic. Real callers use UUIDs (ASCII), so this is a documentation constraint
> rather than a live bug. **This round records the behaviour as-is in tests
> and does not change source semantics.** If proptest surfaces an actual panic
> for ASCII-only inputs, that would be treated as a real bug to fix.

### Shared assertion style
- Property and example tests are mixed in the same file (no separate
  `*.property.test.ts`). Group with `describe("properties", () => ...)`.
- Backend uses the `proptest!` macro block inside `mod tests`.

---

## 6. File Layout & Commands

### New / modified files

**Frontend**
```
web/
├── package.json                      # mod: +5 devDeps, +3 scripts
├── vite.config.ts                    # mod: +test: {...} field
└── src/
    ├── __test__/
    │   ├── setup.ts                  # new: initCrypto warm-up + localforage mock + msw server
    │   └── fc-arbitrary.ts           # new: shared fc.uint8Array / email helpers
    ├── crypto/
    │   ├── kdf.test.ts               # new
    │   ├── symmetric.test.ts         # new
    │   └── keys.test.ts              # new
    ├── api/
    │   └── client.test.ts            # new
    └── workers/
        ├── crypto.worker.ts          # mod: `export const api = ...` (1 line)
        └── crypto.worker.test.ts     # new
```

**Backend** (all inline `mod tests`, no new files)
```
server/
├── Cargo.toml                        # mod: +[dev-dependencies]
└── src/
    ├── auth/mod.rs                   # +mod tests
    ├── storage/mod.rs                # +mod tests
    ├── config.rs                     # +mod tests
    ├── error.rs                      # +mod tests
    └── db/mod.rs                     # +mod tests
```

### `vite.config.ts` shape (additive)
```ts
/// <reference types="vitest/config" />
export default defineConfig({
  plugins: [vue(), fixLibsodiumImport()],
  // ...existing config untouched...
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/__test__/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});
```
> Per AGENTS.md, `vue-tsc -b` conflicts with Vite's ESM loading; the `typecheck`
> script runs `vue-tsc --noEmit -p tsconfig.app.json` and does not read the
> `test:` field, so adding it is safe.

### Commands

| Task | Command |
|---|---|
| Run frontend tests | `npm test --prefix web` |
| Frontend watch mode | `npm run test:watch --prefix web` |
| Backend tests | `cargo test --manifest-path server\Cargo.toml` |
| Backend (env tests serial) | `cargo test --manifest-path server\Cargo.toml -- --test-threads=1` |

---

## 7. Acceptance Criteria

1. `npm test --prefix web` is green.
2. `cargo test --manifest-path server\Cargo.toml` is green.
3. `npm run typecheck --prefix web` is still green (test files must be type-clean).
4. `cargo check --manifest-path server\Cargo.toml` is still green.
5. No business logic changes (sole exception: the 1-line `export` in
   `crypto.worker.ts`).
6. If proptest surfaces a `chunk_path` panic for non-ASCII ids, the behaviour is
   documented in the spec/tests as a known constraint (no semantic change).

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `happy-dom`'s WebCrypto subtly differs from browser | Round-trip tests are implementation-agnostic; AES-GCM/Argon2 outputs are not hard-coded against browser vectors. If a discrepancy surfaces, switch to `@peculiar/webcrypto`. |
| `fixLibsodiumImport` plugin breaks under Vitest | Plugin runs at Vite config time, identical for `vitest dev`; verified by acceptance criterion 1. |
| msw fails to intercept `fetch` under happy-dom | msw supports jsdom/happy-dom via `setupServer`; verified by acceptance criterion 1. If it fails, fall back to `vi.stubGlobal("fetch", ...)`. |
| `std::env::set_var` in config tests races with other tests | Run with `--test-threads=1`; documented in command table. |
| `sqlx::migrate!` relative path breaks under `cargo test` | Macro embeds migrations at compile time; path resolves at compile time relative to `server/Cargo.toml`. Verified by acceptance criterion 2. |
| proptest surfaces a real `chunk_path` panic | Treated as a real bug only if it reproduces for ASCII/UUID inputs (the actual contract). |
