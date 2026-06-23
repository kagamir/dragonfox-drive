# On-Demand Video Streaming (Segmented Read-Ahead) — Design

Status: approved (2026-06-23)
Implements: a fix to the P2b SW-proxy streaming path. The P2b design
(`2026-06-23-p2b-sw-video-streaming-design.md`) assumed "browser Range
requests are typically a few MB, bounded" (`docs/streaming.md:177`). In
practice `<video>` opens playback with `Range: bytes=0-` (open-ended),
which `parseRange` maps to `end = size - 1` — i.e. **the whole file**.
`handleStreamRequest` then fetches+decrypts every chunk and materializes
the entire plaintext before responding. For a 2 GiB / 4 MiB-chunk video
that is 512 fetch+decrypt cycles up front, all in memory, over one
response. This spec makes playback load **only the bytes the browser is
ready to consume**, one bounded segment at a time.

## 1. Goal & scope

Large encrypted videos must buffer on demand (a read-ahead window), not
download the whole file up front. Memory stays flat regardless of file
size; seeking works as before (byte-exact, LRU-cached).

**In scope**
- Cap each `/api/stream/:id` response to a bounded byte window
  (`STREAM_SEGMENT_BYTES`, default 16 MiB = 4 chunks).
- Stream the response body chunk-by-chunk through a `ReadableStream`
  instead of materializing the whole segment.
- Cancel in-flight chunk fetches when the browser aborts the response
  (seek / navigate away).
- Keep the approach **purely reactive** (browser-driven Range requests).
  No proactive background prefetch in v1.

**Out of scope (deferred)**
- Proactive read-ahead (SW tracks playback progress and prefetches the
  next segment). Adds cancellation/lifecycle complexity; the browser's
  own Range re-requests already keep playback smooth.
- ReadableByteStream / explicit backpressure. Each segment is ≤ ~5
  chunks; the simple `start`-loop enqueue strategy is safe at that size.
- Persistent plaintext cache (still memory-only by design).
- MSE / `SourceBuffer` (rejected in P2b; native `<video>` retained).

## 2. Key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Buffering model | **Reactive, browser-driven Range** | Native `<video>` already issues follow-up Range requests when it exhausts a bounded 206. Simplest correct design; composes with the existing LRU. |
| Segment size | **16 MiB (`4 × SW_CHUNK_SIZE`)** | ≈ 25 s of 1080p @ 5 Mbps — enough headroom to absorb network jitter without re-request stalls, small enough to be genuinely on-demand. Whole-chunk multiple avoids partial-chunk edge math. Tunable via one constant. |
| Where to cap | **Inside `handleStreamRequest`, not `parseRange`** | `parseRange` stays a pure parser (its tests unchanged); capping is a serving-policy concern layered on top. |
| No-Range + small file | **200, full body** (unchanged) | When `size ≤ STREAM_SEGMENT_BYTES` a no-Range request still returns the whole file as 200 — backward-compatible with the existing `size=3` test. |
| No-Range + large file | **206, capped prefix** | A streaming endpoint must never dump a whole large file on a no-Range GET; 206 + `Content-Range` is the spec-compliant way to return partial content. |
| Body construction | **`ReadableStream` enqueuing per-chunk slices** | Memory: at most one chunk plaintext + LRU entries resident. `Content-Length` is known up front (clamped range), so the streaming body + fixed `Content-Length` header is well-defined. |
| Cancellation | **`AbortController` per response; `ChunkFetcher` gains optional `signal`** | Seeking aborts the old response → SW stops fetching the now-irrelevant segment. Prevents orphan fetches on rapid seek. Signal is optional so existing fetcher-based tests don't change. |

## 3. Changes to `web/src/sw/logic.ts`

### 3.1 New constant

```ts
export const STREAM_SEGMENT_BYTES = 4 * SW_CHUNK_SIZE; // 16 MiB per response
```

### 3.2 New pure helper `chunkSlice`

Returns the subarray of one decrypted chunk that falls inside the
absolute byte range `[start..end]`. Replaces the multi-chunk
`sliceRange` call inside the hot path (the streaming loop emits one
slice per chunk):

```ts
export function chunkSlice(
  plaintext: Uint8Array,
  idx: number,
  chunkSize: number,
  start: number,
  end: number,
): Uint8Array {
  const chunkStart = idx * chunkSize;
  const chunkEnd = chunkStart + plaintext.length - 1; // tail chunk may be short
  const lo = Math.max(start, chunkStart);
  const hi = Math.min(end, chunkEnd);
  if (hi < lo) return new Uint8Array(0);
  return plaintext.subarray(lo - chunkStart, hi - chunkStart + 1);
}
```

`sliceRange` is kept (still exported, still tested) — nothing else
depends on its removal and the diff stays surgical.

### 3.3 `ChunkFetcher` signature

Add an optional `AbortSignal` (optional so tests that ignore it are
unchanged):

```ts
export type ChunkFetcher =
  (idx: number, signal?: AbortSignal) => Promise<Uint8Array>;
```

### 3.4 `handleStreamRequest` rewrite

```ts
export async function handleStreamRequest(
  req: StreamRequestLike,
  meta: StreamMeta,
  cache: LruCache,
  fetcher: ChunkFetcher,
): Promise<Response> {
  const rangeHeader = req.headers.get("range") ?? "";
  const hasRange = !!rangeHeader;
  let { start, end } = parseRange(rangeHeader, meta.size);

  // --- cap the response to one segment ---
  const cap = STREAM_SEGMENT_BYTES;
  const effectiveEnd = Math.min(end, start + cap - 1, meta.size - 1);
  const length = effectiveEnd - start + 1;
  const isPartial = hasRange || effectiveEnd < meta.size - 1;
  const status = isPartial ? 206 : 200;

  const { firstIdx, lastIdx } =
    chunksCovering(start, effectiveEnd, meta.size, meta.chunkSize);

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
    start(controller) {
      (async () => {
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
          if (!ac.signal.aborted) controller.error(e);
        }
      })();
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
  return new Response(body, { status, headers });
}
```

**Behavior table** (the contract this function now guarantees):

| Request                               | `start` | `effectiveEnd` | status | body                |
|---------------------------------------|---------|----------------|--------|---------------------|
| `Range: bytes=2-5` (small)            | 2       | 5              | 206    | 4 B, unchanged      |
| `Range: bytes=0-` on 2 GiB file       | 0       | cap-1          | 206    | first 16 MiB        |
| `Range: bytes=K-` (mid-file seek)     | K       | K+cap-1        | 206    | 16 MiB from K       |
| no Range, `size ≤ cap`                | 0       | size-1         | 200    | whole file          |
| no Range, `size > cap`                | 0       | cap-1          | 206    | first 16 MiB        |

## 4. Changes to `web/src/sw/sw.ts`

One line in `makeFetcher` — pass the signal through to `fetch`:

```ts
const doFetch = (tok: string, signal?: AbortSignal) =>
  fetch(url, { headers: { Authorization: `Bearer ${tok}` }, signal });
let resp = await doFetch(meta.token, signal);
if (resp.status === 401) {
  const fresh = await requestFreshToken(meta.fileId);
  if (fresh) { meta.token = fresh; resp = await doFetch(fresh, signal); }
}
```

The fetch handler in `sw.ts` that calls `handleStreamRequest` is
unchanged — the `Response` it returns now simply carries a streaming
body, which the browser drains transparently (the backend is never
involved: the SW intercepts `/api/stream/:id`).

## 5. What does NOT change

- `parseRange`, `chunkIv`, `chunksCovering`, `sliceRange`, `LruCache`,
  `matchStreamId`, `applySwMessage` — signatures and tests untouched.
- `STREAMING_CAPS`, the 256 MiB LRU budget, the page↔SW message
  protocol, `files.ts` preview store, the SW `fetch`/`message` routing.
- The `/api/stream/:id` URL contract and `docs/api.md`.

## 6. Testing plan

All tests in `web/src/sw/logic.test.ts` unless noted.

**New — `chunkSlice` unit tests:**
- Middle chunk returned whole (range fully covers it).
- First chunk partial from the right; last chunk partial from the left.
- Zero overlap → empty `Uint8Array`.
- Tail chunk shorter than `chunkSize` (last chunk of a file).

**New — `handleStreamRequest` behavior:**
- `Range: bytes=0-` on a multi-chunk file larger than `cap` → status 206,
  `Content-Range: bytes 0-(cap-1)/size`, `Content-Length == cap`, and
  the fetcher is called for **only** the chunks covering `[0..cap-1]`
  (assert via a call counter — the bug being fixed would call every
  chunk).
- Second segment: `Range: bytes=cap-` → 206,
  `Content-Range: bytes cap-(2*cap-1)/size`; fetcher called only for
  the next chunk set; chunks reused from the first segment hit the LRU
  (no re-fetch at the boundary).
- Streaming order: reading `res.body` yields chunk slices in ascending
  byte order, concatenating to exactly the requested range.
- Cancel: after obtaining the response, call
  `res.body.cancel()`; the fetcher's mock records an aborted
  `AbortSignal` (`signal.aborted === true`) and no further chunks are
  requested after the cancel.

**Existing tests that must still pass unmodified:**
- `parseRange supports bytes=start-end and open-ended, clamped to size`.
- `handleStreamRequest returns 206 with exact bytes and caches`
  (`bytes=2-5` is below the cap → identical output, identical fetch count).
- `handleStreamRequest returns 200 when there is no Range header`
  (`size=3 ≤ cap` → still 200, full body).

**Manual smoke test** (documented in `docs/streaming.md`): open a
> 256 MiB encrypted video in dev; Network tab should show a sequence of
`/api/stream/:id` 206 responses of `Content-Length` ≈ 16 MiB advancing
with playback, not one giant response; seeking forward issues a new 206
at the seek target; the page's memory footprint stays flat in DevTools
Performance Monitor.

## 7. Risks & mitigations

- **Browser doesn't re-request after a capped 206.** All modern engines
  (Chrome/Firefox/Safari/Edge) treat `Content-Range` + `Accept-Ranges`
  as a segmented resource and issue follow-up Ranges as the buffer
  drains. This is identical to how every HTTP video CDN behaves. The
  manual smoke test above validates it empirically.
- **Cap too small → stalls on high-bitrate/slow links.** 16 MiB ≈ 25 s
  of 1080p @ 5 Mbps; the constant is exported and one-line tunable. If
  stalls appear, raise to 8× chunk size (32 MiB) without code changes.
- **`controller.error` after cancel.** Guarded by `!ac.signal.aborted`
  so an already-canceled stream is not errored post-hoc.
- **Rapid seeking spawns overlapping fetches.** Mitigated by per-response
  `AbortController` + `cancel()`; a seek aborts the prior segment's
  in-flight chunk fetch via `fetch(url, { signal })`.
