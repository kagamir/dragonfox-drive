# P2b: Service-Worker Proxy Video Streaming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream large encrypted videos (up to ~100 GiB) with byte-exact seek via a Service-Worker proxy that decrypts the browser's Range requests on demand — no MSE, no transmuxer, no container-index parsing.

**Architecture:** A SW intercepts `GET /api/stream/:id`, maps the `Range` header to covering 4 MiB chunks by division, fetches the ciphertext chunks via `/api/files/:id/chunks/:idx`, AES-GCM-decrypts them with `crypto.subtle`, caches plaintext in a 256 MiB in-SW LRU, and returns the requested byte slice as a 206 response. The native `<video>` engine drives all seeking/buffering/codecs. All request-handling logic lives in pure, injected-dependency functions so it is unit-testable without a real SW.

**Tech Stack:** TypeScript, Service Worker, WebCrypto (`crypto.subtle` AES-GCM), `vite-plugin-pwa` (injectManifest), vitest + happy-dom, Rust/axum (config bump only).

## Global Constraints

- **Zero-trust unchanged:** the server still never sees plaintext, file names, keys, or the manifest JSON. All decryption is client-side (SW process memory).
- **Chunk model:** 4 MiB plaintext chunks (`SW_CHUNK_SIZE = 4*1024*1024`, MUST equal `FILE_CHUNK_SIZE` in `web/src/crypto/file.ts`); chunk `i` uses IV `chunkIv(iv_base, i)` (XOR the last 4 bytes with the index counter) — identical scheme to `web/src/crypto/symmetric.ts`.
- **SW interception scope:** ONLY `GET /api/stream/:id`. Every other request passes through to the network unmodified. Never intercept `/api/auth/*` or `/api/files/*`.
- **SW crypto:** `crypto.subtle` AES-GCM directly inside the SW (the SW cannot import the worker/app bundle). `chunkIv` is duplicated (small) in `web/src/sw/logic.ts`.
- **Plaintext cache:** memory-only (`LruCache` Map), 256 MiB budget, never persisted to disk/IndexedDB.
- **Keep `fixLibsodiumImport` first** in `web/vite.config.ts` plugins. The SW does NOT import libsodium, so `vite-plugin-pwa` is appended after `vue()`.
- **Frontend tests:** `vi.stubGlobal`/`vi.hoisted`; mock `@/workers/crypto`, `@/api/files`, `@/api/client`, `@/sw/register`; do NOT use msw. Real `crypto.subtle` is available in happy-dom (P2a crypto tests already rely on it).
- **Backend tests:** `cargo test --manifest-path server/Cargo.toml -- --test-threads=1`.
- **Conversation language:** Chinese. Code/comments English.
- **Commits:** frequent, one per task; stage only files you edit; never stage pre-existing dirty files.

---

## File Structure

**New (`web/src/sw/`)**
- `logic.ts` — pure: `chunksCovering`, `sliceRange`, `chunkIv`, `LruCache`, `decryptChunkSubtle`, `parseRange`, `handleStreamRequest`, `matchStreamId`, `applySwMessage`, types `StreamMeta`/`SwMessage`/`ChunkFetcher`.
- `sw.ts` — the SW entry (install/activate/fetch/message glue), built by vite-plugin-pwa → `/sw.js`.
- `register.ts` — `ensureStreamSw()`, `postToSw(msg)`.
- `logic.test.ts` — unit tests for all pure logic.

**Modify**
- `web/vite.config.ts` — add `vite-plugin-pwa` (injectManifest).
- `web/src/main.ts` — best-effort `ensureStreamSw()` on bootstrap.
- `web/src/stores/files.ts` + `web/src/stores/files.test.ts` — route `video/*` to streaming; `closePreview` posts `stop`; `needToken` listener.
- `web/package.json` — devDep `vite-plugin-pwa`.
- `server/src/config.rs` + `server/config.toml` — `max_file_bytes` → 100 GiB.
- `docs/streaming.md`, `docs/api.md`, `README.md`.

---

### Task 1: SW pure math — `chunksCovering`, `sliceRange`, `chunkIv`, `LruCache`

**Files:**
- Create: `web/src/sw/logic.ts`
- Test: `web/src/sw/logic.test.ts`

**Interfaces:**
- Produces: `SW_CHUNK_SIZE` (const), `chunksCovering(start,end,size,chunkSize?)`, `sliceRange(plaintexts,firstIdx,chunkSize,start,end)`, `chunkIv(ivBase,idx)`, `class LruCache { constructor(budget); has; get; set; get size; dropPrefix(prefix) }`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/sw/logic.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  SW_CHUNK_SIZE,
  chunksCovering,
  sliceRange,
  chunkIv,
  LruCache,
} from "./logic";
import { chunkIv as symChunkIv } from "@/crypto/symmetric";

describe("sw logic: pure math", () => {
  it("chunksCovering maps byte range to chunk indices (clamped to size)", () => {
    const size = SW_CHUNK_SIZE * 3 + 10; // 3 full + a tail
    expect(chunksCovering(0, 100, size)).toEqual({ firstIdx: 0, lastIdx: 0 });
    expect(chunksCovering(SW_CHUNK_SIZE - 1, SW_CHUNK_SIZE, size)).toEqual({ firstIdx: 0, lastIdx: 1 });
    expect(chunksCovering(0, size - 1, size)).toEqual({ firstIdx: 0, lastIdx: 3 });
    // end clamps to size-1
    expect(chunksCovering(0, Number.MAX_SAFE_INTEGER, size)).toEqual({ firstIdx: 0, lastIdx: 3 });
    // start clamps
    expect(chunksCovering(size + 50, size + 60, size)).toEqual({ firstIdx: 3, lastIdx: 3 });
  });

  it("sliceRange returns the exact requested bytes across chunks", () => {
    // 3 chunks of sizes 4,4,2; firstIdx=0
    const a = new Uint8Array(Array.from({ length: 4 }, (_, i) => i));        // 0,1,2,3
    const b = new Uint8Array(Array.from({ length: 4 }, (_, i) => 10 + i));   // 10,11,12,13
    const c = new Uint8Array([20, 21]);                                       // 20,21
    // bytes [3..11] absolute => 3,10,11,12,13,20,21,22? no: 3 | 10,11,12,13 | 20,21  => indices 3..5 of chunk ranges
    const out = sliceRange([a, b, c], 0, 4, 3, 5);
    expect(Array.from(out)).toEqual([3, 10, 11]);
    const out2 = sliceRange([a, b, c], 0, 4, 2, 7);
    expect(Array.from(out2)).toEqual([2, 3, 10, 11, 12, 13]);
    // tail chunk partial
    const out3 = sliceRange([a, b, c], 0, 4, 7, 9);
    expect(Array.from(out3)).toEqual([13, 20, 21]);
    // firstIdx offset: plaintexts start at chunk 1
    const out4 = sliceRange([b, c], 1, 4, 5, 6);
    expect(Array.from(out4)).toEqual([11, 12]);
  });

  it("chunkIv matches symmetric.chunkIv and differs per index", () => {
    const ivBase = new Uint8Array(12);
    for (let i = 0; i < 12; i++) ivBase[i] = i;
    expect(Array.from(chunkIv(ivBase, 0))).toEqual(Array.from(symChunkIv(ivBase, 0)));
    expect(chunkIv(ivBase, 1)).not.toEqual(chunkIv(ivBase, 2));
    expect(chunkIv(ivBase, 0).length).toBe(12);
  });
});

describe("sw logic: LruCache", () => {
  it("evicts oldest entries over the byte budget", () => {
    const cache = new LruCache(10); // 10-byte budget
    cache.set("a", new Uint8Array(4));
    cache.set("b", new Uint8Array(4));
    cache.set("c", new Uint8Array(4)); // total 12 > 10 ⇒ evict "a"
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.size).toBe(8);
  });

  it("get refreshes recency; dropPrefix removes a file's chunks", () => {
    const cache = new LruCache(1000);
    cache.set("f1:0", new Uint8Array(4));
    cache.set("f1:1", new Uint8Array(4));
    cache.set("f2:0", new Uint8Array(4));
    void cache.get("f1:0"); // refresh f1:0 recency
    cache.set("f1:2", new Uint8Array(4));
    // drop f1
    expect(cache.dropPrefix("f1:")).toBe(3);
    expect(cache.has("f1:0")).toBe(false);
    expect(cache.has("f2:0")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --prefix web -- logic.test.ts`
Expected: FAIL (module `./logic` not found).

- [ ] **Step 3: Implement `logic.ts` (pure math parts)**

Create `web/src/sw/logic.ts`:

```ts
/** Service-Worker streaming logic. Pure (no SW globals) so it unit-tests in happy-dom. */

export const SW_CHUNK_SIZE = 4 * 1024 * 1024; // MUST equal FILE_CHUNK_SIZE

/** Which chunk indices cover the inclusive byte range [start..end] of a file of `size` bytes. */
export function chunksCovering(
  start: number,
  end: number,
  size: number,
  chunkSize: number = SW_CHUNK_SIZE,
): { firstIdx: number; lastIdx: number } {
  const last = size - 1;
  const s = Math.max(0, Math.min(start, last));
  const e = Math.max(s, Math.min(end, last));
  return { firstIdx: Math.floor(s / chunkSize), lastIdx: Math.floor(e / chunkSize) };
}

/** Slice the inclusive absolute byte range [start..end] out of concatenated plaintext chunks.
 *  `plaintexts[k]` is the plaintext of chunk `(firstIdx + k)`. */
export function sliceRange(
  plaintexts: Uint8Array[],
  firstIdx: number,
  chunkSize: number,
  start: number,
  end: number,
): Uint8Array {
  const take = end - start + 1;
  const out = new Uint8Array(take);
  const skipWithin = start - firstIdx * chunkSize; // bytes to skip before the first kept byte
  let copied = 0;
  let consumed = 0;
  for (const p of plaintexts) {
    if (copied >= take) break;
    const relStart = Math.max(0, skipWithin - consumed);
    if (relStart >= p.length) { consumed += p.length; continue; }
    const takeHere = Math.min(p.length - relStart, take - copied);
    out.set(p.subarray(relStart, relStart + takeHere), copied);
    copied += takeHere;
    consumed += p.length;
  }
  return out.slice(0, copied);
}

/** Derive a chunk IV (XOR-counter scheme identical to crypto/symmetric.ts). */
export function chunkIv(ivBase: Uint8Array, idx: number): Uint8Array {
  if (ivBase.length !== 12) throw new Error(`ivBase must be 12 bytes, got ${ivBase.length}`);
  const iv = new Uint8Array(ivBase);
  const view = new DataView(iv.buffer, iv.length - 4, 4);
  view.setUint32(0, view.getUint32(0) ^ (idx >>> 0));
  return iv;
}

/** Bounded byte-budget LRU keyed by string (e.g. `${fileId}:${idx}`). Memory-only. */
export class LruCache {
  private map = new Map<string, Uint8Array>();
  private bytes = 0;
  constructor(private readonly budget: number) {}
  has(key: string): boolean { return this.map.has(key); }
  get(key: string): Uint8Array | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v); // refresh recency
    return v;
  }
  set(key: string, val: Uint8Array): void {
    const existing = this.map.get(key);
    if (existing !== undefined) { this.bytes -= existing.length; this.map.delete(key); }
    this.map.set(key, val);
    this.bytes += val.length;
    this.evict();
  }
  get size(): number { return this.bytes; }
  /** Remove every entry whose key starts with `prefix`. Returns the count removed. */
  dropPrefix(prefix: string): number {
    let n = 0;
    for (const [k, v] of this.map) {
      if (k.startsWith(prefix)) { this.map.delete(k); this.bytes -= v.length; n++; }
    }
    return n;
  }
  private evict(): void {
    for (const [k, v] of this.map) {
      if (this.bytes <= this.budget) break;
      this.map.delete(k);
      this.bytes -= v.length;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --prefix web -- logic.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add web/src/sw/logic.ts web/src/sw/logic.test.ts
git commit -m "feat(sw): pure streaming math — range/iv/lru"
```

---

### Task 2: `handleStreamRequest` + `matchStreamId` + `applySwMessage`

**Files:**
- Modify: `web/src/sw/logic.ts` (append decrypt + request handling + routing + message reducer + types)
- Modify: `web/src/sw/logic.test.ts` (append tests)

**Interfaces:**
- Produces:
  - `interface StreamMeta { fileId: string; fileKey: Uint8Array; ivBase: Uint8Array; size: number; chunkCount: number; chunkSize: number; token: string }`
  - `type ChunkFetcher = (idx: number) => Promise<Uint8Array>` (returns ciphertext)
  - `decryptChunkSubtle(key, ivBase, idx, ciphertext): Promise<Uint8Array>`
  - `parseRange(header, size): { start, end }` (inclusive)
  - `handleStreamRequest(req: StreamRequestLike, meta, cache, fetcher): Promise<Response>`
  - `matchStreamId(url): string | null`
  - `type SwMessage = {type:'play'; meta: StreamMeta} | {type:'stop'; fileId: string} | {type:'token'; fileId: string; token: string}`
  - `applySwMessage(metaStore: Map<string, StreamMeta>, cache: LruCache, msg: SwMessage): void`

- [ ] **Step 1: Write the failing tests (append to `logic.test.ts`)**

Append to `web/src/sw/logic.test.ts`:

```ts
import {
  handleStreamRequest,
  matchStreamId,
  applySwMessage,
  parseRange,
  decryptChunkSubtle,
  LruCache as L2,
  type StreamMeta,
  type ChunkFetcher,
} from "./logic";

// Real AES-GCM encrypt helper to produce ciphertext fixtures (mirrors sw decrypt).
async function enc(key: Uint8Array, ivBase: Uint8Array, idx: number, pt: Uint8Array): Promise<Uint8Array> {
  const ck = await crypto.subtle.importKey("raw", key as BufferSource, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = (await import("./logic")).chunkIv(ivBase, idx);
  const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, ck, pt as BufferSource);
  return new Uint8Array(buf);
}

function mkMeta(over: Partial<StreamMeta> = {}): StreamMeta {
  return {
    fileId: "f1", fileKey: new Uint8Array(32), ivBase: new Uint8Array(12),
    size: 0, chunkCount: 0, chunkSize: 4 * 1024 * 1024, token: "tok", ...over,
  };
}

describe("sw logic: request handling", () => {
  it("parseRange supports bytes=start-end and open-ended, clamped to size", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=900-2000", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("handleStreamRequest returns 206 with exact bytes and caches", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const ivBase = crypto.getRandomValues(new Uint8Array(12));
    const chunkSize = 4; // tiny chunks for the test
    const pt0 = new Uint8Array([1, 2, 3, 4]);
    const pt1 = new Uint8Array([5, 6, 7, 8]);
    const ct0 = await enc(key, ivBase, 0, pt0);
    const ct1 = await enc(key, ivBase, 1, pt1);
    const store = new Map<number, Uint8Array>([[0, ct0], [1, ct1]]);
    let calls = 0;
    const fetcher: ChunkFetcher = async (idx) => { calls++; return store.get(idx)!; };
    const cache = new L2(1024);
    const meta = mkMeta({ fileKey: key, ivBase, size: 8, chunkCount: 2, chunkSize });
    const req = { url: "/api/stream/f1", headers: new Headers({ range: "bytes=2-5" }) };
    const res = await handleStreamRequest(req, meta, cache, fetcher);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/8");
    expect(res.headers.get("content-length")).toBe("4");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([3, 4, 5, 6]);
    expect(calls).toBe(2);
    // second call hits cache
    const res2 = await handleStreamRequest(req, meta, cache, fetcher);
    expect(res2.status).toBe(206);
    expect(calls).toBe(2); // no new fetches
  });

  it("handleStreamRequest returns 200 when there is no Range header", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const ivBase = crypto.getRandomValues(new Uint8Array(12));
    const ct = await enc(key, ivBase, 0, new Uint8Array([9, 9, 9]));
    const fetcher: ChunkFetcher = async () => ct;
    const cache = new L2(1024);
    const meta = mkMeta({ fileKey: key, ivBase, size: 3, chunkCount: 1, chunkSize: 4 });
    const res = await handleStreamRequest({ url: "/api/stream/f1", headers: new Headers() }, meta, cache, fetcher);
    expect(res.status).toBe(200);
  });

  it("decryptChunkSubtle round-trips against WebCrypto encrypt", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const ivBase = crypto.getRandomValues(new Uint8Array(12));
    const pt = new Uint8Array([42, 43, 44]);
    const ct = await enc(key, ivBase, 7, pt);
    const out = await decryptChunkSubtle(key, ivBase, 7, ct);
    expect(Array.from(out)).toEqual([42, 43, 44]);
  });
});

describe("sw logic: routing + messages", () => {
  it("matchStreamId extracts fileId from absolute and relative URLs", () => {
    expect(matchStreamId("http://localhost:5173/api/stream/abc-123")).toBe("abc-123");
    expect(matchStreamId("/api/stream/xyz")).toBe("xyz");
    expect(matchStreamId("/api/files/x/y")).toBeNull();
    expect(matchStreamId("/api/stream/")).toBeNull();
  });

  it("applySwMessage handles play/stop/token", () => {
    const store = new Map<string, StreamMeta>();
    const cache = new L2(1024);
    const meta = mkMeta({ fileId: "f1", token: "t0" });
    applySwMessage(store, cache, { type: "play", meta });
    expect(store.get("f1")?.token).toBe("t0");
    cache.set("f1:0", new Uint8Array(4));
    applySwMessage(store, cache, { type: "stop", fileId: "f1" });
    expect(store.has("f1")).toBe(false);
    expect(cache.has("f1:0")).toBe(false);
    // token mutates in place
    const m2 = mkMeta({ fileId: "f2", token: "a" });
    applySwMessage(store, cache, { type: "play", meta: m2 });
    applySwMessage(store, cache, { type: "token", fileId: "f2", token: "b" });
    expect(store.get("f2")?.token).toBe("b");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --prefix web -- logic.test.ts`
Expected: FAIL (`handleStreamRequest` etc. not exported).

- [ ] **Step 3: Append the handling code to `logic.ts`**

Append to `web/src/sw/logic.ts`:

```ts
// --- request handling --------------------------------------------------------

export interface StreamMeta {
  fileId: string;
  fileKey: Uint8Array;
  ivBase: Uint8Array;
  size: number;
  chunkCount: number;
  chunkSize: number;
  token: string;
}

export type ChunkFetcher = (idx: number) => Promise<Uint8Array>; // returns ciphertext

export interface StreamRequestLike {
  url: string;
  headers: { get(name: string): string | null };
}

/** AES-GCM decrypt of one chunk (crypto.subtle; same scheme as the worker). */
export async function decryptChunkSubtle(
  key: Uint8Array,
  ivBase: Uint8Array,
  idx: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key as BufferSource, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: chunkIv(ivBase, idx) as BufferSource }, cryptoKey, ciphertext as BufferSource,
  );
  return new Uint8Array(plain);
}

/** Parse `Range: bytes=start-end` / `bytes=start-` (inclusive end). Unsupported forms ⇒ full. */
export function parseRange(header: string, size: number): { start: number; end: number } {
  const m = /^bytes=(\d+)-(\d*)$/.exec((header || "").trim());
  if (!m) return { start: 0, end: size - 1 };
  const start = parseInt(m[1], 10);
  const end = m[2] !== "" ? parseInt(m[2], 10) : size - 1;
  return { start, end: Math.min(end, size - 1) };
}

/** Serve a Range request: fetch+decrypt covering chunks (cached), slice, respond 206/200. */
export async function handleStreamRequest(
  req: StreamRequestLike,
  meta: StreamMeta,
  cache: LruCache,
  fetcher: ChunkFetcher,
): Promise<Response> {
  const rangeHeader = req.headers.get("range") ?? "";
  const { start, end } = parseRange(rangeHeader, meta.size);
  const { firstIdx, lastIdx } = chunksCovering(start, end, meta.size, meta.chunkSize);
  const plaintexts: Uint8Array[] = [];
  for (let idx = firstIdx; idx <= lastIdx; idx++) {
    const key = `${meta.fileId}:${idx}`;
    let pt = cache.get(key);
    if (!pt) {
      const cipher = await fetcher(idx);
      pt = await decryptChunkSubtle(meta.fileKey, meta.ivBase, idx, cipher);
      cache.set(key, pt);
    }
    plaintexts.push(pt);
  }
  const body = sliceRange(plaintexts, firstIdx, meta.chunkSize, start, end);
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Length": String(body.length),
  });
  if (rangeHeader) {
    headers.set("Content-Range", `bytes ${start}-${end}/${meta.size}`);
    return new Response(body, { status: 206, headers });
  }
  return new Response(body, { status: 200, headers });
}

// --- routing + message reducer ----------------------------------------------

export function matchStreamId(url: string): string | null {
  try {
    const u = new URL(url, "http://localhost");
    const m = /^\/api\/stream\/([^/]+)$/.exec(u.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

export type SwMessage =
  | { type: "play"; meta: StreamMeta }
  | { type: "stop"; fileId: string }
  | { type: "token"; fileId: string; token: string };

export function applySwMessage(
  metaStore: Map<string, StreamMeta>,
  cache: LruCache,
  msg: SwMessage,
): void {
  if (msg.type === "play") {
    metaStore.set(msg.meta.fileId, msg.meta);
  } else if (msg.type === "stop") {
    metaStore.delete(msg.fileId);
    cache.dropPrefix(`${msg.fileId}:`);
  } else if (msg.type === "token") {
    const m = metaStore.get(msg.fileId);
    if (m) m.token = msg.token; // mutate in place so live fetcher closures see it
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --prefix web -- logic.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --prefix web`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/sw/logic.ts web/src/sw/logic.test.ts
git commit -m "feat(sw): handleStreamRequest + routing + message reducer"
```

---

### Task 3: `register.ts` — SW registration + `ensureStreamSw` + `postToSw`

**Files:**
- Create: `web/src/sw/register.ts`
- Test: `web/src/sw/register.test.ts`

**Interfaces:**
- Produces: `ensureStreamSw(): Promise<void>` (rejects if unsupported; resolves once `navigator.serviceWorker.controller` is active); `postToSw(msg: unknown): void`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/sw/register.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

function stubServiceWorker(over: Partial<ServiceWorkerContainer> = {}) {
  const controller = over.controller ?? null;
  const sw = {
    controller,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    register: vi.fn().mockResolvedValue({}),
    ...over,
  } as unknown as ServiceWorkerContainer;
  vi.stubGlobal("navigator", { ...((globalThis as any).navigator ?? {}), serviceWorker: sw });
  return sw;
}

describe("ensureStreamSw", () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); });

  it("rejects when service workers are unsupported", async () => {
    vi.stubGlobal("navigator", { serviceWorker: undefined });
    const { ensureStreamSw } = await import("./register");
    await expect(ensureStreamSw()).rejects.toThrow(/unsupported/i);
  });

  it("resolves immediately when a controller already exists", async () => {
    const active = {} as ServiceWorker;
    stubServiceWorker({ controller: active });
    const { ensureStreamSw } = await import("./register");
    await expect(ensureStreamSw()).resolves.toBeUndefined();
  });

  it("registers and resolves on controllerchange", async () => {
    let changeCb: (() => void) | null = null;
    const sw = stubServiceWorker({
      controller: null,
      addEventListener: vi.fn((_: string, cb: any) => { changeCb = cb; }),
      register: vi.fn().mockImplementation(() => {
        // simulate the registered SW taking control
        (sw as any).controller = {} as ServiceWorker;
        setTimeout(() => changeCb && changeCb(), 0);
        return Promise.resolve({});
      }),
    });
    const { ensureStreamSw } = await import("./register");
    await expect(ensureStreamSw()).resolves.toBeUndefined();
    expect(sw.register).toHaveBeenCalledWith("/sw.js", { type: "module" });
  });

  it("postToSw forwards to the controller", async () => {
    const post = vi.fn();
    stubServiceWorker({ controller: { postMessage: post } as unknown as ServiceWorker });
    const { postToSw } = await import("./register");
    postToSw({ type: "play" });
    expect(post).toHaveBeenCalledWith({ type: "play" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --prefix web -- register.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `register.ts`**

Create `web/src/sw/register.ts`:

```ts
/** Service-Worker registration + a promise that resolves once a controller is active. */

let ensurePromise: Promise<void> | null = null;

export function ensureStreamSw(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.reject(new Error("service worker unsupported"));
  }
  const sw = navigator.serviceWorker;
  if (sw.controller) return Promise.resolve();
  if (ensurePromise) return ensurePromise;
  ensurePromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const onReady = () => {
      if (!settled && sw.controller) {
        settled = true;
        sw.removeEventListener("controllerchange", onReady);
        ensurePromise = null;
        resolve();
      }
    };
    sw.addEventListener("controllerchange", onReady);
    sw.register("/sw.js", { type: "module" }).then(onReady).catch((e: unknown) => {
      if (!settled) {
        settled = true;
        sw.removeEventListener("controllerchange", onReady);
        ensurePromise = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
  return ensurePromise;
}

export function postToSw(msg: unknown): void {
  navigator.serviceWorker?.controller?.postMessage(msg);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --prefix web -- register.test.ts`
Expected: PASS (4).

- [ ] **Step 5: Commit**

```bash
git add web/src/sw/register.ts web/src/sw/register.test.ts
git commit -m "feat(sw): ensureStreamSw + postToSw"
```

---

### Task 4: SW entry (`sw.ts`) + `vite-plugin-pwa` wiring + `main.ts` register

**Files:**
- Create: `web/src/sw/sw.ts`
- Modify: `web/vite.config.ts` (add VitePWA plugin)
- Modify: `web/package.json` (devDep)
- Modify: `web/src/main.ts` (best-effort register call)

**Interfaces:**
- Consumes: `handleStreamRequest`, `matchStreamId`, `applySwMessage`, `LruCache`, types from `./logic`; `Response`/`fetch`/SW globals.
- Produces: `/sw.js` (module SW) built for dev + prod.

- [ ] **Step 1: Add the dev dependency**

Run: `npm install --prefix web -D vite-plugin-pwa`
(Confirm it lands in `devDependencies` of `web/package.json`.)

- [ ] **Step 2: Implement the SW entry**

Create `web/src/sw/sw.ts`. The SW globals are cast to `any` deliberately to avoid DOM/WebWorker lib conflicts in the app's tsconfig; all real logic lives in `./logic` (typed):

```ts
/// <reference lib="webworker" />
/// <disable> type-only: SW globals typed loosely to avoid lib conflicts </disable>

import {
  handleStreamRequest,
  matchStreamId,
  applySwMessage,
  LruCache,
  type StreamMeta,
  type SwMessage,
} from "./logic";

// `self` is a ServiceWorkerGlobalScope inside the SW, but the app's tsconfig
// types it as Window. Cast loosely here; the logic module owns correctness.
const sw: any = self;

const metaStore = new Map<string, StreamMeta>();
const cache = new LruCache(256 * 1024 * 1024);

sw.addEventListener("install", () => { void sw.skipWaiting(); });
sw.addEventListener("activate", (event: any) => { event.waitUntil(sw.clients.claim()); });

sw.addEventListener("message", (event: MessageEvent) => {
  applySwMessage(metaStore, cache, event.data as SwMessage);
});

sw.addEventListener("fetch", (event: any) => {
  const req: Request = event.request;
  if (req.method !== "GET") return;
  const fileId = matchStreamId(req.url);
  if (!fileId) return; // pass through to the network
  const meta = metaStore.get(fileId);
  if (!meta) {
    event.respondWith(new Response("stream not prepared", { status: 404 }));
    return;
  }
  event.respondWith((async () => {
    try {
      return await handleStreamRequest(req, meta, cache, makeFetcher(meta));
    } catch (err) {
      return new Response(`stream error: ${String(err)}`, { status: 500 });
    }
  })());
});

function makeFetcher(meta: StreamMeta): (idx: number) => Promise<Uint8Array> {
  return async (idx) => {
    const url = `/api/files/${meta.fileId}/chunks/${idx}`;
    const doFetch = (tok: string) => fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    let resp = await doFetch(meta.token);
    if (resp.status === 401) {
      const fresh = await requestFreshToken(meta.fileId);
      if (fresh) { meta.token = fresh; resp = await doFetch(fresh); }
    }
    if (!resp.ok) throw new Error(`chunk ${idx} fetch failed: ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  };
}

function requestFreshToken(fileId: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const onMsg = (event: MessageEvent) => {
      const d = event.data;
      if (!done && d && d.type === "token" && d.fileId === fileId && typeof d.token === "string") {
        done = true;
        sw.removeEventListener("message", onMsg);
        resolve(d.token as string);
      }
    };
    sw.addEventListener("message", onMsg);
    void sw.clients.matchAll().then((clients: any[]) =>
      clients.forEach((c) => c.postMessage({ type: "needToken", fileId })),
    );
    setTimeout(() => {
      if (!done) { sw.removeEventListener("message", onMsg); resolve(null); }
    }, 5000);
  });
}
```

- [ ] **Step 3: Wire `vite-plugin-pwa` into `vite.config.ts`**

In `web/vite.config.ts` add the import and plugin. Keep `fixLibsodiumImport()` first, then `vue()`, then `VitePWA`:

```ts
import { VitePWA } from "vite-plugin-pwa";
```

```ts
  plugins: [
    fixLibsodiumImport(),
    vue(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/sw",
      filename: "sw.ts",
      injectRegister: false,
      devOptions: { enabled: true, type: "module" },
    }),
  ],
```

- [ ] **Step 4: Register on bootstrap in `main.ts`**

In `web/src/main.ts`, add the import and a best-effort call after mount:

```ts
import { ensureStreamSw } from "./sw/register";
```

Inside `bootstrap()`, after `app.mount("#app");`:

```ts
  // Warm up the streaming Service Worker. Unsupported browsers / registration
  // failures are ignored here; video preview falls back at play time.
  void ensureStreamSw().catch(() => {});
```

- [ ] **Step 5: Typecheck + build (the SW lifecycle is verified by build, not unit tests)**

Run: `npm run typecheck --prefix web`
Run: `npm run build --prefix web`
Expected: typecheck clean; build emits `web/dist/sw.js` (verify with `ls web/dist/sw.js`).

- [ ] **Step 6: Run full frontend suite (regression)**

Run: `npm run test --prefix web`
Expected: all green (no test touches the SW lifecycle directly).

- [ ] **Step 7: Commit**

```bash
git add web/src/sw/sw.ts web/vite.config.ts web/src/main.ts web/package.json web/package-lock.json
git commit -m "feat(sw): SW entry + vite-plugin-pwa wiring + bootstrap register"
```

---

### Task 5: Store — route `video/*` to streaming; `stop` on close; `needToken` listener

**Files:**
- Modify: `web/src/stores/files.ts`
- Modify: `web/src/stores/files.test.ts`

**Interfaces:**
- Consumes: `ensureStreamSw`, `postToSw` from `@/sw/register`; `getAuthToken`, `refreshAuthToken` from `@/api/client`; `FILE_CHUNK_SIZE`, `fromBase64` from `@/crypto/file`; `PREVIEW_CAPS` from `@/crypto/preview`; `cryptoApi.unwrap`/`decryptManifest` from `@/workers/crypto`; `Manifest` type.
- Produces: `openPreview(meta)` routes `video/*` → `openVideo(meta, manifest)` (streaming via `/api/stream/:id`, fallback to P2a blob when SW unavailable & size ≤ cap); `closePreview()` posts `stop` for stream URLs; a SW `needToken` listener that refreshes + replies.

- [ ] **Step 1: Add the SW mock alongside the existing top-level mocks, then append the new tests**

The test file already imports `vi` and already has `vi.mock` blocks for `@/workers/crypto`, `@/api/files`, and `@/api/client`. Add a hoisted SW mock block next to them (do NOT re-import `vi` — it is already in scope):

```ts
const { ensureStreamSwMock, postToSwMock, getTokenMock } = vi.hoisted(() => ({
  ensureStreamSwMock: vi.fn().mockResolvedValue(undefined),
  postToSwMock: vi.fn(),
  getTokenMock: vi.fn().mockReturnValue("tok"),
}));

vi.mock("@/sw/register", () => ({
  ensureStreamSw: ensureStreamSwMock,
  postToSw: postToSwMock,
}));
```

Also add `getAuthToken: getTokenMock` to the existing `vi.mock("@/api/client", ...)` factory (the P2a factory exposes `refreshAuthToken` + `ApiError`; add `getAuthToken` alongside them so the store's `getAuthToken()` resolves to `"tok"`).

Then append these three tests inside the existing `describe("files store", ...)` block:

```ts
  it("openPreview routes video to the streaming URL via the SW", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    ensureStreamSwMock.mockResolvedValue(undefined);
    (cryptoApi.decryptManifest as any).mockResolvedValue({
      name: "clip.mp4", mime: "video/mp4", size: 5 * 1024 * 1024 * 1024,
      iv_base: "iv==", chunk_size: 4 * 1024 * 1024,
    });
    const files = useFilesStore();
    const meta = {
      id: "vid1", owner_id: "u", status: "ready" as const,
      total_size: 0, chunk_count: 2,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    expect(ensureStreamSwMock).toHaveBeenCalled();
    expect(postToSwMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "play",
      meta: expect.objectContaining({ fileId: "vid1", chunkCount: 2 }),
    }));
    expect(files.preview).not.toBeNull();
    expect(files.preview!.url).toBe("/api/stream/vid1");
    expect(files.preview!.kind).toBe("video");
  });

  it("closePreview posts stop for a stream URL", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    ensureStreamSwMock.mockResolvedValue(undefined);
    (cryptoApi.decryptManifest as any).mockResolvedValue({
      name: "clip.mp4", mime: "video/mp4", size: 1000,
      iv_base: "iv==", chunk_size: 4 * 1024 * 1024,
    });
    const files = useFilesStore();
    const meta = {
      id: "vid2", owner_id: "u", status: "ready" as const,
      total_size: 0, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    postToSwMock.mockClear();
    files.closePreview();
    expect(postToSwMock).toHaveBeenCalledWith(expect.objectContaining({ type: "stop", fileId: "vid2" }));
  });

  it("falls back to blob when SW unavailable and the video is small", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    ensureStreamSwMock.mockRejectedValue(new Error("unsupported"));
    (cryptoApi.decryptManifest as any).mockResolvedValue({
      name: "small.mp4", mime: "video/mp4", size: 1000,
      iv_base: "iv==", chunk_size: 4 * 1024 * 1024,
    });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:small"),
      revokeObjectURL: vi.fn(),
    });
    const files = useFilesStore();
    const meta = {
      id: "vid3", owner_id: "u", status: "ready" as const,
      total_size: 0, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    expect(files.preview!.url).toBe("blob:small");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --prefix web -- files.test.ts`
Expected: FAIL (video still goes through the blob path; `ensureStreamSw`/`postToSw` not called).

- [ ] **Step 3: Add imports to `stores/files.ts`**

At the top of `web/src/stores/files.ts`, extend imports:

```ts
import { refreshAuthToken, ApiError, getAuthToken } from "@/api/client";
import { FILE_CHUNK_SIZE, chunkCount, toBase64, fromBase64, type Manifest } from "@/crypto/file";
import { kindOf, canPreview, PREVIEW_CAPS, type FileKind } from "@/crypto/preview";
import { ensureStreamSw, postToSw } from "@/sw/register";
```

(Adjust the existing `@/api/client` and `@/crypto/file`/`@/crypto/preview` import lines so each added binding appears once.)

- [ ] **Step 4: Route video + add `openVideo`, SW listener, `closePreview` stop**

Inside the store setup (top of `useFilesStore`), add a one-time SW `needToken` listener:

```ts
  let swListenerBound = false;
  function bindSwListener(): void {
    if (swListenerBound || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    swListenerBound = true;
    navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
      const d = e.data;
      if (d && d.type === "needToken" && d.fileId) {
        void refreshAuthToken().then((ok) => {
          const token = ok ? getAuthToken() : null;
          if (token) postToSw({ type: "token", fileId: d.fileId, token });
        });
      }
    });
  }
```

Change `openPreview` to route video BEFORE the `other`/too-large checks. Replace the top of `openPreview` (from `const kind = kindOf(...)` through the `canPreview` block) with:

```ts
      const kind = kindOf(manifest.mime);
      if (kind === "video") {
        return await openVideo(meta, manifest);
      }
      if (kind === "other") {
        error.value = "Preview is not supported for this file type — use Download.";
        return;
      }
      if (!canPreview(kind, manifest.size)) {
        error.value = "File too large to preview — use Download.";
        return;
      }
```

(The rest of `openPreview` — the blob build — stays for image/text/audio.)

Add the `openVideo` function (place it just before `openPreview`):

```ts
  async function openVideo(meta: FileMeta, manifest: Manifest): Promise<void> {
    const mk = masterKey();
    const fileKey = await cryptoApi.unwrap(
      {
        ciphertext: fromBase64(meta.encrypted_file_key!),
        iv: fromBase64(meta.encrypted_file_key_nonce!),
      },
      mk,
    );
    const ivBase = fromBase64(manifest.iv_base);
    bindSwListener();
    let swOk = true;
    try {
      await ensureStreamSw();
    } catch {
      swOk = false;
    }
    if (swOk) {
      if (preview.value) closePreview();
      postToSw({
        type: "play",
        meta: {
          fileId: meta.id,
          fileKey,
          ivBase,
          size: manifest.size,
          chunkCount: meta.chunk_count,
          chunkSize: FILE_CHUNK_SIZE,
          token: getAuthToken() ?? "",
        },
      });
      preview.value = {
        meta,
        url: `/api/stream/${meta.id}`,
        kind: "video",
        name: manifest.name,
      };
      return;
    }
    // Fallback: whole-file blob for small videos; otherwise degrade.
    if (manifest.size <= PREVIEW_CAPS.video) {
      const n = meta.chunk_count;
      const parts = new Array<Uint8Array>(n);
      await asyncPool(
        3,
        Array.from({ length: n }, (_, i) => i),
        async (i) => {
          const resp = await filesApi.getChunk(meta.id, i);
          const cipher = new Uint8Array(await resp.arrayBuffer());
          parts[i] = await cryptoApi.decryptChunk(fileKey, ivBase, i, cipher);
        },
      );
      const blob = new Blob(parts as BlobPart[], { type: manifest.mime });
      if (preview.value) URL.revokeObjectURL(preview.value.url);
      preview.value = {
        meta,
        url: URL.createObjectURL(blob),
        kind: "video",
        name: manifest.name,
      };
      return;
    }
    error.value = "Streaming is unavailable in this browser — use Download.";
  }
```

Update `closePreview` to post `stop` for stream URLs (and keep revoking blob URLs):

```ts
  function closePreview(): void {
    if (!preview.value) return;
    const p = preview.value;
    if (p.url.startsWith("blob:")) URL.revokeObjectURL(p.url);
    if (p.kind === "video" && p.url.startsWith("/api/stream/")) {
      postToSw({ type: "stop", fileId: p.meta.id });
    }
    preview.value = null;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test --prefix web -- files.test.ts`
Expected: PASS (all, including the 3 new tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck --prefix web`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/stores/files.ts web/src/stores/files.test.ts
git commit -m "feat(store): route video to SW streaming; stop on close; needToken refresh"
```

---

### Task 6: Backend — raise `max_file_bytes` to 100 GiB

**Files:**
- Modify: `server/src/config.rs` (default + default test)
- Modify: `server/config.toml`

**Interfaces:**
- Produces: `LimitSettings::default().max_file_bytes == 100*1024*1024*1024`; `config.toml` `max_file_bytes = 107374182400`.

- [ ] **Step 1: Update the default + test**

In `server/src/config.rs`, in `impl Default for LimitSettings`:

```rust
            max_file_bytes: 100 * 1024 * 1024 * 1024,
```

In the `defaults_match_documented_values` test:

```rust
        assert_eq!(s.limits.max_file_bytes, 100 * 1024 * 1024 * 1024);
```

(The existing `load_lets_toml_override_limits` test already overrides both keys to small values — no change needed there.)

- [ ] **Step 2: Update `config.toml`**

In `server/config.toml` `[limits]`:

```toml
max_file_bytes = 107374182400        # 100 GiB total-file cap (checked by POST /api/files on total_size)
```

(`100 * 1024 * 1024 * 1024 == 107374182400` — verify the digit count when editing.)

- [ ] **Step 3: Run the backend suite**

Run: `cargo test --manifest-path server/Cargo.toml -- --test-threads=1`
Expected: all PASS (incl. the updated default assertion + the override test).

- [ ] **Step 4: Commit**

```bash
git add server/src/config.rs server/config.toml
git commit -m "feat(server): raise max_file_bytes default to 100 GiB for P2b video"
```

---

### Task 7: Docs + final full-stack verification

**Files:**
- Modify: `docs/streaming.md` (rewrite to the SW-proxy architecture)
- Modify: `docs/api.md` (note the virtual `/api/stream/:id`)
- Modify: `README.md` (P2 status → ✅ complete)

- [ ] **Step 1: Rewrite `docs/streaming.md`**

Replace the entire file with a description of the SW-proxy pipeline (mirror spec §1–§4): the browser issues Range requests on the virtual `/api/stream/:id` URL; the SW maps bytes→chunks by division, fetches `/api/files/:id/chunks/:idx`, AES-GCM-decrypts with `crypto.subtle`, caches in a 256 MiB in-SW LRU, and returns 206 slices; native `<video>` handles seek/buffering/codecs; page pushes `{fileKey, ivBase,…}` via `postMessage`; SW requests token refresh on 401; fallback to whole-file blob when SW is unavailable. Note explicitly that the earlier MSE/transmuxer/container-index plan was superseded.

- [ ] **Step 2: Note the virtual stream URL in `docs/api.md`**

In `docs/api.md`, under the Files section, add:

```markdown
> **Note:** `/api/stream/:id` is a **virtual** URL handled entirely by the
> browser's Service Worker; it never reaches the backend. The SW serves the
> browser's Range requests by fetching and decrypting
> `GET /api/files/:id/chunks/:idx`. See [docs/streaming.md](streaming.md).
```

- [ ] **Step 3: Update README P2 status**

In `README.md` Status table, set the P2 row:

```markdown
| P2 | Chunked upload/download, video streaming via MSE | ✅ complete |
```

(Keep the original wording; only flip the status to ✅ complete. If desired, add a parenthetical that streaming uses a Service-Worker proxy rather than MSE.)

- [ ] **Step 4: Full-stack verification**

Run: `cargo test --manifest-path server/Cargo.toml -- --test-threads=1`
Run: `npm run test --prefix web`
Run: `npm run typecheck --prefix web`
Run: `npm run build --prefix web`
Expected: backend all green; frontend all green; typecheck clean; build succeeds and emits `web/dist/sw.js`.

- [ ] **Step 5: Commit**

```bash
git add docs/streaming.md docs/api.md README.md
git commit -m "docs: P2b streaming (SW proxy) + flip P2 status to complete"
```

---

## Verification summary

- Backend: `cargo test --manifest-path server/Cargo.toml -- --test-threads=1`.
- Frontend: `npm run test --prefix web`, `npm run typecheck --prefix web`, `npm run build --prefix web` (must emit `sw.js`).
- Manual: in a real browser, play a >4 MiB encrypted MP4; drag the scrubber (byte-exact seek via native Range); scrub backward (cache hit, instant); confirm `Authorization` chunk fetches succeed and a forced token expiry recovers.
