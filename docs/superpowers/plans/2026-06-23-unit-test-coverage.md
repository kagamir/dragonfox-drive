# Unit Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add unit + targeted-integration test coverage (approach B: conventional + property-based) for all currently-implemented logic in `server/` and `web/`.

**Architecture:** Vitest + happy-dom + msw + fast-check on the frontend; built-in `#[test]`/`#[tokio::test]` + tempfile + proptest + pretty_assertions on the backend. Tests are co-located (`*.test.ts`) or inline (`mod tests`). Real dependencies wherever cheap (tempfile FS, file-backed SQLite); mocks only for browser APIs (fetch via msw, localforage via in-memory map).

**Tech Stack:** Rust (axum, sqlx, sqlite, jsonwebtoken, argon2) · TypeScript (Vue 3, Vite, Vitest, fast-check, msw, happy-dom, libsodium-wrappers-sumo)

## Global Constraints

- **Do NOT change business logic.** Sole exception: Task 6 adds one `export` keyword to `web/src/workers/crypto.worker.ts`.
- **Do NOT remove the `fixLibsodiumImport` plugin** in `web/vite.config.ts` (AGENTS.md: production build breaks without it).
- **Preserve `web/tsconfig.app.json`'s `exclude`** of test setup dirs; test files use explicit `import { describe, it, expect } from "vitest"` so they stay type-clean under `vue-tsc --noEmit` without adding `vitest/globals` to types.
- **Frontend commands run with** `npm ... --prefix web`. **Backend commands run with** `cargo ... --manifest-path server\Cargo.toml`.
- **Env-mutating backend tests** (`config.rs` `Settings::load`) require `--test-threads=1`.
- **Property tests (`[property]`)** run on cheap functions only. Argon2id-based functions (`derivePasswordKey`, `deriveAuthVerifier`) are example-tested because 64 MiB memory cost makes 100-iteration property tests impractical.
- All test files must pass `npm run typecheck --prefix web` and `cargo check --manifest-path server\Cargo.toml`.

---

## File Structure

**Frontend (new/modified):**
```
web/
├── package.json                      # mod: +5 devDeps, +3 scripts
├── vite.config.ts                    # mod: +test: {...} field
└── src/
    ├── __tests__/                    # matches tsconfig.app.json exclude
    │   ├── setup.ts                  # new: initCrypto warm-up + localforage mock + msw server
    │   ├── fc-arbitrary.ts           # new: shared fast-check helpers
    │   └── smoke.test.ts             # new: env validation
    ├── crypto/
    │   ├── kdf.test.ts               # new
    │   ├── symmetric.test.ts         # new
    │   └── keys.test.ts              # new
    ├── api/
    │   └── client.test.ts            # new
    └── workers/
        ├── crypto.worker.ts          # mod: +1 line (`export const api`)
        └── crypto.worker.test.ts     # new
```

**Backend (all inline `mod tests`, no new files):**
```
server/
├── Cargo.toml                        # mod: +[dev-dependencies]
└── src/{auth,storage,config,error,db}/...
```

Each task below produces self-contained, independently-testable changes.

---

## Task 1: Frontend test infrastructure

**Files:**
- Modify: `web/package.json` (devDeps + scripts)
- Modify: `web/vite.config.ts` (add `test:` field)
- Create: `web/src/__tests__/setup.ts`
- Create: `web/src/__tests__/fc-arbitrary.ts`
- Create: `web/src/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: `setup.ts` exports `mswServer` (used by Task 5). `fc-arbitrary.ts` exports `bytes(min, max)` and `shortString(maxLength)` (used by Tasks 2-4).

- [ ] **Step 1: Install dev dependencies**

Run:
```
npm install --prefix web --save-dev vitest@^2 happy-dom@^15 @vue/test-utils@^2 fast-check@^3 msw@^2
```
Expected: `web/package.json` gains five entries under `devDependencies`; `web/package-lock.json` updates.

- [ ] **Step 2: Add test scripts to `web/package.json`**

In the `"scripts"` object, after `"typecheck": "vue-tsc --noEmit -p tsconfig.app.json"`, add:
```json
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
```

- [ ] **Step 3: Add `test:` field to `web/vite.config.ts`**

At the very top of the file, add a triple-slash directive so TS knows about the `test` key:
```ts
/// <reference types="vitest/config" />
```
Then inside `defineConfig({...})`, as the last field after `build: { ... }`, add:
```ts
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.test.ts"],
  },
```

- [ ] **Step 4: Create `web/src/__tests__/fc-arbitrary.ts`**

```ts
import fc from "fast-check";

/** Random byte array of length between min and max (inclusive). */
export const bytes = (min: number, max: number): fc.Arbitrary<number[]> =>
  fc.array(fc.integer({ min: 0, max: 255 }), { minLength: min, maxLength: max });

/** Random non-empty string up to `maxLength` characters. */
export const shortString = (maxLength = 32): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength });
```

- [ ] **Step 5: Create `web/src/__tests__/setup.ts`**

```ts
import { beforeAll, afterEach, afterAll, vi } from "vitest";
import { setupServer } from "msw/node";

import { initCrypto } from "@/crypto";

// --- libsodium WASM: load once for the whole suite ---------------------------
beforeAll(async () => {
  await initCrypto();
}, 30_000);

// --- localforage mock: in-memory Map per (name, storeName) -------------------
vi.mock("localforage", () => {
  const stores = new Map<string, Map<string, unknown>>();
  const factory = (opts: { name?: string; storeName?: string }) => {
    const key = `${opts.name ?? "default"}/${opts.storeName ?? "default"}`;
    let store = stores.get(key);
    if (!store) {
      store = new Map();
      stores.set(key, store);
    }
    return {
      getItem: async (k: string) => (store!.has(k) ? store!.get(k) : null),
      setItem: async (k: string, v: unknown) => {
        store!.set(k, v);
      },
      removeItem: async (k: string) => {
        store!.delete(k);
      },
    };
  };
  return {
    default: { createInstance: factory },
    createInstance: factory,
  };
});

// --- msw: intercept fetch for api/client tests -------------------------------
export const mswServer = setupServer();

beforeAll(() => mswServer.listen({ onUnhandledRequest: "warn" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
```

- [ ] **Step 6: Create `web/src/__tests__/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

import { sodium } from "@/crypto";
import { randomBytes } from "@/crypto/kdf";

describe("test environment smoke", () => {
  it("loaded libsodium WASM", () => {
    expect(typeof sodium.crypto_pwhash).toBe("function");
  });

  it("WebCrypto subtle.digest works under happy-dom", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("abc") as BufferSource,
    );
    expect(new Uint8Array(digest).length).toBe(32);
  });

  it("crypto.getRandomValues works", () => {
    const a = randomBytes(16);
    const b = randomBytes(16);
    expect(a.length).toBe(16);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});
```

- [ ] **Step 7: Run the smoke test**

Run: `npm test --prefix web`
Expected: 3 tests pass. If libsodium fails to load, verify the `fixLibsodiumImport` plugin still runs under vitest (it should — vitest uses the same vite config pipeline). If happy-dom's WebCrypto is missing/broken, stop and apply the fallback: install `@peculiar/webcrypto` and assign `globalThis.crypto` in setup.ts before the `beforeAll`.

- [ ] **Step 8: Commit**

```
git add web/package.json web/package-lock.json web/vite.config.ts web/src/__tests__
git commit -m "test(web): add vitest infrastructure (happy-dom, msw, fast-check, localforage mock)"
```

---

## Task 2: `crypto/symmetric.ts` tests

**Files:**
- Create: `web/src/crypto/symmetric.test.ts`

**Interfaces:**
- Consumes: `chunkIv`, `encryptChunk`, `decryptChunk`, `encrypt`, `decrypt`, `CONSTANTS` from `./symmetric`; `randomBytes` from `./kdf`; `bytes` from `@/__tests__/fc-arbitrary`.

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { bytes } from "@/__tests__/fc-arbitrary";
import { randomBytes } from "./kdf";
import {
  chunkIv,
  encryptChunk,
  decryptChunk,
  encrypt,
  decrypt,
  CONSTANTS,
} from "./symmetric";

describe("chunkIv", () => {
  it("throws when ivBase is not 12 bytes", () => {
    expect(() => chunkIv(new Uint8Array(11), 0)).toThrow();
    expect(() => chunkIv(new Uint8Array(13), 0)).toThrow();
  });

  it("returns the base unchanged when index is 0", () => {
    const base = randomBytes(12);
    expect(Array.from(chunkIv(base, 0))).toEqual(Array.from(base));
  });

  it("does not mutate the input ivBase", () => {
    const base = randomBytes(12);
    const snapshot = Array.from(base);
    chunkIv(base, 42);
    expect(Array.from(base)).toEqual(snapshot);
  });

  it("produces different IVs for different indices", () => {
    const base = randomBytes(12);
    expect(Array.from(chunkIv(base, 1))).not.toEqual(Array.from(chunkIv(base, 2)));
  });

  it("is deterministic for the same (base, index)", () => {
    const base = randomBytes(12);
    expect(Array.from(chunkIv(base, 5))).toEqual(Array.from(chunkIv(base, 5)));
  });
});

describe("chunkIv [property]", () => {
  it("index 0 equals base for random bases", () => {
    fc.assert(
      fc.property(bytes(12, 12), (b) => {
        const base = new Uint8Array(b);
        const iv = chunkIv(base, 0);
        return Array.from(iv).every((v, i) => v === b[i]);
      }),
      { numRuns: 100 },
    );
  });

  it("is deterministic across calls for random (base, index)", () => {
    fc.assert(
      fc.property(
        bytes(12, 12),
        fc.integer({ min: 0, max: 1 << 24 }),
        (b, idx) => {
          const base = new Uint8Array(b);
          return (
            Array.from(chunkIv(base, idx)).join() ===
            Array.from(chunkIv(base, idx)).join()
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("encryptChunk / decryptChunk", () => {
  it("round-trips plaintext", async () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const pt = new TextEncoder().encode("hello world");
    const ct = await encryptChunk(key, iv, pt);
    expect(Array.from(await decryptChunk(key, iv, ct))).toEqual(Array.from(pt));
  });

  it("throws when ciphertext is tampered", async () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const ct = await encryptChunk(key, iv, new TextEncoder().encode("hello"));
    ct[0] ^= 0xff;
    await expect(decryptChunk(key, iv, ct)).rejects.toThrow();
  });

  it("throws when AAD mismatches", async () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const ct = await encryptChunk(
      key,
      iv,
      new TextEncoder().encode("hello"),
      new TextEncoder().encode("v1"),
    );
    await expect(
      decryptChunk(key, iv, ct, new TextEncoder().encode("v2")),
    ).rejects.toThrow();
  });

  it("produces different ciphertexts for different IVs", async () => {
    const key = randomBytes(32);
    const pt = new TextEncoder().encode("hello");
    expect(Array.from(await encryptChunk(key, randomBytes(12), pt))).not.toEqual(
      Array.from(await encryptChunk(key, randomBytes(12), pt)),
    );
  });
});

describe("encryptChunk / decryptChunk [property]", () => {
  it("round-trips for random plaintext / AAD", () => {
    return fc.assert(
      fc.asyncProperty(
        bytes(1, 4096),
        bytes(0, 64),
        async (plainBytes, aadBytes) => {
          const key = randomBytes(32);
          const iv = randomBytes(12);
          const pt = new Uint8Array(plainBytes);
          const aad = new Uint8Array(aadBytes);
          const ct = await encryptChunk(key, iv, pt, aad);
          const recovered = await decryptChunk(key, iv, ct, aad);
          return Array.from(recovered).every((v, i) => v === plainBytes[i]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("encrypt / decrypt (random IV)", () => {
  it("round-trips", async () => {
    const key = randomBytes(32);
    const pt = new TextEncoder().encode("blob");
    const { ciphertext, iv } = await encrypt(key, pt);
    expect(Array.from(await decrypt(key, ciphertext, iv))).toEqual(Array.from(pt));
  });

  it("uses a fresh random IV per call", async () => {
    const key = randomBytes(32);
    const pt = new TextEncoder().encode("blob");
    expect(Array.from((await encrypt(key, pt)).iv)).not.toEqual(
      Array.from((await encrypt(key, pt)).iv),
    );
  });
});

describe("CONSTANTS", () => {
  it("matches the documented values", () => {
    expect(CONSTANTS.IV_BYTES).toBe(12);
    expect(CONSTANTS.TAG_BYTES).toBe(16);
    expect(CONSTANTS.KEY_BYTES).toBe(32);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test --prefix web -- symmetric`
Expected: all tests pass (chunkIv, encrypt/decrypt round-trip, property, CONSTANTS).

- [ ] **Step 3: Commit**

```
git add web/src/crypto/symmetric.test.ts
git commit -m "test(web): cover crypto/symmetric (chunkIv, AES-GCM round-trip + properties)"
```

---

## Task 3: `crypto/kdf.ts` tests

**Files:**
- Create: `web/src/crypto/kdf.test.ts`

**Interfaces:**
- Consumes: `normaliseEmail`, `emailToSalt`, `derivePasswordKey`, `deriveAuthVerifier`, `deriveSubkey`, `randomBytes`, `KEY_BYTES` from `./kdf`; `bytes`, `shortString` from `@/__tests__/fc-arbitrary`.

> Note: `derivePasswordKey` / `deriveAuthVerifier` use Argon2id at 64 MiB — example tests only. `deriveSubkey` (HKDF) and `randomBytes` are cheap → property tests.

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { bytes, shortString } from "@/__tests__/fc-arbitrary";
import {
  normaliseEmail,
  emailToSalt,
  derivePasswordKey,
  deriveAuthVerifier,
  deriveSubkey,
  randomBytes,
  KEY_BYTES,
} from "./kdf";

describe("normaliseEmail", () => {
  it("trims and lowercases", () => {
    expect(normaliseEmail("  Foo@BAR.com ")).toBe("foo@bar.com");
  });
  it("is idempotent", () => {
    const once = normaliseEmail("A@B.c");
    expect(normaliseEmail(once)).toBe(once);
  });
});

describe("emailToSalt", () => {
  it("is deterministic", async () => {
    expect(Array.from(await emailToSalt("foo@bar.com"))).toEqual(
      Array.from(await emailToSalt("foo@bar.com")),
    );
  });
  it("produces 16 bytes", async () => {
    expect((await emailToSalt("foo@bar.com")).length).toBe(16);
  });
  it("differs for different emails", async () => {
    expect(Array.from(await emailToSalt("foo@bar.com"))).not.toEqual(
      Array.from(await emailToSalt("baz@bar.com")),
    );
  });
});

describe("derivePasswordKey", () => {
  it("is deterministic", async () => {
    expect(Array.from(await derivePasswordKey("pw", "foo@bar.com"))).toEqual(
      Array.from(await derivePasswordKey("pw", "foo@bar.com")),
    );
  });
  it("produces 32 bytes", async () => {
    expect((await derivePasswordKey("pw", "foo@bar.com")).length).toBe(KEY_BYTES);
  });
  it("differs for different passwords", async () => {
    expect(Array.from(await derivePasswordKey("pw1", "foo@bar.com"))).not.toEqual(
      Array.from(await derivePasswordKey("pw2", "foo@bar.com")),
    );
  });
  it("differs for different emails", async () => {
    expect(Array.from(await derivePasswordKey("pw", "foo@bar.com"))).not.toEqual(
      Array.from(await derivePasswordKey("pw", "baz@bar.com")),
    );
  });
});

describe("deriveAuthVerifier", () => {
  it("is deterministic for the same inputs", () => {
    const key = randomBytes(32);
    const salt = randomBytes(16);
    expect(Array.from(deriveAuthVerifier(key, salt))).toEqual(
      Array.from(deriveAuthVerifier(key, salt)),
    );
  });
  it("produces 32 bytes", () => {
    expect(deriveAuthVerifier(randomBytes(32), randomBytes(16)).length).toBe(KEY_BYTES);
  });
  it("differs for different server salts", () => {
    const key = randomBytes(32);
    expect(Array.from(deriveAuthVerifier(key, randomBytes(16)))).not.toEqual(
      Array.from(deriveAuthVerifier(key, randomBytes(16))),
    );
  });
});

describe("deriveSubkey", () => {
  it("is deterministic", async () => {
    const master = randomBytes(32);
    expect(Array.from(await deriveSubkey(master, "info-a"))).toEqual(
      Array.from(await deriveSubkey(master, "info-a")),
    );
  });
  it("differs for different info strings", async () => {
    const master = randomBytes(32);
    expect(Array.from(await deriveSubkey(master, "info-a"))).not.toEqual(
      Array.from(await deriveSubkey(master, "info-b")),
    );
  });
  it("honours the length argument", async () => {
    const master = randomBytes(32);
    expect((await deriveSubkey(master, "x", 16)).length).toBe(16);
    expect((await deriveSubkey(master, "x", 64)).length).toBe(64);
  });
});

describe("deriveSubkey [property]", () => {
  it("is deterministic for random (master, info)", () => {
    return fc.assert(
      fc.asyncProperty(
        bytes(32, 32),
        shortString(32),
        async (masterBytes, info) => {
          const master = new Uint8Array(masterBytes);
          const a = await deriveSubkey(master, info);
          const b = await deriveSubkey(master, info);
          return Array.from(a).every((v, i) => v === b[i]);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("randomBytes", () => {
  it("returns the requested length", () => {
    expect(randomBytes(0).length).toBe(0);
    expect(randomBytes(1).length).toBe(1);
    expect(randomBytes(1024).length).toBe(1024);
  });
});

describe("randomBytes [property]", () => {
  it("two consecutive calls are distinct", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1024 }), (n) => {
        const a = randomBytes(n);
        const b = randomBytes(n);
        return Array.from(a).some((v, i) => v !== b[i]);
      }),
      { numRuns: 50 },
    );
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test --prefix web -- kdf`
Expected: all pass. Argon2id tests take ~0.2s each; suite finishes in a few seconds.

- [ ] **Step 3: Commit**

```
git add web/src/crypto/kdf.test.ts
git commit -m "test(web): cover crypto/kdf (normaliseEmail, salts, Argon2id + HKDF properties)"
```

---

## Task 4: `crypto/keys.ts` tests

**Files:**
- Create: `web/src/crypto/keys.test.ts`

**Interfaces:**
- Consumes: `generateMasterKey`, `generateFileKey`, `getOrCreateDeviceKey`, `wrapMasterKey`, `unwrapMasterKey`, `wrapWithPassword`, `unwrapWithPassword`, `persistDeviceWrap`, `loadDeviceWrap`, `clearDeviceWrap` from `./keys`; `bytes` from `@/__tests__/fc-arbitrary`. Uses the global `localforage` mock from `setup.ts`.

> Note: `wrapWithPassword`/`unwrapWithPassword` invoke Argon2id → example tests only. `wrapMasterKey` (AES-GCM) and `generateMasterKey`/`generateFileKey` (randomBytes) are cheap → property tests.

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";

import { bytes } from "@/__tests__/fc-arbitrary";
import {
  generateMasterKey,
  generateFileKey,
  getOrCreateDeviceKey,
  wrapMasterKey,
  unwrapMasterKey,
  wrapWithPassword,
  unwrapWithPassword,
  persistDeviceWrap,
  loadDeviceWrap,
  clearDeviceWrap,
} from "./keys";

describe("generateMasterKey / generateFileKey", () => {
  it("produce 32-byte keys", () => {
    expect(generateMasterKey().length).toBe(32);
    expect(generateFileKey().length).toBe(32);
  });
});

describe("generateMasterKey [property]", () => {
  it("two consecutive calls are distinct", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const a = generateMasterKey();
        const b = generateMasterKey();
        return Array.from(a).some((v, i) => v !== b[i]);
      }),
      { numRuns: 32 },
    );
  });
});

describe("wrapMasterKey / unwrapMasterKey", () => {
  it("round-trip", async () => {
    const master = generateMasterKey();
    const wrapper = generateMasterKey();
    const wrapped = await wrapMasterKey(master, wrapper);
    expect(Array.from(await unwrapMasterKey(wrapped, wrapper))).toEqual(
      Array.from(master),
    );
  });

  it("throws when unwrapped with the wrong key", async () => {
    const wrapped = await wrapMasterKey(generateMasterKey(), generateMasterKey());
    await expect(
      unwrapMasterKey(wrapped, generateMasterKey()),
    ).rejects.toThrow();
  });

  it("does not mutate the master key input", async () => {
    const master = generateMasterKey();
    const snapshot = Array.from(master);
    await wrapMasterKey(master, generateMasterKey());
    expect(Array.from(master)).toEqual(snapshot);
  });
});

describe("wrapMasterKey [property]", () => {
  it("round-trips for random master/wrapper", () => {
    return fc.assert(
      fc.asyncProperty(bytes(32, 32), bytes(32, 32), async (m, w) => {
        const master = new Uint8Array(m);
        const wrapper = new Uint8Array(w);
        const wrapped = await wrapMasterKey(master, wrapper);
        const recovered = await unwrapMasterKey(wrapped, wrapper);
        return Array.from(recovered).every((v, i) => v === m[i]);
      }),
      { numRuns: 50 },
    );
  });
});

describe("wrapWithPassword / unwrapWithPassword", () => {
  it("round-trip", async () => {
    const master = generateMasterKey();
    const wrapped = await wrapWithPassword(master, "correct horse", "u@x.com");
    expect(
      Array.from(await unwrapWithPassword(wrapped, "correct horse", "u@x.com")),
    ).toEqual(Array.from(master));
  });

  it("throws with the wrong password", async () => {
    const wrapped = await wrapWithPassword(
      generateMasterKey(),
      "right",
      "u@x.com",
    );
    await expect(
      unwrapWithPassword(wrapped, "wrong", "u@x.com"),
    ).rejects.toThrow();
  });
});

describe("device-wrap persistence (localforage mock)", () => {
  // setup.ts mock isolates each store by (name, storeName); keys.ts uses
  // name:"dragonfox-drive", storeName:"keys". beforeEach resets the store.
  beforeEach(async () => {
    await clearDeviceWrap();
  });

  it("getOrCreateDeviceKey persists across calls", async () => {
    const first = await getOrCreateDeviceKey();
    expect(Array.from(await getOrCreateDeviceKey())).toEqual(Array.from(first));
  });

  it("persistDeviceWrap / loadDeviceWrap round-trip", async () => {
    const wrap = await wrapMasterKey(generateMasterKey(), generateMasterKey());
    await persistDeviceWrap("user-123", wrap);
    const loaded = await loadDeviceWrap();
    expect(loaded).not.toBeNull();
    expect(loaded!.userId).toBe("user-123");
    expect(Array.from(loaded!.wrap.ciphertext)).toEqual(
      Array.from(wrap.ciphertext),
    );
  });

  it("clearDeviceWrap makes loadDeviceWrap return null", async () => {
    const wrap = await wrapMasterKey(generateMasterKey(), generateMasterKey());
    await persistDeviceWrap("u", wrap);
    await clearDeviceWrap();
    expect(await loadDeviceWrap()).toBeNull();
  });

  it("loadDeviceWrap returns null when nothing was persisted", async () => {
    expect(await loadDeviceWrap()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test --prefix web -- keys`
Expected: all pass. The localforage mock isolates each store by `(name, storeName)`; all `keys.ts` calls use the same store, so `beforeEach(clearDeviceWrap)` resets state between tests.

- [ ] **Step 3: Commit**

```
git add web/src/crypto/keys.test.ts
git commit -m "test(web): cover crypto/keys (wrap/unwrap + properties, device-wrap persistence)"
```

---

## Task 5: `api/client.ts` tests

**Files:**
- Create: `web/src/api/client.test.ts`

**Interfaces:**
- Consumes: `request`, `setAuthToken`, `getAuthToken`, `ApiError`, `http` from `./client`; `mswServer` from `@/__tests__/setup`; `http`, `HttpResponse` from `msw`.

> Risk note: msw/node must intercept the `fetch` global under happy-dom. If `npm test --prefix web -- client` shows requests bypassing msw (real network errors or unhandled warnings for handled routes), fall back to `vi.stubGlobal("fetch", vi.fn())` per-test; the test bodies translate directly (return `{ ok: true, json: async () => ({...}), status: 200, text: async () => "..." }`-shaped responses). The msw approach is primary.

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";

import { mswServer } from "@/__tests__/setup";
import {
  request,
  setAuthToken,
  getAuthToken,
  ApiError,
  http as httpApi,
} from "./client";

describe("auth token accessors", () => {
  beforeEach(() => setAuthToken(null));

  it("round-trips a token", () => {
    setAuthToken("abc");
    expect(getAuthToken()).toBe("abc");
  });

  it("clears with null", () => {
    setAuthToken("xyz");
    setAuthToken(null);
    expect(getAuthToken()).toBeNull();
  });
});

describe("request", () => {
  beforeEach(() => setAuthToken(null));

  it("parses a JSON success response", async () => {
    mswServer.use(
      http.get("/api/x", () => HttpResponse.json({ ok: true, n: 42 })),
    );
    const res = await request<{ ok: boolean; n: number }>("/api/x");
    expect(res).toEqual({ ok: true, n: 42 });
  });

  it("throws ApiError with status + body on an error envelope", async () => {
    mswServer.use(
      http.post("/api/fail", () =>
        HttpResponse.json({ error: "bad input" }, { status: 400 }),
      ),
    );
    try {
      await request("/api/fail", { method: "POST", body: {} });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toBe("bad input");
    }
  });

  it("returns undefined for HTTP 204", async () => {
    mswServer.use(
      http.delete("/api/n", () => new HttpResponse(null, { status: 204 })),
    );
    expect(await request("/api/n", { method: "DELETE" })).toBeUndefined();
  });

  it("throws ApiError with status 0 on a network failure", async () => {
    mswServer.use(
      http.get("/api/net", () => {
        throw new Error("network down");
      }),
    );
    await expect(request("/api/net")).rejects.toBeInstanceOf(ApiError);
    try {
      await request("/api/net");
    } catch (e) {
      expect((e as ApiError).status).toBe(0);
    }
  });

  it("returns the raw Response when rawResponse is set", async () => {
    mswServer.use(
      http.get("/api/blob", () => new HttpResponse("rawbody", { status: 200 })),
    );
    const res = await request<Response>("/api/blob", { rawResponse: true });
    expect(res).toBeInstanceOf(Response);
    expect(await res.text()).toBe("rawbody");
  });

  it("passes rawBody through untouched", async () => {
    let captured = "";
    mswServer.use(
      http.put("/api/raw", async ({ request }) => {
        captured = await request.text();
        return HttpResponse.json({ ok: true });
      }),
    );
    await request("/api/raw", { method: "PUT", rawBody: "literal-body" });
    expect(captured).toBe("literal-body");
  });

  it("injects Authorization header when token is set", async () => {
    setAuthToken("TKN");
    let captured: string | null = null;
    mswServer.use(
      http.get("/api/authed", ({ request }) => {
        captured = request.headers.get("authorization");
        return HttpResponse.json({});
      }),
    );
    await request("/api/authed");
    expect(captured).toBe("Bearer TKN");
  });

  it("omits Authorization header when token is null", async () => {
    setAuthToken(null);
    let captured: string | null = "unset";
    mswServer.use(
      http.get("/api/noauth", ({ request }) => {
        captured = request.headers.get("authorization");
        return HttpResponse.json({});
      }),
    );
    await request("/api/noauth");
    expect(captured).toBeNull();
  });

  it("aborts when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      request("/api/whatever", { signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("http method helpers", () => {
  beforeEach(() => setAuthToken(null));

  it("maps get/post/put/delete to the right methods", async () => {
    let last = "";
    mswServer.use(
      http.all("/api/m", ({ request }) => {
        last = request.method;
        return HttpResponse.json({});
      }),
    );
    await httpApi.get("/api/m");
    expect(last).toBe("GET");
    await httpApi.post("/api/m", {});
    expect(last).toBe("POST");
    await httpApi.put("/api/m", {});
    expect(last).toBe("PUT");
    await httpApi.delete("/api/m");
    expect(last).toBe("DELETE");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test --prefix web -- client`
Expected: all 12 tests pass. If any request bypasses msw (status 0 unexpectedly, or unhandled-request warnings for handled routes), apply the fallback documented above.

- [ ] **Step 3: Commit**

```
git add web/src/api/client.test.ts
git commit -m "test(web): cover api/client (token, success/error/204/raw, auth header, abort)"
```

---

## Task 6: `workers/crypto.worker.ts` tests (TDD: add `export`)

**Files:**
- Modify: `web/src/workers/crypto.worker.ts` (1-line change)
- Create: `web/src/workers/crypto.worker.test.ts`

**Interfaces:**
- Produces: `web/src/workers/crypto.worker.ts` exports `api` (the object Comlink exposes). `Comlink.expose(api)` stays put.

- [ ] **Step 1: Write the failing test**

`web/src/workers/crypto.worker.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";

import { api } from "./crypto.worker";
import { randomBytes } from "@/crypto/kdf";

describe("crypto worker api", () => {
  beforeAll(async () => {
    await api.init();
  });

  it("derives a deterministic 32-byte password key", async () => {
    const a = await api.derivePasswordKey("pw", "u@x.com");
    const b = await api.derivePasswordKey("pw", "u@x.com");
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(32);
  });

  it("produces a 16-byte server salt (crypto_pwhash_SALTBYTES)", () => {
    expect(api.randomServerSalt().length).toBe(16);
  });

  it("generates a 32-byte master key", () => {
    expect(api.newMasterKey().length).toBe(32);
  });

  it("round-trips encrypt/decrypt chunk via ivBase + index", async () => {
    const key = api.newMasterKey();
    const ivBase = randomBytes(12);
    const pt = new TextEncoder().encode("worker payload");
    const ct = await api.encryptChunk(key, ivBase, 0, pt);
    expect(Array.from(await api.decryptChunk(key, ivBase, 0, ct))).toEqual(
      Array.from(pt),
    );
  });

  it("round-trips wrap/unwrap master key", async () => {
    const master = api.newMasterKey();
    const wrapper = api.newMasterKey();
    const wrapped = await api.wrap(master, wrapper);
    expect(Array.from(await api.unwrap(wrapped, wrapper))).toEqual(
      Array.from(master),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix web -- crypto.worker`
Expected: FAIL with a compile error — `api` is not exported from `./crypto.worker` (`Module '"./crypto.worker"' has no exported member 'api'.`).

- [ ] **Step 3: Add the `export` keyword**

In `web/src/workers/crypto.worker.ts`, change:
```ts
const api = {
```
to:
```ts
export const api = {
```
Leave `Comlink.expose(api);` (and `export type CryptoApi = typeof api;`) untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix web -- crypto.worker`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```
git add web/src/workers/crypto.worker.ts web/src/workers/crypto.worker.test.ts
git commit -m "test(web): cover crypto worker api; export api object for direct testing"
```

---

## Task 7: Backend dev-dependencies

**Files:**
- Modify: `server/Cargo.toml` (add `[dev-dependencies]`)

- [ ] **Step 1: Add dev-dependencies**

Append to `server/Cargo.toml` (after the `[profile.release]` block):
```toml

[dev-dependencies]
tempfile = "3"
proptest = "1"
pretty_assertions = "1"
```

- [ ] **Step 2: Verify it builds**

Run: `cargo check --manifest-path server\Cargo.toml --tests`
Expected: compiles (downloads the new crates on first run). Requires network access on the first run.

- [ ] **Step 3: Commit**

```
git add server/Cargo.toml
git commit -m "build(server): add dev-dependencies (tempfile, proptest, pretty_assertions)"
```

---

## Task 8: `error.rs` tests

**Files:**
- Modify: `server/src/error.rs` (append `#[cfg(test)] mod tests`)

- [ ] **Step 1: Append the test module to `server/src/error.rs`**

```rust

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use sqlx::Error as SqlxError;

    #[test]
    fn bad_request_maps_to_400() {
        let resp = ApiError::BadRequest("nope".into()).into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn unauthorized_maps_to_401() {
        assert_eq!(
            ApiError::Unauthorized.into_response().status(),
            StatusCode::UNAUTHORIZED,
        );
    }

    #[test]
    fn forbidden_maps_to_403() {
        assert_eq!(
            ApiError::Forbidden.into_response().status(),
            StatusCode::FORBIDDEN,
        );
    }

    #[test]
    fn not_found_maps_to_404() {
        assert_eq!(
            ApiError::NotFound.into_response().status(),
            StatusCode::NOT_FOUND,
        );
    }

    #[test]
    fn conflict_maps_to_409() {
        assert_eq!(
            ApiError::Conflict("dup".into()).into_response().status(),
            StatusCode::CONFLICT,
        );
    }

    #[test]
    fn payload_too_large_maps_to_413() {
        assert_eq!(
            ApiError::PayloadTooLarge.into_response().status(),
            StatusCode::PAYLOAD_TOO_LARGE,
        );
    }

    #[test]
    fn internal_maps_to_500() {
        assert_eq!(
            ApiError::Internal(anyhow::anyhow!("boom")).into_response().status(),
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    #[tokio::test]
    async fn internal_body_does_not_leak_detail() {
        let resp =
            ApiError::Internal(anyhow::anyhow!("secret detail")).into_response();
        let bytes = to_bytes(resp.into_body(), 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "internal server error");
        assert!(
            !bytes.windows(6).any(|w| w == b"secret"),
            "internal detail must not appear in the response body"
        );
    }

    #[tokio::test]
    async fn bad_request_body_contains_the_message() {
        let resp =
            ApiError::BadRequest("a specific reason".into()).into_response();
        let bytes = to_bytes(resp.into_body(), 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "invalid request: a specific reason");
    }

    #[test]
    fn sqlx_row_not_found_maps_to_api_not_found() {
        let err: ApiError = SqlxError::RowNotFound.into();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[test]
    fn sqlx_other_error_maps_to_internal() {
        let err: ApiError = SqlxError::PoolClosed.into();
        assert!(matches!(err, ApiError::Internal(_)));
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test --manifest-path server\Cargo.toml error::`
Expected: all tests pass. (No `--lib`: this crate is `[[bin]]`-only.)

- [ ] **Step 3: Commit**

```
git add server/src/error.rs
git commit -m "test(server): cover error::ApiError status mapping + IntoResponse body"
```

---

## Task 9: `config.rs` tests

**Files:**
- Modify: `server/src/config.rs` (append `#[cfg(test)] mod tests`)

> Note: `Settings::load()` reads `config.toml` from CWD and `DRAGONFOX__*` env vars. The load test mutates process CWD and env, so run the **entire suite single-threaded** when this test is included: `cargo test --manifest-path server\Cargo.toml -- --test-threads=1`. A `Drop` guard restores CWD and removes the env var even on panic.

- [ ] **Step 1: Append the test module to `server/src/config.rs`**

```rust

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_documented_values() {
        let s = Settings::default();
        assert_eq!(s.server.host, "0.0.0.0");
        assert_eq!(s.server.port, 8080);
        assert_eq!(s.storage.data_dir, std::path::PathBuf::from("./data"));
        assert_eq!(s.database.url, "sqlite://./data/dragonfox.db?mode=rwc");
        assert_eq!(s.jwt.access_ttl_seconds, 900);
        assert_eq!(s.jwt.refresh_ttl_seconds, 2_592_000);
        assert_eq!(s.limits.max_upload_bytes, 0);
        assert_eq!(s.limits.max_chunk_bytes, 8 * 1024 * 1024);
        assert_eq!(s.limits.rate_limit_per_minute, 600);
    }

    #[test]
    fn jwt_default_secret_is_the_documented_placeholder() {
        assert_eq!(
            Settings::default().jwt.secret,
            "change-me-to-a-long-random-secret-in-production",
        );
    }

    /// WARNING: mutates process CWD and env. Run the suite with --test-threads=1.
    #[test]
    fn load_merges_toml_file_and_env_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let original_cwd = std::env::current_dir().unwrap();

        struct Restore {
            cwd: std::path::PathBuf,
        }
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = std::env::set_current_dir(&self.cwd);
                std::env::remove_var("DRAGONFOX__SERVER__HOST");
            }
        }
        let _guard = Restore {
            cwd: original_cwd.clone(),
        };

        std::fs::write(
            dir.path().join("config.toml"),
            "[server]\nport = 9999\nhost = \"0.0.0.0\"\n",
        )
        .unwrap();
        std::env::set_current_dir(dir.path()).unwrap();
        std::env::set_var("DRAGONFOX__SERVER__HOST", "127.0.0.1");

        let settings = Settings::load().unwrap();

        assert_eq!(settings.server.port, 9999);
        assert_eq!(settings.server.host, "127.0.0.1");
    }
}
```

- [ ] **Step 2: Run tests (single-threaded)**

Run: `cargo test --manifest-path server\Cargo.toml config:: -- --test-threads=1`
Expected: all 3 tests pass.

- [ ] **Step 3: Commit**

```
git add server/src/config.rs
git commit -m "test(server): cover config defaults + Settings::load file/env merge"
```

---

## Task 10: `auth/mod.rs` tests

**Files:**
- Modify: `server/src/auth/mod.rs` (append `#[cfg(test)] mod tests`)

> Note: `jsonwebtoken`'s default `Validation` has 60s leeway. The expired-token test uses `exp = now - 300s` to clear the leeway window.

- [ ] **Step 1: Append the test module to `server/src/auth/mod.rs`**

```rust

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;
    use crate::db;
    use crate::state::AppState;
    use axum::extract::FromRequestParts;
    use axum::http::Request;
    use std::sync::Arc;

    async fn test_state() -> AppState {
        let mut settings = Settings::default();
        settings.jwt.secret = "test-secret".into();
        let pool = db::connect("sqlite::memory:").await.unwrap();
        AppState::new(Arc::new(settings), pool)
    }

    #[tokio::test]
    async fn issue_and_verify_round_trip() {
        let state = test_state().await;
        let pair = issue_token_pair(&state, "user-1", Some("dev-1")).unwrap();
        let claims = verify_access_token(&state, &pair.access_token).unwrap();
        assert_eq!(claims.sub, "user-1");
        assert_eq!(claims.dev.as_deref(), Some("dev-1"));
    }

    #[tokio::test]
    async fn refresh_token_has_later_expiry_than_access() {
        let state = test_state().await;
        let pair = issue_token_pair(&state, "u", None).unwrap();
        assert_ne!(pair.access_token, pair.refresh_token);
        let access = verify_access_token(&state, &pair.access_token).unwrap();
        let refresh = verify_access_token(&state, &pair.refresh_token).unwrap();
        assert!(refresh.exp > access.exp, "refresh must outlive access");
    }

    #[tokio::test]
    async fn verify_rejects_token_signed_with_a_different_secret() {
        let state = test_state().await;
        let pair = issue_token_pair(&state, "u", None).unwrap();
        let mut other_state = test_state().await;
        Arc::get_mut(&mut other_state.settings)
            .unwrap()
            .jwt
            .secret = "different-secret".into();
        match verify_access_token(&other_state, &pair.access_token) {
            Err(ApiError::Unauthorized) => {}
            other => panic!("expected Unauthorized, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn verify_rejects_malformed_token() {
        let state = test_state().await;
        assert!(matches!(
            verify_access_token(&state, "not.a.jwt"),
            Err(ApiError::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn verify_rejects_expired_token() {
        let state = test_state().await;
        let expired = AccessClaims {
            sub: "u".into(),
            dev: None,
            exp: (Utc::now() - Duration::seconds(300)).timestamp(),
        };
        let encoding = EncodingKey::from_secret(b"test-secret");
        let token = encode(&Header::default(), &expired, &encoding).unwrap();
        assert!(matches!(
            verify_access_token(&state, &token),
            Err(ApiError::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn auth_user_extractor_accepts_a_valid_bearer_token() {
        let state = test_state().await;
        let pair = issue_token_pair(&state, "user-x", Some("dev-x")).unwrap();
        let req = Request::builder()
            .header("authorization", format!("Bearer {}", pair.access_token))
            .body::<String>(String::new())
            .unwrap();
        let (mut parts, _body) = req.into_parts();
        let user = AuthUser::from_request_parts(&mut parts, &state)
            .await
            .unwrap();
        assert_eq!(user.user_id, "user-x");
        assert_eq!(user.device_id.as_deref(), Some("dev-x"));
    }

    #[tokio::test]
    async fn auth_user_extractor_rejects_missing_header() {
        let state = test_state().await;
        let req = Request::<String>::default();
        let (mut parts, _body) = req.into_parts();
        assert!(matches!(
            AuthUser::from_request_parts(&mut parts, &state).await,
            Err(ApiError::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn auth_user_extractor_rejects_non_bearer_scheme() {
        let state = test_state().await;
        let req = Request::builder()
            .header("authorization", "Basic dXNlcjpwdw==")
            .body::<String>(String::new())
            .unwrap();
        let (mut parts, _body) = req.into_parts();
        assert!(matches!(
            AuthUser::from_request_parts(&mut parts, &state).await,
            Err(ApiError::Unauthorized)
        ));
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test --manifest-path server\Cargo.toml auth::`
Expected: all 8 tests pass.

- [ ] **Step 3: Commit**

```
git add server/src/auth/mod.rs
git commit -m "test(server): cover auth (JWT issue/verify round-trip + failure modes, AuthUser extractor)"
```

---

## Task 11: `storage/mod.rs` tests

**Files:**
- Modify: `server/src/storage/mod.rs` (append `#[cfg(test)] mod tests`)

- [ ] **Step 1: Append the test module to `server/src/storage/mod.rs`**

```rust

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;
    use crate::db;
    use crate::state::AppState;
    use proptest::prelude::*;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    async fn test_state(dir: &Path) -> AppState {
        let mut settings = Settings::default();
        settings.storage.data_dir = dir.to_path_buf();
        let pool = db::connect("sqlite::memory:").await.unwrap();
        AppState::new(Arc::new(settings), pool)
    }

    fn expected_chunk_path(
        root: &str,
        id: &str,
        shard1: &str,
        shard2: &str,
        idx: u32,
    ) -> PathBuf {
        PathBuf::from(root)
            .join("blobs")
            .join(shard1)
            .join(shard2)
            .join(id)
            .join(format!("chunk_{}", idx))
    }

    #[test]
    fn chunk_path_shards_long_id() {
        let p = chunk_path(Path::new("/data"), "abcdef-1234", 3);
        assert_eq!(
            p,
            expected_chunk_path("/data", "abcdef-1234", "ab", "cd", 3)
        );
    }

    #[test]
    fn chunk_path_uses_short_id_fallbacks() {
        // one-char id: shard1 = "x", shard2 = "00" (len < 4)
        assert_eq!(
            chunk_path(Path::new("/d"), "x", 0),
            expected_chunk_path("/d", "x", "x", "00", 0)
        );
        // three-char id: shard1 = "ab", shard2 = "00" (len < 4)
        assert_eq!(
            chunk_path(Path::new("/d"), "abc", 1),
            expected_chunk_path("/d", "abc", "ab", "00", 1)
        );
    }

    #[tokio::test]
    async fn write_and_read_chunk_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        let payload = b"hello chunks";
        write_chunk(&state, "file-1", 0, payload).await.unwrap();
        assert_eq!(
            read_chunk(&state, "file-1", 0).await.unwrap(),
            Some(payload.to_vec())
        );
    }

    #[tokio::test]
    async fn write_chunk_leaves_no_tmp_file() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        write_chunk(&state, "file-1", 0, b"data").await.unwrap();
        let chunk = chunk_path(&state.settings.storage.data_dir, "file-1", 0);
        let tmp = chunk.with_extension("tmp");
        assert!(!tmp.exists(), "temp file should have been renamed away");
        assert!(chunk.exists());
    }

    #[tokio::test]
    async fn read_chunk_returns_none_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        assert_eq!(read_chunk(&state, "nope", 0).await.unwrap(), None);
    }

    #[tokio::test]
    async fn delete_file_chunks_is_idempotent_and_removes_directory() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        write_chunk(&state, "file-1", 0, b"a").await.unwrap();
        write_chunk(&state, "file-1", 1, b"b").await.unwrap();
        delete_file_chunks(&state, "file-1").await.unwrap();
        delete_file_chunks(&state, "file-1").await.unwrap();
        assert!(read_chunk(&state, "file-1", 0).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_file_chunks_leaves_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        write_chunk(&state, "file-1", 0, b"a").await.unwrap();
        write_chunk(&state, "file-2", 0, b"b").await.unwrap();
        delete_file_chunks(&state, "file-1").await.unwrap();
        assert!(read_chunk(&state, "file-2", 0).await.unwrap().is_some());
    }

    proptest! {
        /// chunk_path is exercised over ASCII ids only — matches the real
        /// contract (callers use UUIDs). Multi-byte ids would panic on the
        /// byte-slice `&file_id[..2]`; that is a documented constraint, not a
        /// bug to fix here.
        #[test]
        fn chunk_path_structure_for_ascii_ids(
            id in "[a-zA-Z0-9]{4,64}",
            idx in 0u32..100_000,
        ) {
            let p = chunk_path(Path::new("/data"), &id, idx);
            let s = p.to_string_lossy().into_owned();
            prop_assert!(s.contains("blobs"));
            prop_assert!(s.contains(&format!("chunk_{}", idx)));
            prop_assert!(s.contains(&id));
        }
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test --manifest-path server\Cargo.toml storage::`
Expected: all tests pass, including the proptest (ASCII-only ids, 256 default cases).

- [ ] **Step 3: Commit**

```
git add server/src/storage/mod.rs
git commit -m "test(server): cover storage (chunk_path sharding + proptest, write/read/delete round-trip)"
```

---

## Task 12: `db/mod.rs` tests

**Files:**
- Modify: `server/src/db/mod.rs` (append `#[cfg(test)] mod tests`)

> Note: `sqlite::memory:` is a *per-connection* database in sqlx, so a pool of N connections has N isolated memory DBs. The migrate test uses a tempfile-backed file DB so all pool connections share the schema. The `PRAGMA foreign_keys = ON` in `migrate()` is per-connection and cannot be cleanly asserted pool-wide; that limitation is out of scope for this round.

- [ ] **Step 1: Append the test module to `server/src/db/mod.rs`**

```rust

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connect_opens_a_working_pool() {
        let pool = connect("sqlite::memory:").await.unwrap();
        let row: (i64,) = sqlx::query_as("SELECT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, 1);
    }

    #[tokio::test]
    async fn migrate_creates_all_expected_tables() {
        let dir = tempfile::tempdir().unwrap();
        // Normalise path separators for the sqlite URL on Windows.
        let db_path = dir
            .path()
            .join("test.db")
            .to_string_lossy()
            .replace('\\', "/");
        let url = format!("sqlite://{}?mode=rwc", db_path);

        let pool = connect(&url).await.unwrap();
        migrate(&pool).await.unwrap();

        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .fetch_all(&pool)
                .await
                .unwrap();
        let names: Vec<String> = rows.into_iter().map(|r| r.0).collect();

        for expected in [
            "devices",
            "file_chunks",
            "files",
            "refresh_tokens",
            "shares",
            "users",
        ] {
            assert!(
                names.contains(&expected.to_string()),
                "missing table {expected}; got {names:?}"
            );
        }
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test --manifest-path server\Cargo.toml db::`
Expected: both tests pass.

- [ ] **Step 3: Commit**

```
git add server/src/db/mod.rs
git commit -m "test(server): cover db (connect pool + migrate creates expected tables)"
```

---

## Final verification

- [ ] **Full frontend suite + typecheck**

```
npm test --prefix web
npm run typecheck --prefix web
```
Expected: all green.

- [ ] **Full backend suite (single-threaded for the config env test) + check**

```
cargo test --manifest-path server\Cargo.toml -- --test-threads=1
cargo check --manifest-path server\Cargo.toml
```
Expected: all green.

- [ ] **No unintended business-logic changes**

`git diff master -- web/src/workers/crypto.worker.ts` should show exactly one line changed (`const api =` → `export const api =`). All other diffs are test files, `package.json`, `vite.config.ts`, and `Cargo.toml` dev-deps.

