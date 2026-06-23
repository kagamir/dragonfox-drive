# On-Demand Video Streaming (Segmented Read-Ahead) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make large encrypted videos buffer on demand (one ~16 MiB segment at a time) instead of downloading/decrypting the whole file up front, and stream the response so SW memory stays flat.

**Architecture:** The SW's `handleStreamRequest` currently treats the browser's open-ended `Range: bytes=0-` as "the whole file" and fetches+decrypts every chunk before responding. We (1) cap each response to a bounded byte window so the browser re-requests the next segment as playback progresses, (2) replace the materialized body with a `ReadableStream` that emits one chunk-slice at a time, and (3) wire an `AbortController` so seeking cancels in-flight chunk fetches. Purely reactive — the browser's native `<video>` engine drives all Range requests.

**Tech Stack:** TypeScript, Web Streams API (`ReadableStream`), `AbortController`/`AbortSignal`, WebCrypto (`crypto.subtle` AES-GCM), vitest + happy-dom.

**Spec:** `docs/superpowers/specs/2026-06-23-on-demand-video-streaming-design.md`

## Global Constraints

- `STREAM_SEGMENT_BYTES = 4 * SW_CHUNK_SIZE` (16 MiB). Defined once in `web/src/sw/logic.ts`.
- `parseRange`, `chunkIv`, `chunksCovering`, `sliceRange`, `LruCache`, `matchStreamId`, `applySwMessage` — signatures and existing tests MUST stay unchanged.
- `ChunkFetcher` gains an **optional** `signal?: AbortSignal` 2nd parameter so existing fetcher-based tests (`async (idx) => …`) keep matching.
- The Service Worker always calls `handleStreamRequest` with the default `segmentBytes` (16 MiB). The 5th `segmentBytes` parameter exists ONLY so unit tests can exercise capping with tiny fixtures.
- Run a single test file: `npm test --prefix D:\Projects\dragonfox-drive\web -- src/sw/logic.test.ts`. Full suite: `npm test --prefix D:\Projects\dragonfox-drive\web`. Typecheck: `npm run typecheck --prefix D:\Projects\dragonfox-drive\web`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `web/src/sw/logic.ts` | Pure SW streaming logic (byte math, slicing, LRU, request handling) | Add `STREAM_SEGMENT_BYTES` + `chunkSlice`; rewrite `handleStreamRequest` (cap → stream → cancel); extend `ChunkFetcher` type |
| `web/src/sw/logic.test.ts` | Unit tests for `logic.ts` in happy-dom | Add capping, streaming-order, and cancel tests; existing tests unchanged |
| `web/src/sw/sw.ts` | SW entry (event wiring) | `makeFetcher` passes `signal` through to `fetch()` |
| `docs/streaming.md` | Streaming architecture doc | Update pipeline diagram + replace the obsolete "v1 range assembly" limitation |

Tasks are ordered by dependency: **Task 1** (cap) is the core fix and ships the user-facing behavior; **Task 2** (streaming body) flattens memory; **Task 3** (cancellation) adds seek hygiene; **Task 4** syncs the docs. Each task is independently shippable.

---

### Task 1: Cap each streaming response to one segment

**Files:**
- Modify: `web/src/sw/logic.ts` (add constant near top; rewrite `handleStreamRequest` at lines 136-168)
- Test: `web/src/sw/logic.test.ts` (append new tests inside the `describe("sw logic: request handling", …)` block, lines ~103-157)

**Interfaces:**
- Produces: `export const STREAM_SEGMENT_BYTES` (number); `handleStreamRequest` gains an optional 5th param `segmentBytes: number = STREAM_SEGMENT_BYTES`.
- Consumes: unchanged `parseRange`, `chunksCovering`, `sliceRange`, `decryptChunkSubtle`, `LruCache` from the same module.

This task keeps the **materialized** body (still uses `sliceRange`) — it only caps which chunks are fetched and what byte window is sliced. That alone stops the whole-file download. Streaming the body is Task 2.

- [ ] **Step 1: Write the failing tests**

Open `web/src/sw/logic.test.ts`. Inside the `describe("sw logic: request handling", () => { … })` block (after the existing `handleStreamRequest returns 200 when there is no Range header` test, before the closing `});` of that describe), append:

```ts
  it("handleStreamRequest caps an open-ended range to one segment and fetches only the covering chunks", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const ivBase = crypto.getRandomValues(new Uint8Array(12));
    const chunkSize = 4;
    const size = 20; // 5 chunks of 4 bytes
    const pts = [
      new Uint8Array([0, 0, 0, 1]),
      new Uint8Array([0, 0, 0, 2]),
      new Uint8Array([0, 0, 0, 3]),
      new Uint8Array([0, 0, 0, 4]),
      new Uint8Array([0, 0, 0, 5]),
    ];
    const cts = await Promise.all(pts.map((pt, i) => enc(key, ivBase, i, pt)));
    const store = new Map<number, Uint8Array>(cts.map((c, i) => [i, c]));
    let calls = 0;
    const fetcher: ChunkFetcher = async (idx) => { calls++; return store.get(idx)!; };
    const cache = new L2(1024);
    const meta = mkMeta({ fileKey: key, ivBase, size, chunkCount: 5, chunkSize });
    const req = { url: "/api/stream/f1", headers: new Headers({ range: "bytes=0-" }) };
    // segmentBytes=8 ⇒ effectiveEnd=7 ⇒ only chunks 0 and 1 fetched (NOT all 5)
    const res = await handleStreamRequest(req, meta, cache, fetcher, 8);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-7/20");
    expect(res.headers.get("content-length")).toBe("8");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0, 0, 0, 1, 0, 0, 0, 2]);
    expect(calls).toBe(2);
  });

  it("handleStreamRequest serves the next segment and reuses cached chunks at the boundary", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const ivBase = crypto.getRandomValues(new Uint8Array(12));
    const chunkSize = 4;
    const size = 20;
    const pts = [
      new Uint8Array([0, 0, 0, 1]),
      new Uint8Array([0, 0, 0, 2]),
      new Uint8Array([0, 0, 0, 3]),
      new Uint8Array([0, 0, 0, 4]),
      new Uint8Array([0, 0, 0, 5]),
    ];
    const cts = await Promise.all(pts.map((pt, i) => enc(key, ivBase, i, pt)));
    const store = new Map<number, Uint8Array>(cts.map((c, i) => [i, c]));
    let calls = 0;
    const fetcher: ChunkFetcher = async (idx) => { calls++; return store.get(idx)!; };
    const cache = new L2(1024);
    const meta = mkMeta({ fileKey: key, ivBase, size, chunkCount: 5, chunkSize });
    const req = (range: string) => ({ url: "/api/stream/f1", headers: new Headers({ range }) });
    // first segment: bytes=0- capped to [0..7] (chunks 0,1). Drain the body so the
    // fetches complete before counting (Task 2 makes the body a lazy stream).
    const res1 = await handleStreamRequest(req("bytes=0-"), meta, cache, fetcher, 8);
    await res1.arrayBuffer();
    expect(calls).toBe(2);
    // second segment: bytes=4- capped to [4..11] (chunks 1,2); chunk 1 already cached
    const res2 = await handleStreamRequest(req("bytes=4-"), meta, cache, fetcher, 8);
    await res2.arrayBuffer();
    expect(res2.headers.get("content-range")).toBe("bytes 4-11/20");
    expect(calls).toBe(3); // only chunk 2 newly fetched (chunk 1 hit the LRU)
  });

  it("handleStreamRequest returns 206 capped when no Range header is present on a large file", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const ivBase = crypto.getRandomValues(new Uint8Array(12));
    const chunkSize = 4;
    const size = 20;
    const cts = await Promise.all([0, 1].map((i) => enc(key, ivBase, i, new Uint8Array([0, 0, 0, i + 1]))));
    const store = new Map<number, Uint8Array>(cts.map((c, i) => [i, c]));
    const fetcher: ChunkFetcher = async (idx) => store.get(idx)!;
    const cache = new L2(1024);
    const meta = mkMeta({ fileKey: key, ivBase, size, chunkCount: 5, chunkSize });
    const res = await handleStreamRequest({ url: "/api/stream/f1", headers: new Headers() }, meta, cache, fetcher, 8);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-7/20");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --prefix D:\Projects\dragonfox-drive\web -- src/sw/logic.test.ts`
Expected: the 3 new tests FAIL. The first fails because `handleStreamRequest` does not accept a 5th `segmentBytes` arg and currently returns `Content-Range: bytes 0-19/20` with `calls === 5`. (The 2 pre-existing `handleStreamRequest` tests and all other tests still PASS.)

- [ ] **Step 3: Add the `STREAM_SEGMENT_BYTES` constant**

In `web/src/sw/logic.ts`, directly under the existing `export const SW_CHUNK_SIZE = …` line (line 3), add:

```ts
/** Per-response cap so the browser re-requests the next segment as playback
 *  progresses instead of pulling the whole file up front. 4× chunk size. */
export const STREAM_SEGMENT_BYTES = 4 * SW_CHUNK_SIZE;
```

- [ ] **Step 4: Rewrite `handleStreamRequest` with the cap**

In `web/src/sw/logic.ts`, replace the entire current `handleStreamRequest` function (the block starting `/** Serve a Range request: … */` and ending at the closing brace before `// --- routing + message reducer ---`) with:

```ts
/** Serve a Range request: fetch+decrypt the covering chunks (cached), slice the
 *  requested window, and respond 206/200. The response is capped to
 *  `segmentBytes` so the browser re-requests the next segment as playback
 *  advances, instead of pulling the whole file up front. */
export async function handleStreamRequest(
  req: StreamRequestLike,
  meta: StreamMeta,
  cache: LruCache,
  fetcher: ChunkFetcher,
  segmentBytes: number = STREAM_SEGMENT_BYTES,
): Promise<Response> {
  const rangeHeader = req.headers.get("range") ?? "";
  const hasRange = !!rangeHeader;
  const { start, end } = parseRange(rangeHeader, meta.size);
  const effectiveEnd = Math.min(end, start + segmentBytes - 1, meta.size - 1);
  const { firstIdx, lastIdx } = chunksCovering(start, effectiveEnd, meta.size, meta.chunkSize);
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
  const body = sliceRange(plaintexts, firstIdx, meta.chunkSize, start, effectiveEnd);
  const length = effectiveEnd - start + 1;
  const isPartial = hasRange || effectiveEnd < meta.size - 1;
  const headers = new Headers({
    "Content-Type": meta.mime,
    "Accept-Ranges": "bytes",
    "Content-Length": String(length),
  });
  if (isPartial) {
    headers.set("Content-Range", `bytes ${start}-${effectiveEnd}/${meta.size}`);
    return new Response(body, { status: 206, headers });
  }
  return new Response(body, { status: 200, headers });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test --prefix D:\Projects\dragonfox-drive\web -- src/sw/logic.test.ts`
Expected: all 14 tests PASS (11 pre-existing + 3 new). The 2 pre-existing `handleStreamRequest` tests pass unchanged because `bytes=2-5` and the no-Range `size=3` case are both smaller than the default cap and produce identical output.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck --prefix D:\Projects\dragonfox-drive\web`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/sw/logic.ts web/src/sw/logic.test.ts
git commit -m "feat(sw): cap stream responses to a bounded read-ahead segment"
```

---

### Task 2: Stream the response body chunk-by-chunk

**Files:**
- Modify: `web/src/sw/logic.ts` (add `chunkSlice` after `sliceRange`; rewrite the body construction inside `handleStreamRequest`)
- Test: `web/src/sw/logic.test.ts` (add `chunkSlice` unit tests + a streaming-order test)

**Interfaces:**
- Produces: `export function chunkSlice(plaintext, idx, chunkSize, start, end): Uint8Array`.
- Consumes: the `STREAM_SEGMENT_BYTES` + capped `handleStreamRequest` from Task 1.

`handleStreamRequest` currently builds the whole segment body with one `sliceRange` call, then returns it as a single `Uint8Array`. We swap that for a `ReadableStream` that fetches/decrypts one chunk at a time and enqueues only that chunk's slice — so at most one chunk's plaintext is resident at a time (plus the LRU). The bytes returned are identical to Task 1; only the body construction changes.

- [ ] **Step 1: Write the failing `chunkSlice` tests**

In `web/src/sw/logic.test.ts`, update the import at the top (line 2-8) to also pull in `chunkSlice`:

```ts
import {
  SW_CHUNK_SIZE,
  chunksCovering,
  sliceRange,
  chunkSlice,
  chunkIv,
  LruCache,
} from "./logic";
```

Then, inside the existing `describe("sw logic: pure math", () => { … })` block (after the `sliceRange returns the exact requested bytes…` test, before its closing `});`), add:

```ts
  it("chunkSlice returns the overlap of one chunk with the absolute byte range", () => {
    const a = new Uint8Array([1, 2, 3, 4]); // chunk 0 → absolute bytes 0..3
    // fully covered
    expect(Array.from(chunkSlice(a, 0, 4, 0, 3))).toEqual([1, 2, 3, 4]);
    // range starts inside this chunk (keep tail)
    expect(Array.from(chunkSlice(a, 0, 4, 2, 9))).toEqual([3, 4]);
    // range ends inside this chunk (keep head)
    expect(Array.from(chunkSlice(a, 0, 4, 0, 1))).toEqual([1, 2]);
    // no overlap (range begins after the chunk)
    expect(Array.from(chunkSlice(a, 0, 4, 5, 9))).toEqual([]);
    // middle chunk idx=1 → absolute bytes 4..7
    const b = new Uint8Array([5, 6, 7, 8]);
    expect(Array.from(chunkSlice(b, 1, 4, 2, 5))).toEqual([5, 6]); // abs bytes 4,5
    // tail chunk shorter than chunkSize (idx=2 → abs bytes 8..9)
    const c = new Uint8Array([9, 9]);
    expect(Array.from(chunkSlice(c, 2, 4, 8, 11))).toEqual([9, 9]);
  });
```

- [ ] **Step 2: Write the failing streaming-order test**

In `web/src/sw/logic.test.ts`, inside `describe("sw logic: request handling", () => { … })` (after the Task 1 tests, before the closing `});`), add:

```ts
  it("handleStreamRequest streams chunk slices in ascending byte order", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const ivBase = crypto.getRandomValues(new Uint8Array(12));
    const chunkSize = 4;
    const pts = [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      new Uint8Array([9, 10, 11, 12]),
    ];
    const cts = await Promise.all(pts.map((pt, i) => enc(key, ivBase, i, pt)));
    const store = new Map<number, Uint8Array>(cts.map((c, i) => [i, c]));
    const fetcher: ChunkFetcher = async (idx) => store.get(idx)!;
    const cache = new L2(1024);
    const meta = mkMeta({ fileKey: key, ivBase, size: 12, chunkCount: 3, chunkSize });
    const req = { url: "/api/stream/f1", headers: new Headers({ range: "bytes=2-9" }) };
    const res = await handleStreamRequest(req, meta, cache, fetcher, 1024);
    // drain the stream chunk-by-chunk
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    // range [2..9]: chunk0→[3,4], chunk1→[5,6,7,8], chunk2→[9,10]
    expect(chunks.length).toBe(3);
    expect(chunks.flatMap((c) => Array.from(c))).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test --prefix D:\Projects\dragonfox-drive\web -- src/sw/logic.test.ts`
Expected: the `chunkSlice` tests fail (`chunkSlice is not defined`) and the streaming-order test fails (`res.body` is currently a `Uint8Array`, not a stream, so `getReader` is undefined / `chunks.length` is wrong). Task 1's tests still pass.

- [ ] **Step 4: Add the `chunkSlice` helper**

In `web/src/sw/logic.ts`, immediately after the existing `sliceRange` function (after its closing brace, before `/** Derive a chunk IV … */`), add:

```ts
/** Slice the bytes of a single decrypted chunk `idx` that fall inside the
 *  absolute byte range [start..end]. `plaintext` is chunk `idx`'s decrypted
 *  bytes (may be shorter than `chunkSize` for the file's tail chunk). */
export function chunkSlice(
  plaintext: Uint8Array,
  idx: number,
  chunkSize: number,
  start: number,
  end: number,
): Uint8Array {
  const chunkStart = idx * chunkSize;
  const chunkEnd = chunkStart + plaintext.length - 1;
  const lo = Math.max(start, chunkStart);
  const hi = Math.min(end, chunkEnd);
  if (hi < lo) return new Uint8Array(0);
  return plaintext.subarray(lo - chunkStart, hi - chunkStart + 1);
}
```

- [ ] **Step 5: Run the `chunkSlice` tests to verify they pass**

Run: `npm test --prefix D:\Projects\dragonfox-drive\web -- src/sw/logic.test.ts`
Expected: the `chunkSlice` tests now PASS. The streaming-order test still FAILS (body is not yet a stream).

- [ ] **Step 6: Rewrite the body construction inside `handleStreamRequest`**

In `web/src/sw/logic.ts`, replace the **entire** current `handleStreamRequest` function (the version from Task 1) with:

```ts
/** Serve a Range request: fetch+decrypt the covering chunks (cached), stream the
 *  requested window chunk-by-chunk, and respond 206/200. The response is capped
 *  to `segmentBytes` so the browser re-requests the next segment as playback
 *  advances, instead of pulling the whole file up front. */
export async function handleStreamRequest(
  req: StreamRequestLike,
  meta: StreamMeta,
  cache: LruCache,
  fetcher: ChunkFetcher,
  segmentBytes: number = STREAM_SEGMENT_BYTES,
): Promise<Response> {
  const rangeHeader = req.headers.get("range") ?? "";
  const hasRange = !!rangeHeader;
  const { start, end } = parseRange(rangeHeader, meta.size);
  const effectiveEnd = Math.min(end, start + segmentBytes - 1, meta.size - 1);
  const { firstIdx, lastIdx } = chunksCovering(start, effectiveEnd, meta.size, meta.chunkSize);
  const length = effectiveEnd - start + 1;
  const isPartial = hasRange || effectiveEnd < meta.size - 1;

  async function getPlain(idx: number): Promise<Uint8Array> {
    const key = `${meta.fileId}:${idx}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const cipher = await fetcher(idx);
    const pt = await decryptChunkSubtle(meta.fileKey, meta.ivBase, idx, cipher);
    cache.set(key, pt);
    return pt;
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let idx = firstIdx; idx <= lastIdx; idx++) {
          const pt = await getPlain(idx);
          const slice = chunkSlice(pt, idx, meta.chunkSize, start, effectiveEnd);
          if (slice.length) controller.enqueue(slice);
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  const headers = new Headers({
    "Content-Type": meta.mime,
    "Accept-Ranges": "bytes",
    "Content-Length": String(length),
  });
  if (isPartial) {
    headers.set("Content-Range", `bytes ${start}-${effectiveEnd}/${meta.size}`);
  }
  return new Response(body, { status: isPartial ? 206 : 200, headers });
}
```

Note: `sliceRange` is no longer called inside `handleStreamRequest`, but it stays exported with its own tests (no change) — the diff stays surgical and the helper remains available.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test --prefix D:\Projects\dragonfox-drive\web -- src/sw/logic.test.ts`
Expected: all tests PASS, including:
- The streaming-order test (3 chunks, correct bytes).
- Task 1's capping tests (status/headers identical; `calls` assertions still hold because the existing tests drain the body via `await res.arrayBuffer()` before asserting `calls`, and the no-Range `size=3` test still gets 200 because `size ≤ cap`).
- The pre-existing `bytes=2-5` test (drains via `arrayBuffer`, gets `[3,4,5,6]`, `calls === 2`).

- [ ] **Step 8: Run the full suite + typecheck**

Run: `npm test --prefix D:\Projects\dragonfox-drive\web`
Run: `npm run typecheck --prefix D:\Projects\dragonfox-drive\web`
Expected: full suite green; no type errors.

- [ ] **Step 9: Commit**

```bash
git add web/src/sw/logic.ts web/src/sw/logic.test.ts
git commit -m "feat(sw): stream video responses chunk-by-chunk via ReadableStream"
```

---

### Task 3: Cancel in-flight chunk fetches when the browser aborts

**Files:**
- Modify: `web/src/sw/logic.ts` (extend `ChunkFetcher` type; thread an `AbortController` through `handleStreamRequest`)
- Modify: `web/src/sw/sw.ts` (`makeFetcher` passes `signal` to `fetch()`)
- Test: `web/src/sw/logic.test.ts` (add a cancel test)

**Interfaces:**
- Produces: `ChunkFetcher = (idx: number, signal?: AbortSignal) => Promise<Uint8Array>`; `handleStreamRequest` now wires a per-response `AbortController` whose `cancel()` aborts the fetcher.
- Consumes: nothing new.

When the user seeks, the browser aborts the old response (it stops reading `res.body`). We surface that as `cancel()` on our `ReadableStream`, which aborts the `AbortController`, which aborts the in-flight `fetch()`. Without this, rapid seeking leaves orphaned chunk downloads running to completion.

- [ ] **Step 1: Write the failing cancel test**

In `web/src/sw/logic.test.ts`, inside `describe("sw logic: request handling", () => { … })` (after the streaming-order test, before the closing `});`), add:

```ts
  it("handleStreamRequest aborts the in-flight fetch and halts the loop when the body is cancelled", async () => {
    const chunkSize = 4;
    const size = 20; // 5 chunks
    const signals: (AbortSignal | undefined)[] = [];
    const fetcher: ChunkFetcher = (idx, signal) => {
      signals[idx] = signal;
      // Never resolves on its own — only rejects when the signal aborts.
      return new Promise<Uint8Array>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    const cache = new L2(1024);
    const meta = mkMeta({ size, chunkCount: 5, chunkSize });
    const req = { url: "/api/stream/f1", headers: new Headers({ range: "bytes=0-" }) };
    const res = await handleStreamRequest(req, meta, cache, fetcher, 8);
    // start() reached chunk 0 synchronously during stream construction:
    expect(signals[0]).toBeDefined();
    expect(signals[1]).toBeUndefined(); // loop is blocked on chunk 0, hasn't advanced
    await res.body!.cancel();
    await new Promise((r) => setTimeout(r, 0)); // let the abort reject propagate
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]).toBeUndefined(); // loop halted — chunk 1 never requested
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix D:\Projects\dragonfox-drive\web -- src/sw/logic.test.ts`
Expected: the cancel test FAILS — `signals[0]` is `undefined` because Task 2's `ChunkFetcher` does not pass a signal (`fetcher(idx)` only), so the fetcher never receives one. (A timeout may also occur because the never-resolving fetcher leaves the test hanging; vitest's default 5s test timeout will surface it as a failure.)

- [ ] **Step 3: Extend the `ChunkFetcher` type**

In `web/src/sw/logic.ts`, find the existing `ChunkFetcher` type definition (the line `export type ChunkFetcher = (idx: number) => Promise<Uint8Array>; // returns ciphertext`) and replace it with:

```ts
export type ChunkFetcher =
  (idx: number, signal?: AbortSignal) => Promise<Uint8Array>; // returns ciphertext
```

- [ ] **Step 4: Wire the `AbortController` into `handleStreamRequest`**

In `web/src/sw/logic.ts`, replace the **entire** current `handleStreamRequest` function (the Task 2 version) with:

```ts
/** Serve a Range request: fetch+decrypt the covering chunks (cached), stream the
 *  requested window chunk-by-chunk, and respond 206/200. The response is capped
 *  to `segmentBytes` so the browser re-requests the next segment as playback
 *  advances, instead of pulling the whole file up front. If the consumer aborts
 *  the response (seek / navigate away), the in-flight chunk fetch is cancelled. */
export async function handleStreamRequest(
  req: StreamRequestLike,
  meta: StreamMeta,
  cache: LruCache,
  fetcher: ChunkFetcher,
  segmentBytes: number = STREAM_SEGMENT_BYTES,
): Promise<Response> {
  const rangeHeader = req.headers.get("range") ?? "";
  const hasRange = !!rangeHeader;
  const { start, end } = parseRange(rangeHeader, meta.size);
  const effectiveEnd = Math.min(end, start + segmentBytes - 1, meta.size - 1);
  const { firstIdx, lastIdx } = chunksCovering(start, effectiveEnd, meta.size, meta.chunkSize);
  const length = effectiveEnd - start + 1;
  const isPartial = hasRange || effectiveEnd < meta.size - 1;

  async function getPlain(idx: number, signal: AbortSignal): Promise<Uint8Array> {
    const key = `${meta.fileId}:${idx}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const cipher = await fetcher(idx, signal);
    const pt = await decryptChunkSubtle(meta.fileKey, meta.ivBase, idx, cipher);
    cache.set(key, pt);
    return pt;
  }

  const ac = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let idx = firstIdx; idx <= lastIdx; idx++) {
          if (ac.signal.aborted) return;
          const pt = await getPlain(idx, ac.signal);
          if (ac.signal.aborted) return;
          const slice = chunkSlice(pt, idx, meta.chunkSize, start, effectiveEnd);
          if (slice.length) controller.enqueue(slice);
        }
        controller.close();
      } catch (e) {
        // Swallow the rejection if WE caused it via cancel(); only surface
        // unexpected errors to the stream consumer.
        if (!ac.signal.aborted) controller.error(e);
      }
    },
    cancel() { ac.abort(); },
  });

  const headers = new Headers({
    "Content-Type": meta.mime,
    "Accept-Ranges": "bytes",
    "Content-Length": String(length),
  });
  if (isPartial) {
    headers.set("Content-Range", `bytes ${start}-${effectiveEnd}/${meta.size}`);
  }
  return new Response(body, { status: isPartial ? 206 : 200, headers });
}
```

- [ ] **Step 5: Run the cancel test to verify it passes**

Run: `npm test --prefix D:\Projects\dragonfox-drive\web -- src/sw/logic.test.ts`
Expected: the cancel test now PASSES (`signals[0].aborted === true`, `signals[1]` undefined). All other tests still pass (existing fetcher mocks are `async (idx) => …`, which still satisfy the new optional-`signal` arity).

- [ ] **Step 6: Thread the signal through `makeFetcher` in the SW**

In `web/src/sw/sw.ts`, find the `makeFetcher` function (the block starting `function makeFetcher(meta: StreamMeta): ChunkFetcher {`). Replace the whole function with:

```ts
function makeFetcher(meta: StreamMeta): ChunkFetcher {
  return async (idx, signal) => {
    const url = `/api/files/${meta.fileId}/chunks/${idx}`;
    const doFetch = (tok: string) => fetch(url, { headers: { Authorization: `Bearer ${tok}` }, signal });
    let resp = await doFetch(meta.token);
    if (resp.status === 401) {
      const fresh = await requestFreshToken(meta.fileId);
      if (fresh) { meta.token = fresh; resp = await doFetch(fresh); }
    }
    if (!resp.ok) throw new Error(`chunk ${idx} fetch failed: ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  };
}
```

The only change from the original is `(idx, signal)` in the signature and `signal` added to both `fetch()` options (via `doFetch`).

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npm test --prefix D:\Projects\dragonfox-drive\web`
Run: `npm run typecheck --prefix D:\Projects\dragonfox-drive\web`
Expected: full suite green; no type errors. (`makeFetcher` is not directly unit-tested — it is exercised by the manual smoke test below — but TypeScript confirms its signature now matches the extended `ChunkFetcher`.)

- [ ] **Step 8: Commit**

```bash
git add web/src/sw/logic.ts web/src/sw/sw.ts web/src/sw/logic.test.ts
git commit -m "feat(sw): cancel in-flight chunk fetches on seek/abort"
```

- [ ] **Step 9: Manual smoke test**

1. Start the backend: `cargo run --manifest-path server\Cargo.toml`.
2. Start the frontend: `npm run dev --prefix web`. Open the printed URL (localhost:5173).
3. In DevTools → Application → Service Workers, **Unregister** any stale SW, then hard-reload (Ctrl+Shift+R) so the new SW activates.
4. Upload or open an encrypted video larger than ~16 MiB. Play it.
5. In DevTools → Network (filtered to `stream`), confirm a sequence of `GET /api/stream/:id` **206** responses, each `Content-Length` ≈ 16 MiB, with advancing `Content-Range` (`bytes 0-16777215/…`, then `bytes 16777216-33554431/…`, …) — NOT one giant response.
6. Seek forward abruptly: the old request's status should show "(canceled)" and a new 206 at the seek target should appear.
7. In DevTools → Performance Monitor, confirm JS heap size stays flat during playback (no climb toward the file size).

---

### Task 4: Sync `docs/streaming.md` with the new behavior

**Files:**
- Modify: `docs/streaming.md` (pipeline diagram lines 40-53; "Known limitations" lines 173-183)

The current doc describes the old "fetch all covering chunks, then respond" behavior and lists "v1 range assembly" as a limitation — both now obsolete. This task updates the doc to match Tasks 1-3. No code; no tests.

- [ ] **Step 1: Update the pipeline diagram**

In `docs/streaming.md`, find the SW box in the pipeline overview (the block starting `│  1. parse Range: bytes=start-end` and ending at the `│  5. respond:` line, just before the closing `└────…┘` of that box). Replace those 5 numbered lines with:

```
│  1. parse Range: bytes=start-end   (end ∅ ⇒ EOF, clamp size-1)  │
│  2. CAP the window to STREAM_SEGMENT_BYTES (16 MiB):             │
│       effectiveEnd = min(end, start + 16 MiB - 1, size - 1)      │
│  3. firstIdx = ⌊start / 4 MiB⌋ ; lastIdx = ⌊effectiveEnd / 4 MiB⌋│
│  4. ReadableStream (one slice per chunk, in order):              │
│       LRU(256 MiB) hit  ⇒ reuse plaintext                        │
│       miss ⇒ fetch /api/files/:id/chunks/:idx (Bearer, signal)   │
│             ⇒ crypto.subtle AES-GCM decrypt(iv = chunkIv(        │
│               ivBase, idx))  ⇒ store in LRU                      │
│       enqueue chunkSlice(chunk, …, start, effectiveEnd)          │
│     (on consumer abort ⇒ AbortController cancels the fetch)      │
│  5. respond: 206 + Content-Range + Content-Length                │
│              (200 only when the file fits in one segment AND no  │
│               Range header was sent)                             │
```

- [ ] **Step 2: Replace the obsolete "v1 range assembly" limitation**

In `docs/streaming.md`, find the "Known limitations" section. Replace the bullet that starts `- **v1 range assembly** buffers the covering chunks…` (the one ending `…pipe-assembly for pathological huge Ranges is deferred.`) with these two bullets:

```markdown
- **Segmented read-ahead.** Each `/api/stream/:id` response is capped to
  `STREAM_SEGMENT_BYTES` (16 MiB). The browser's native media engine issues
  follow-up `Range` requests as the buffer drains, so only the bytes needed
  for current playback are fetched+decrypted — the whole file is never
  pulled at once. The body is a `ReadableStream` emitting one chunk slice at
  a time, so SW memory stays flat regardless of file size.
- **Abort on seek.** When the browser aborts a response (seek / navigate),
  the SW's per-response `AbortController` cancels the in-flight chunk
  `fetch()`, so rapid seeking doesn't leave orphan downloads.
```

- [ ] **Step 3: Commit**

```bash
git add docs/streaming.md
git commit -m "docs: streaming read-ahead segments + abort-on-seek"
```

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- §3.1 `STREAM_SEGMENT_BYTES` → Task 1 Step 3. ✓
- §3.2 `chunkSlice` → Task 2 Step 4. ✓
- §3.3 `ChunkFetcher` signal → Task 3 Step 3. ✓
- §3.4 `handleStreamRequest` rewrite (cap + stream + cancel) → Task 1 (cap) → Task 2 (stream) → Task 3 (cancel), built incrementally so each task ships. ✓
- §4 `sw.ts` `makeFetcher` → Task 3 Step 6. ✓
- §5 "what does NOT change" → `parseRange`/`chunkIv`/`chunksCovering`/`sliceRange`/`LruCache`/`matchStreamId`/`applySwMessage` untouched; no task modifies them. ✓
- §6 testing plan → Task 1 (cap + count + LRU reuse + no-Range-large), Task 2 (`chunkSlice` unit + streaming order), Task 3 (cancel). Existing `bytes=2-5` + no-Range `size=3` tests asserted unchanged in Task 1 Step 5 / Task 2 Step 7. ✓
- §7 manual smoke test → Task 3 Step 9. ✓

**Placeholder scan** — no TBD/TODO/"add error handling"/"similar to". Every code step contains the full code; every command includes expected output.

**Type consistency** — `chunkSlice(plaintext, idx, chunkSize, start, end)` signature is identical in Task 2 Step 4 (definition) and Step 6 (call site: `chunkSlice(pt, idx, meta.chunkSize, start, effectiveEnd)`). `ChunkFetcher` arity `(idx, signal?)` is consistent across Task 3 Step 3 (type), Step 4 (`fetcher(idx, signal)`), Step 6 (`makeFetcher` returns `async (idx, signal) =>`), and all test mocks. `STREAM_SEGMENT_BYTES` referenced identically in Task 1 Step 3 (definition) and Step 4 (default param).
