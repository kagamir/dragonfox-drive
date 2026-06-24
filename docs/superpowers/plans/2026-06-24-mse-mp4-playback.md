# MSE + mp4box.js MP4 Playback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the P2b Service-Worker streaming path with a MediaSource-Extensions player driven by mp4box.js, so MP4 video (including fragmented / moov-at-end / missing-duration files) streams reliably in Chrome and Firefox without loading the whole file.

**Architecture:** `<video>` reads from a `MediaSource`. A new in-page player (mp4box.js) demuxes the MP4 and feeds MSE init/media segments; a new `chunkbuf` module fetches encrypted chunks (`/api/files/:id/chunks/:idx`) and decrypts them via the crypto worker to satisfy the byte ranges mp4box requests. The entire SW streaming path (`/api/stream/:id`, `sw.ts`, `logic.ts`, SW registration, `vite-plugin-pwa`) is deleted. Backend unchanged.

**Tech Stack:** TypeScript, Vue 3, mp4box.js (new dep), MediaSource Extensions, WebCrypto (via existing crypto worker), Vitest + happy-dom.

## Global Constraints

- Zero-trust: plaintext exists only transiently in page/worker memory. The player fetches encrypted chunks and decrypts in-page; no plaintext URL is ever exposed.
- Reuse the existing chunk crypto model: `filesApi.getChunk(id, idx)` + `cryptoApi.decryptChunk(fileKey, ivBase, idx, cipher)` (the crypto worker computes the per-chunk IV internally). Do NOT introduce a second AES-GCM path.
- mp4box.js is the canonical ISO-BMFF demuxer; MP4/QuickTime/fragmented-MP4 only (the scope). Non-MP4 video falls back to blob-or-download.
- Decrypted chunks are cached in a 256 MiB LRU (reuse `LruCache`). The file is never fully loaded — mp4box parses incrementally (no large-file OOM).
- Each task must leave the project compiling (`npm run typecheck --prefix web`) and tests green (`npm run test --prefix web`). Frontend-only changes; backend untouched.
- Follow existing patterns: Pinia setup stores, Comlink crypto worker, `vi.hoisted`/`vi.mock` for store tests, inline Vitest for pure modules.
- The moov-at-end detection (`videoprobe.ts`, `manifest.streamable`, upload warning, openVideo block) is removed — MSE handles moov position natively, making it obsolete.
- Verify after each task: `npm run typecheck --prefix web` and `npm run test --prefix web`.

---

## File Structure

**New:**
- `web/src/player/chunkbuf.ts` — pure fns (`chunksCovering`, `chunkSlice`, `LruCache`, copied from `logic.ts`) + `createChunkBuffer()` → `{ fetchRange(start,end) }`. Decrypted byte-range fetcher. Unit-testable.
- `web/src/player/msePlayer.ts` — mp4box.js + MSE orchestration: `playMp4(video, buf, onError)` + `dispose()`.
- `web/src/components/Mp4Player.vue` — `<video>` wrapper that mounts `msePlayer` + a `chunkbuf`.

**Modify:**
- `web/package.json` — add `mp4box.js`.
- `web/src/components/FilePreviewModal.vue` — render `Mp4Player` when the preview carries a player payload.
- `web/src/stores/files.ts` — `openVideo` routes MP4 → MSE payload; non-MP4 → blob/download; preview type gains an optional `player` payload; drop SW refs.
- `web/src/stores/files.test.ts` — drop SW mocks; cover MSE routing.

**Delete (SW retirement + moov-detection removal):**
- `web/src/sw/` (whole dir: `sw.ts`, `logic.ts`, `register.ts`, `logic.test.ts`, `register.test.ts`).
- `web/src/crypto/videoprobe.ts` + `videoprobe.test.ts`.
- `web/vite.config.ts` `VitePWA` block.
- `web/src/main.ts` `ensureStreamSw` import + call.
- `manifest.streamable` field (crypto/file.ts), the upload probe/warning, the openVideo `streamable` block.

---

## Task 1: chunkbuf module + mp4box.js dep

**Files:**
- Modify: `web/package.json` (add `mp4box.js`)
- Create: `web/src/player/chunkbuf.ts`
- Create: `web/src/player/chunkbuf.test.ts`

**Interfaces:**
- Produces: `createChunkBuffer({fileId, fileKey, ivBase, chunkSize, totalSize}) → { fetchRange(start, end): Promise<Uint8Array> }`; pure fns `chunksCovering`, `chunkSlice`, `LruCache` (consumed by Task 2).

- [ ] **Step 1: Add the dependency**

Run:
```bash
npm install --prefix web mp4box.js@^0.5.3
```
(If that version is unavailable, install the latest `mp4box.js` and pin whatever resolves; it is the only new dep.)

- [ ] **Step 2: Write the failing tests**

Create `web/src/player/chunkbuf.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const { getChunkMock, decryptMock } = vi.hoisted(() => ({
  getChunkMock: vi.fn(),
  decryptMock: vi.fn(),
}));

vi.mock("@/api/files", () => ({
  filesApi: { getChunk: getChunkMock },
}));
vi.mock("@/workers/crypto", () => ({
  cryptoApi: { decryptChunk: decryptMock },
  ensureCryptoReady: vi.fn().mockResolvedValue(undefined),
}));

import {
  createChunkBuffer,
  chunksCovering,
  chunkSlice,
  LruCache,
} from "./chunkbuf";

describe("chunkbuf pure fns (copied from sw/logic)", () => {
  it("chunksCovering maps a byte range to chunk indices, clamped to size", () => {
    const sz = 4 * 4 + 10;
    expect(chunksCovering(0, 100, sz)).toEqual({ firstIdx: 0, lastIdx: 0 });
    expect(chunksCovering(0, sz - 1, sz)).toEqual({ firstIdx: 0, lastIdx: 3 });
    expect(chunksCovering(4 + 1, 4 * 2, sz)).toEqual({ firstIdx: 1, lastIdx: 2 });
  });

  it("chunkSlice returns the overlap of one chunk with the absolute range", () => {
    const a = new Uint8Array([1, 2, 3, 4]); // idx 0 → abs bytes 0..3 (chunkSize 4)
    expect(Array.from(chunkSlice(a, 0, 4, 0, 3))).toEqual([1, 2, 3, 4]);
    expect(Array.from(chunkSlice(a, 0, 4, 2, 9))).toEqual([3, 4]);
    expect(Array.from(chunkSlice(a, 0, 4, 5, 9))).toEqual([]);
  });

  it("LruCache evicts over its byte budget", () => {
    const c = new LruCache(10);
    c.set("a", new Uint8Array(4));
    c.set("b", new Uint8Array(4));
    c.set("c", new Uint8Array(4)); // 12 > 10 ⇒ evict "a"
    expect(c.has("a")).toBe(false);
    expect(c.has("c")).toBe(true);
  });
});

describe("createChunkBuffer.fetchRange", () => {
  const KEY = new Uint8Array(32);
  const IV = new Uint8Array(12);

  beforeEach(() => {
    getChunkMock.mockReset();
    decryptMock.mockReset();
  });

  it("fetches covering chunks, decrypts, slices, and assembles the exact range", async () => {
    // 2 chunks of 4 bytes; file size 8. Request [2..5].
    const buf = createChunkBuffer({
      fileId: "f1", fileKey: KEY, ivBase: IV, chunkSize: 4, totalSize: 8,
    });
    // chunk0 plain = [1,2,3,4], chunk1 plain = [5,6,7,8]
    getChunkMock.mockImplementation((_id: string, idx: number) =>
      Promise.resolve(new Response(new Uint8Array([idx]))));
    decryptMock.mockImplementation(async (_k: unknown, _iv: unknown, idx: number) =>
      idx === 0 ? new Uint8Array([1, 2, 3, 4]) : new Uint8Array([5, 6, 7, 8]));

    const out = await buf.fetchRange(2, 5);
    expect(Array.from(out)).toEqual([3, 4, 5, 6]); // chunk0→[3,4], chunk1→[5,6]
    expect(getChunkMock).toHaveBeenCalledWith("f1", 0);
    expect(getChunkMock).toHaveBeenCalledWith("f1", 1);
  });

  it("caches decrypted chunks across range calls", async () => {
    const buf = createChunkBuffer({
      fileId: "f1", fileKey: KEY, ivBase: IV, chunkSize: 4, totalSize: 8,
    });
    getChunkMock.mockResolvedValue(new Response(new Uint8Array([0])));
    decryptMock.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    await buf.fetchRange(0, 3);
    await buf.fetchRange(0, 3); // same chunk → cache hit
    expect(getChunkMock).toHaveBeenCalledTimes(1);
  });

  it("clamps end to totalSize - 1 (short tail chunk)", async () => {
    const buf = createChunkBuffer({
      fileId: "f1", fileKey: KEY, ivBase: IV, chunkSize: 4, totalSize: 6,
    });
    getChunkMock.mockResolvedValue(new Response(new Uint8Array([0])));
    // tail chunk idx 1 has 2 bytes
    decryptMock.mockImplementation(async (_k: unknown, _iv: unknown, idx: number) =>
      idx === 0 ? new Uint8Array([1, 2, 3, 4]) : new Uint8Array([5, 6]));
    const out = await buf.fetchRange(3, 9999); // end way past EOF
    expect(Array.from(out)).toEqual([4, 5, 6]); // chunk0 tail [4], chunk1 [5,6]
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test --prefix web -- chunkbuf`
Expected: FAIL — cannot resolve `./chunkbuf`.

- [ ] **Step 4: Implement `chunkbuf.ts`**

Create `web/src/player/chunkbuf.ts` (the pure fns are copied verbatim from `web/src/sw/logic.ts`; `logic.ts` keeps its own copies until the SW is deleted in Task 6):

```ts
/**
 * In-page decrypted byte-range fetcher for the MSE player.
 *
 * Given a byte range [start..end] of the plaintext file, fetches the covering
 * encrypted chunks (`/api/files/:id/chunks/:idx`), decrypts each via the crypto
 * worker, caches the plaintext in a 256 MiB LRU, and slices out the requested
 * window. Replaces the SW's decrypting byte-range role.
 */

import { filesApi } from "@/api/files";
import { cryptoApi } from "@/workers/crypto";

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

/** Which chunk indices cover the inclusive byte range [start..end] of a file of `size` bytes. */
export function chunksCovering(
  start: number,
  end: number,
  size: number,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): { firstIdx: number; lastIdx: number } {
  const last = size - 1;
  const s = Math.max(0, Math.min(start, last));
  const e = Math.max(s, Math.min(end, last));
  return { firstIdx: Math.floor(s / chunkSize), lastIdx: Math.floor(e / chunkSize) };
}

/** Slice the bytes of decrypted chunk `idx` that fall inside absolute [start..end]. */
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
  private evict(): void {
    for (const [k, v] of this.map) {
      if (this.bytes <= this.budget) break;
      this.map.delete(k);
      this.bytes -= v.length;
    }
  }
}

export interface ChunkBufferOptions {
  fileId: string;
  fileKey: Uint8Array;
  ivBase: Uint8Array;
  chunkSize: number;
  totalSize: number;
}

export interface ChunkBuffer {
  /** Return the plaintext bytes in the inclusive window [start..end] (end clamped to EOF). */
  fetchRange(start: number, end: number): Promise<Uint8Array>;
}

export function createChunkBuffer(opts: ChunkBufferOptions): ChunkBuffer {
  const cache = new LruCache(256 * 1024 * 1024);
  return {
    async fetchRange(start: number, end: number): Promise<Uint8Array> {
      const e = Math.min(end, opts.totalSize - 1);
      const { firstIdx, lastIdx } = chunksCovering(start, e, opts.totalSize, opts.chunkSize);
      const out = new Uint8Array(e - start + 1);
      let off = 0;
      for (let idx = firstIdx; idx <= lastIdx; idx++) {
        const key = `${opts.fileId}:${idx}`;
        let pt = cache.get(key);
        if (!pt) {
          const resp = await filesApi.getChunk(opts.fileId, idx);
          const cipher = new Uint8Array(await resp.arrayBuffer());
          pt = await cryptoApi.decryptChunk(opts.fileKey, opts.ivBase, idx, cipher);
          cache.set(key, pt);
        }
        const slice = chunkSlice(pt, idx, opts.chunkSize, start, e);
        if (slice.length) {
          out.set(slice, off);
          off += slice.length;
        }
      }
      return out;
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test --prefix web -- chunkbuf`
Expected: PASS (8 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck --prefix web`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add web/package.json web/package-lock.json web/src/player/chunkbuf.ts web/src/player/chunkbuf.test.ts
git commit -m "feat(player): chunkbuf — in-page decrypted byte-range fetcher + mp4box.js dep"
```

---

## Task 2: msePlayer (mp4box.js + MSE orchestration)

**Files:**
- Create: `web/src/player/msePlayer.ts`
- Create: `web/src/player/msePlayer.test.ts`

**Interfaces:**
- Consumes: `ChunkBuffer` from Task 1 (`{ fetchRange(start, end) }`).
- Produces: `playMp4(video: HTMLVideoElement, buf: ChunkBuffer, totalSize: number, onError: (e: Error) => void): MseHandle` where `MseHandle = { dispose(): void }`. Consumed by Task 3's `Mp4Player.vue`.

**NOTE on validation:** MediaSource + mp4box.js are not meaningfully exercisable in happy-dom. The test here covers the public surface and disposal against a heavily-mocked `MediaSource`/`MP4Box`. The real playback flow (moov parse, segment flow, seek, fragmented/missing-duration) is verified **manually in Chrome + Firefox** as the primary acceptance for this task.

- [ ] **Step 1: Write the failing test**

Create `web/src/player/msePlayer.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { playMp4 } from "./msePlayer";
import type { ChunkBuffer } from "./chunkbuf";

// MP4Box module mock — just needs createFile() to return a stub.
vi.mock("mp4box", () => ({
  default: { createFile: () => ({ onReady: null, onSegment: null, onError: null }) }),
}));

class FakeSourceBuffer {
  updating = false;
  buffered = { length: 0 } as unknown as TimeRanges;
  appendBuffer = vi.fn(() => { this.updating = false; });
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

class FakeMediaSource {
  readyState = "closed";
  duration = NaN;
  sourceBuffers: FakeSourceBuffer[] = [];
  static isTypeSupported = () => true;
  addSourceBuffer = () => {
    const sb = new FakeSourceBuffer();
    this.sourceBuffers.push(sb);
    return sb;
  };
  endOfStream = vi.fn();
  addEventListener = vi.fn((_: string, cb: () => void) => {
    // Immediately fire sourceopen so the player proceeds.
    this.readyState = "open";
    setTimeout(cb, 0);
  });
  removeEventListener = vi.fn();
}

describe("msePlayer", () => {
  beforeEach(() => {
    (globalThis as unknown as { MediaSource: unknown }).MediaSource = FakeMediaSource;
    (globalThis as unknown as { URL: unknown }).URL = {
      ...URL,
      createObjectURL: vi.fn(() => "blob:ms"),
      revokeObjectURL: vi.fn(),
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { MediaSource?: unknown }).MediaSource;
  });

  it("creates a MediaSource, points the video at it, and returns a dispose handle", async () => {
    const buf: ChunkBuffer = { fetchRange: vi.fn().mockResolvedValue(new Uint8Array(0)) };
    const video = { src: "" } as unknown as HTMLVideoElement;
    const handle = playMp4(video, buf, 100, () => {});
    expect(handle).toBeDefined();
    expect(typeof handle.dispose).toBe("function");
    expect(video.src).toBe("blob:ms");
    expect(() => handle.dispose()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("calls onError if MediaSource is unavailable", () => {
    delete (globalThis as unknown as { MediaSource?: unknown }).MediaSource;
    const buf: ChunkBuffer = { fetchRange: vi.fn() };
    const video = { src: "" } as unknown as HTMLVideoElement;
    const onError = vi.fn();
    playMp4(video, buf, 100, onError);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --prefix web -- msePlayer`
Expected: FAIL — cannot resolve `./msePlayer`.

- [ ] **Step 3: Implement `msePlayer.ts`**

Create `web/src/player/msePlayer.ts`. This mirrors the proven flow from the gpac/mp4box.js demo (`demo/index.js`): feed bytes sequentially → `onReady` adds SourceBuffers + initializes segmentation → after init segments append, `mp4box.start()` + feed from `seek(0)` → `onSegment` appends media segments → on `<video>` seeking, re-feed from `seek(currentTime)`.

```ts
/**
 * MSE + mp4box.js player.
 *
 * mp4box.js demuxes the MP4 (parsing moov/fragments, computing duration,
 * slicing init/media segments); we feed it decrypted byte ranges from a
 * ChunkBuffer and append the segments it emits into a MediaSource that the
 * <video> element reads. Handles progressive MP4, fragmented MP4, moov-at-end,
 * and missing-duration files (mp4box computes duration from sample tables).
 *
 * The flow follows the gpac/mp4box.js demo:
 *   sourceopen → feed(0) → onReady (addSourceBuffer+setSegmentOptions+
 *   initializeSegmentation→append init) → on init updateend → mp4box.start()+
 *   feed(seek(0)) → onSegment (append media) → seeking → feed(seek(t)).
 */

import MP4Box from "mp4box";
import type { ChunkBuffer } from "./chunkbuf";

export interface MseHandle {
  dispose(): void;
}

const FETCH_BYTES = 1 * 1024 * 1024; // bytes fetched per round into mp4box

export function playMp4(
  video: HTMLVideoElement,
  buf: ChunkBuffer,
  totalSize: number,
  onError: (e: Error) => void,
): MseHandle {
  if (typeof MediaSource === "undefined") {
    onError(new Error("MediaSource not supported in this browser"));
    return { dispose() {} };
  }

  const ms = new MediaSource();
  video.src = URL.createObjectURL(ms);
  const mp4box = MP4Box.createFile();

  let disposed = false;
  let initsPending = 0;
  let started = false;
  let feedToken = 0;

  mp4box.onError = (e: unknown) => { if (!disposed) onError(new Error(String(e))); };

  mp4box.onReady = (info: MP4Info) => {
    try {
      ms.duration = info.isFragmented
        ? info.fragment_duration.num / info.fragment_duration.den
        : info.duration / info.timescale;
    } catch { /* leave default */ }
    let added = 0;
    for (const t of info.tracks) {
      const mime = `video/mp4; codecs="${t.codec}"`;
      if (!(MediaSource as unknown as { isTypeSupported(m: string): boolean }).isTypeSupported(mime)) {
        continue;
      }
      const sb = ms.addSourceBuffer(mime);
      (sb as unknown as { id: number }).id = t.id;
      mp4box.setSegmentOptions(t.id, sb as unknown as MP4BoxSegmentUser, { nbSamples: 1000 });
      added++;
    }
    if (added === 0) {
      onError(new Error("No MSE-playable tracks (codec unsupported)"));
      return;
    }
    const initSegs = mp4box.initializeSegmentation() as MP4InitSeg[];
    initsPending = initSegs.length;
    for (const s of initSegs) {
      const sb = s.user as unknown as SourceBuffer;
      sb.addEventListener("updateend", () => onInitAppended(), { once: true });
      sb.appendBuffer(s.buffer);
    }
  };

  function onInitAppended(): void {
    initsPending--;
    if (initsPending > 0 || started || disposed) return;
    started = true;
    mp4box.start();
    const seekInfo = mp4box.seek(0, true) as { offset: number };
    void feed(seekInfo.offset);
  }

  mp4box.onSegment = (id: number, user: unknown, buffer: ArrayBuffer, sampleNum: number, isLast: boolean): void => {
    const sb = user as unknown as SourceBuffer;
    queueAppend(sb, buffer, () => {
      try { mp4box.releaseUsedSamples(id, sampleNum); } catch { /* ignore */ }
      if (isLast) { try { ms.endOfStream(); } catch { /* ignore */ } }
    });
  };

  function queueAppend(sb: SourceBuffer, buffer: ArrayBuffer, after: () => void): void {
    const tryAppend = () => {
      if (disposed) return;
      if (sb.updating) { setTimeout(tryAppend, 10); return; }
      try {
        sb.appendBuffer(buffer);
        sb.addEventListener("updateend", after, { once: true });
      } catch (e) {
        if (!disposed) onError(e as Error);
      }
    };
    tryAppend();
  }

  async function feed(start: number): Promise<void> {
    const myToken = ++feedToken;
    let cursor = start;
    while (!disposed && myToken === feedToken && cursor < totalSize) {
      const end = Math.min(cursor + FETCH_BYTES - 1, totalSize - 1);
      let chunk: Uint8Array;
      try {
        chunk = await buf.fetchRange(cursor, end);
      } catch (e) {
        if (!disposed) onError(e as Error);
        return;
      }
      if (disposed || myToken !== feedToken) return;
      (chunk as unknown as { fileStart: number }).fileStart = cursor;
      let next: number;
      try {
        next = mp4box.appendBuffer(chunk as unknown as ArrayBuffer) as number;
      } catch (e) {
        if (!disposed) onError(e as Error);
        return;
      }
      // mp4box's appendBuffer returns the next file offset it wants (it skips
      // large mdat to find moov, etc.). Use the hint when it advances,
      // otherwise fall back to sequential advance.
      cursor = typeof next === "number" && next > cursor ? next : end + 1;
    }
    if (!disposed && myToken === feedToken) {
      try { mp4box.flush(); } catch { /* ignore */ }
    }
  }

  function onSeeking(): void {
    if (disposed || !started) return;
    const t = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (t >= video.buffered.start(i) && t <= video.buffered.end(i)) return; // already buffered
    }
    const seekInfo = mp4box.seek(t, true) as { offset: number };
    void feed(seekInfo.offset);
  }

  video.addEventListener("seeking", onSeeking);

  ms.addEventListener("sourceopen", () => { void feed(0); });

  return {
    dispose(): void {
      disposed = true;
      video.removeEventListener("seeking", onSeeking);
      try { URL.revokeObjectURL(video.src); } catch { /* ignore */ }
      try { if (ms.readyState === "open") ms.endOfStream(); } catch { /* ignore */ }
    },
  };
}

// --- minimal mp4box.js type shims (the library ships loose types) ----------
interface MP4Info {
  isFragmented: boolean;
  duration: number;
  timescale: number;
  fragment_duration: { num: number; den: number };
  tracks: { id: number; codec: string }[];
}
type MP4BoxSegmentUser = unknown;
interface MP4InitSeg { id: number; buffer: ArrayBuffer; user: unknown; }
```

- [ ] **Step 4: Run the test + typecheck**

Run: `npm run test --prefix web -- msePlayer` then `npm run typecheck --prefix web`
Expected: the 2 surface tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/player/msePlayer.ts web/src/player/msePlayer.test.ts
git commit -m "feat(player): msePlayer — mp4box.js + MediaSource orchestration"
```

---

## Task 3: Mp4Player.vue + FilePreviewModal integration

**Files:**
- Create: `web/src/components/Mp4Player.vue`
- Modify: `web/src/components/FilePreviewModal.vue`
- Modify: `web/src/components/FilePreviewModal.test.ts` (if it references the video branch)

**Interfaces:**
- Consumes: `playMp4` + `MseHandle` from Task 2; `createChunkBuffer` from Task 1.
- Produces: `Mp4Player.vue` with props `{ payload: PlayerPayload; name: string }` and emit `error`. `FilePreviewModal` renders it when a `player` payload is present.

- [ ] **Step 1: Define the shared payload type**

Add to `web/src/player/msePlayer.ts` (append near the other exports, before the type shims is fine — keep it exported):

```ts
/** Everything Mp4Player.vue needs to build a ChunkBuffer and start the player. */
export interface PlayerPayload {
  fileId: string;
  fileKey: Uint8Array;
  ivBase: Uint8Array;
  chunkSize: number;
  totalSize: number;
}
```

- [ ] **Step 2: Implement `Mp4Player.vue`**

Create `web/src/components/Mp4Player.vue`:

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { createChunkBuffer } from "@/player/chunkbuf";
import { playMp4, type MseHandle, type PlayerPayload } from "@/player/msePlayer";

const props = defineProps<{ payload: PlayerPayload; name: string }>();
const emit = defineEmits<{ error: [message: string]; close: [] }>();

const videoEl = ref<HTMLVideoElement | null>(null);
let handle: MseHandle | null = null;

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  if (!videoEl.value) return;
  const buf = createChunkBuffer({
    fileId: props.payload.fileId,
    fileKey: props.payload.fileKey,
    ivBase: props.payload.ivBase,
    chunkSize: props.payload.chunkSize,
    totalSize: props.payload.totalSize,
  });
  handle = playMp4(videoEl.value, buf, props.payload.totalSize, (e) => {
    emit("error", e.message);
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  handle?.dispose();
  handle = null;
});
</script>

<template>
  <div class="preview-backdrop" @click.self="emit('close')">
    <div class="preview-card">
      <header>
        <span class="name">{{ name }}</span>
        <button class="link" @click="emit('close')">Close</button>
      </header>
      <div class="body">
        <video ref="videoEl" controls autoplay />
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
.preview-card {
  background: var(--df-color-bg-elevated); border-radius: var(--df-radius-sm);
  max-width: 90vw; max-height: 90vh; overflow: auto; padding: 1rem;
  display: flex; flex-direction: column; gap: 0.75rem;
}
header { display: flex; justify-content: space-between; align-items: center; }
.name { font-weight: 600; }
.body video { max-width: 85vw; max-height: 75vh; }
.link { background: transparent; border: 0; cursor: pointer; color: var(--df-color-fg-muted); }
</style>
```

- [ ] **Step 3: Wire it into `FilePreviewModal.vue`**

`FilePreviewModal.vue` currently renders `<video :src=url>` for `kind === "video"`. Add an optional `player` payload prop and render `Mp4Player` when it is present (the blob/non-MP4 path keeps `<video :src=url>`).

Replace the `<script setup>` and `<template>` of `web/src/components/FilePreviewModal.vue` with:

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import type { FileKind } from "@/crypto/preview";
import type { PlayerPayload } from "@/player/msePlayer";
import Mp4Player from "./Mp4Player.vue";

const props = defineProps<{
  kind: FileKind;
  url: string;
  name: string;
  player?: PlayerPayload | null;
}>();
const emit = defineEmits<{ close: []; error: [message: string] }>();

const text = ref("");

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

async function loadText() {
  try {
    const res = await fetch(props.url);
    text.value = await res.text();
  } catch {
    text.value = "(unable to decode text)";
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  if (props.kind === "text") void loadText();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <!-- MP4 via MSE: the dedicated player owns the <video> + MediaSource. -->
  <Mp4Player
    v-if="player"
    :payload="player"
    :name="name"
    @close="emit('close')"
    @error="(m: string) => emit('error', m)"
  />
  <div v-else class="preview-backdrop" @click.self="emit('close')">
    <div class="preview-card">
      <header>
        <span class="name">{{ name }}</span>
        <button class="link" @click="emit('close')">Close</button>
      </header>
      <div class="body">
        <img v-if="kind === 'image'" :src="url" :alt="name" />
        <pre v-else-if="kind === 'text'">{{ text }}</pre>
        <audio v-else-if="kind === 'audio'" controls :src="url" />
        <video v-else-if="kind === 'video'" controls :src="url" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
.preview-card {
  background: var(--df-color-bg-elevated); border-radius: var(--df-radius-sm);
  max-width: 90vw; max-height: 90vh; overflow: auto; padding: 1rem;
  display: flex; flex-direction: column; gap: 0.75rem;
}
header { display: flex; justify-content: space-between; align-items: center; }
.name { font-weight: 600; }
.body img, .body video { max-width: 85vw; max-height: 75vh; }
.body pre { white-space: pre-wrap; word-break: break-word; max-width: 80vw; }
.link { background: transparent; border: 0; cursor: pointer; color: var(--df-color-fg-muted); }
</style>
```

- [ ] **Step 4: Typecheck + run the component tests**

Run: `npm run typecheck --prefix web` then `npm run test --prefix web -- FilePreviewModal`
Expected: typecheck clean; existing FilePreviewModal tests still pass (they don't pass `player`, so the `v-else` branch renders as before). If a test asserts the `<video>` for a non-player case, it still holds.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Mp4Player.vue web/src/components/FilePreviewModal.vue web/src/player/msePlayer.ts
git commit -m "feat(ui): Mp4Player.vue + FilePreviewModal renders it for MSE playback"
```

---

## Task 4: Route MP4 → MSE in openVideo

**Files:**
- Modify: `web/src/stores/files.ts` (`openVideo`, the `preview` type)
- Modify: `web/src/stores/files.test.ts`

**Interfaces:**
- Consumes: `PlayerPayload` from Task 2/3; `FilePreviewModal` now renders `Mp4Player` when `preview.player` is set.
- Produces: `openVideo` sets `preview.player` for MP4-family videos (MSE); non-MP4/large → blob-or-download; the `streamable===false` block is removed (it has no `streamable` reference left after Task 5, but removing the branch here avoids blocking non-faststart during the transition).

- [ ] **Step 1: Update the `preview` value type**

In `web/src/stores/files.ts`, find the `preview` ref declaration (around the top of `useFilesStore`) and extend it with an optional `player`:

```ts
  const preview = ref<{
    meta: FileMeta;
    url: string;
    kind: FileKind;
    name: string;
    player?: { fileId: string; fileKey: Uint8Array; ivBase: Uint8Array; chunkSize: number; totalSize: number } | null;
  } | null>(null);
```

Add the import at the top of the file:

```ts
import { FILE_CHUNK_SIZE, chunkCount, toBase64, fromBase64, type Manifest } from "@/crypto/file";
```
(`FILE_CHUNK_SIZE` is already imported; the payload uses it. The payload type matches `PlayerPayload` — define it inline here to avoid a worker-side import cycle.)

- [ ] **Step 2: Rewrite `openVideo`**

In `web/src/stores/files.ts`, replace the entire `openVideo` function with:

```ts
  async function openVideo(meta: FileMeta, manifest: Manifest, fileKey: Uint8Array): Promise<void> {
    const ivBase = fromBase64(manifest.iv_base);
    const isMp4 = ["video/mp4", "video/quicktime", "video/x-m4v"].includes(manifest.mime);

    if (isMp4 && typeof MediaSource !== "undefined") {
      // MSE path: the FilePreviewModal renders <Mp4Player> using this payload.
      if (preview.value) closePreview();
      preview.value = {
        meta,
        url: "",
        kind: "video",
        name: manifest.name,
        player: {
          fileId: meta.id,
          fileKey,
          ivBase,
          chunkSize: FILE_CHUNK_SIZE,
          totalSize: manifest.size,
        },
      };
      return;
    }

    // Fallback: whole-file blob for non-MP4 / MSE-unsupported small videos.
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
        player: null,
      };
      return;
    }

    error.value = "This video can't be played in the browser — use Download.";
  }
```

This removes the `ensureStreamSw`/`postToSw`/`/api/stream/` branch and the `streamable===false` block. (Those imports + `bindSwListener` are removed in Task 6.)

- [ ] **Step 3: Update the `closePreview` URL-revoke guard**

`closePreview` currently does `if (p.url.startsWith("/api/stream/"))` — that branch is dead now. Update it to handle the MSE case (no URL to revoke; the `Mp4Player` disposes itself via `onBeforeUnmount`). Replace the relevant block:

```ts
  function closePreview(): void {
    if (!preview.value) return;
    const p = preview.value;
    if (!p.player && p.url.startsWith("blob:")) URL.revokeObjectURL(p.url);
    preview.value = null;
  }
```

- [ ] **Step 4: Update the files-store tests**

In `web/src/stores/files.test.ts`:
- Remove the SW-related hoisted mocks (`ensureStreamSwMock`, `postToSwMock`) and the `vi.mock("@/sw/register", ...)` block. (The SW module still exists until Task 6, but the store no longer imports it — so drop the mock and the import-side test references.)
- Remove the now-obsolete tests: `"openPreview routes video to the streaming URL via the SW"`, `"openPreview blocks streaming for a non-faststart video..."`, `"needToken SW message refreshes..."`, `"closePreview posts stop for a stream URL"`, and the `"falls back to blob when SW unavailable..."` test (the fallback is now MSE-availability-based, not SW-based).
- Add a new test asserting MSE routing. First, stub `MediaSource` at the top of the describe (or in a `beforeEach`):

```ts
  beforeEach(() => {
    // ...existing resets...
    (globalThis as unknown as { MediaSource: unknown }).MediaSource =
      class { static isTypeSupported = () => true; };
  });
```

Then add:

```ts
  it("openPreview routes an MP4 to the MSE player payload", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    (cryptoApi.decryptManifestWithKey as any).mockResolvedValue({
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
    expect(files.preview).not.toBeNull();
    expect(files.preview!.player).not.toBeNull();
    expect(files.preview!.player!.fileId).toBe("vid1");
    expect(files.preview!.url).toBe("");
  });

  it("openPreview falls back to blob for a non-MP4 small video", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:webm"),
      revokeObjectURL: vi.fn(),
    });
    (cryptoApi.decryptManifestWithKey as any).mockResolvedValue({
      name: "clip.webm", mime: "video/webm", size: 1000,
      iv_base: "iv==", chunk_size: 4 * 1024 * 1024,
    });
    const files = useFilesStore();
    const meta = {
      id: "v2", owner_id: "u", status: "ready" as const,
      total_size: 0, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    expect(files.preview).not.toBeNull();
    expect(files.preview!.player).toBeNull();
    expect(files.preview!.url).toBe("blob:webm");
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run test --prefix web -- files.test` then `npm run typecheck --prefix web`
Expected: files-store tests pass (SW-removed + 2 new routing tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/stores/files.ts web/src/stores/files.test.ts
git commit -m "feat(store): openVideo routes MP4 to MSE player; non-MP4 to blob/download"
```

---

## Task 5: Remove moov-at-end detection

**Files:**
- Delete: `web/src/crypto/videoprobe.ts`, `web/src/crypto/videoprobe.test.ts`
- Modify: `web/src/crypto/file.ts` (remove `streamable?` from `Manifest`)
- Modify: `web/src/stores/files.ts` (remove the upload probe + warning)
- Modify: `web/src/stores/files.test.ts` (remove the `toBase64`/probe-related additions if unused)
- Modify: `web/src/views/DriveView.vue` (remove the `files.warning` banner + `.warn` style)

**Interfaces:** none (pure deletion of obsolete detection).

- [ ] **Step 1: Delete the probe module**

```bash
rm web/src/crypto/videoprobe.ts web/src/crypto/videoprobe.test.ts
```

- [ ] **Step 2: Remove `streamable` from the Manifest type**

In `web/src/crypto/file.ts`, remove the field added earlier:

```ts
  created_at: string; // RFC-3339
  /** False when the container is known not to stream ... */
  streamable?: boolean;
}
```
becomes:

```ts
  created_at: string; // RFC-3339
}
```

- [ ] **Step 3: Remove the upload probe + warning from `stores/files.ts`**

In `web/src/stores/files.ts`:
- Remove the `import { probeStreamable } from "@/crypto/videoprobe";` line.
- Remove the `warning` ref declaration and `warning.value` assignments in `upload()` (the `warning.value = null;` at the top of `upload` and the `warning.value = ...` block in the probe).
- Remove the probe block in `upload()` (the `const mime = ...; let streamable; if (mime === ...) { probeStreamable(...) }` lines).
- Remove the `...(streamable === false ? { streamable: false } : {})` from the manifest object (it just becomes `created_at: ...`).
- Remove `warning,` from the store's `return { ... }`.

- [ ] **Step 4: Remove the warning banner from `DriveView.vue`**

In `web/src/views/DriveView.vue`: remove `<p v-if="files.warning" class="warn">{{ files.warning }}</p>` and the `.warn { color: #b8860b; }` style rule.

- [ ] **Step 5: Clean up `files.test.ts`**

Remove the `import { toBase64 } from "@/crypto/file";` line if no remaining test uses it (the moov-block test that used it was removed in Task 4). If a test still references `toBase64`, keep it; otherwise remove.

- [ ] **Step 6: Run tests + typecheck**

Run: `npm run test --prefix web` then `npm run typecheck --prefix web`
Expected: all green; no references to `videoprobe`/`streamable`/`warning` remain.

- [ ] **Step 7: Commit**

```bash
git add -A web/src
git commit -m "refactor: remove obsolete moov-at-end detection (MSE handles it)"
```

---

## Task 6: Retire the SW streaming path

**Files:**
- Delete: `web/src/sw/` (whole directory)
- Modify: `web/vite.config.ts` (remove `VitePWA` plugin + its import)
- Modify: `web/src/main.ts` (remove `ensureStreamSw` import + startup call)
- Modify: `web/src/stores/files.ts` (remove `ensureStreamSw`/`postToSw` imports + `bindSwListener` + the `needToken` SW-message listener)
- Modify: `web/src/stores/files.test.ts` (drop the `@/sw/register` mock if still present)

**Interfaces:** none (deletion; `chunkbuf.ts` already owns `chunksCovering`/`chunkSlice`/`LruCache` so deleting `logic.ts` is safe).

- [ ] **Step 1: Delete the SW directory**

```bash
rm -rf web/src/sw
```

- [ ] **Step 2: Remove `VitePWA` from `vite.config.ts`**

In `web/vite.config.ts`:
- Remove the import line `import { VitePWA } from "vite-plugin-pwa";`.
- Remove the entire `VitePWA({ ... })` block from the `plugins: [...]` array (the block spanning `strategies: "injectManifest"` through `devOptions: { enabled: true, type: "module" }`).

The `plugins` array becomes:

```ts
  plugins: [
    fixLibsodiumImport(),
    vue(),
  ],
```

- [ ] **Step 3: Remove the SW startup from `main.ts`**

In `web/src/main.ts`, remove the `import { ensureStreamSw } from "./sw/register";` line and the `void ensureStreamSw().catch(() => {});` call.

- [ ] **Step 4: Remove SW references from `stores/files.ts`**

In `web/src/stores/files.ts`:
- Remove `import { ensureStreamSw, postToSw } from "@/sw/register";`.
- Remove the `bindSwListener` function and its `let swListenerBound` flag entirely.
- Remove the `needToken` message-listener wiring (the `navigator.serviceWorker.addEventListener("message", ...)` block inside what was `bindSwListener`).
- Remove the `import { refreshAuthToken, getAuthToken }` usages that only fed the SW token dance — but ONLY if they are not used elsewhere. (`refreshAuthToken` is used by the chunk-upload retry path and MUST stay. `getAuthToken` is used by the upload `Authorization` header and MUST stay. So keep both imports; only remove the SW-specific call sites, which were inside `bindSwListener`/the deleted `openVideo` branch — already removed in Task 4. Just verify no remaining `postToSw`/`ensureStreamSw` references exist.)

After edits, grep to confirm:

```bash
grep -n "sw/register\|postToSw\|ensureStreamSw\|bindSwListener\|/api/stream/" web/src/stores/files.ts
```
Expected: no matches.

- [ ] **Step 5: Drop the `@/sw/register` mock from `files.test.ts`**

If a `vi.mock("@/sw/register", ...)` block remains in `web/src/stores/files.test.ts`, remove it. (Task 4 should already have removed the SW mocks; this is a confirmation step.)

- [ ] **Step 6: Run the full suite + typecheck + build**

Run:
```bash
npm run test --prefix web
npm run typecheck --prefix web
npm run build --prefix web
```
Expected: tests green; typecheck clean; build succeeds and **`web/dist/sw.js`/`dev-sw.js` are no longer emitted** (the SW is gone). Confirm with `ls web/dist | grep -i sw` (should be empty).

- [ ] **Step 7: Commit**

```bash
git add -A web
git commit -m "refactor(sw): retire the SW streaming path — MSE replaces it

Remove web/src/sw/, vite-plugin-pwa, the SW registration in main.ts, and
all SW references in stores/files.ts. chunkbuf.ts now owns the chunk math
(chunksCovering/chunkSlice/LruCache) that logic.ts used to. Playback no
longer routes through a Service Worker; the MSE player fetches+decrypts
chunks in-page."
```

---

## Task 7: Docs + final verification

**Files:**
- Modify: `docs/streaming.md` (rewrite the top to describe MSE; remove the SW-proxy section)
- Modify: `README.md` (no change required — P3 status untouched; only verify the streaming blurb still reads OK)

**Interfaces:** none (docs).

- [ ] **Step 1: Rewrite the streaming doc**

`docs/streaming.md` currently describes the SW-proxy pipeline (with a "Superseded" note about the earlier MSE plan — which is now un-superseded). Replace the whole file with a concise description of the MSE pipeline. Use this content:

```markdown
# Video Streaming Design (MSE + mp4box.js)

Goal: play arbitrarily large encrypted videos with byte-exact random seek,
without exposing plaintext to the server and without holding the whole file
in memory.

> **History.** An earlier design used a Service Worker that synthesized
> `206` byte-range responses at `/api/stream/:id` for the native `<video>`
> element. That was browser-fragile: Chrome's media cache does not
> progressively read SW-synthesized streaming bodies, so large videos (and
> any file lacking usable duration/seek metadata — fragmented MP4, screen
> recordings) degraded to "load everything before play." The SW path has
> been **removed** in favor of the MSE pipeline below.

## Pipeline

```
<video>  ←  src = MediaSource objectURL
  │
MediaSource  →  SourceBuffer (codec from moov, via mp4box)
  ▲
  │ appendBuffer(init / media segments)
mp4box.js  (JS demuxer: parses moov/fragments, computes duration, slices
            segments, maps seek-time → byte offset)
  ▲
  │ requests byte range [start..end]
chunkbuf (web/src/player/chunkbuf.ts)
  │  chunksCovering → filesApi.getChunk(id,idx) → cryptoApi.decryptChunk
  │  (crypto worker) → 256 MiB LRU → chunkSlice → assembled range
  ▼
/api/files/:id/chunks/:idx   (existing backend, unchanged)
```

## Why this works where the SW didn't

- The failure was specifically `<video>` *directly consuming* an
  SW-synthesized streaming `206`. Here `<video>` reads from an in-page
  `MediaSource`; bytes reach it via JS (`fetch` + mp4box + MSE), which has no
  such limitation.
- mp4box.js parses **incrementally** (you feed byte ranges on demand) — the
  whole file is never loaded, so there is no large-file OOM.
- mp4box.js computes duration and handles seeking for progressive MP4,
  fragmented MP4, moov-at-end, and missing-`mvhd`-duration files (the actual
  root cause of the earlier Chrome issue).

## Routing & fallback

- MP4 family (`video/mp4`, `video/quicktime`, `video/x-m4v`) with MSE
  available → MSE player (`Mp4Player.vue`).
- Non-MP4 video, or MSE/codec unsupported, small enough (≤
  `PREVIEW_CAPS.video`, 256 MiB) → decrypt-all → in-memory `Blob` →
  `<video src=blob>`.
- Otherwise → "use Download" (no in-page playback).

No upload-time container probing; routing is by manifest MIME at playback.
MSE-unsupported browsers (older iOS Safari) get the blob fallback.

## Components

- `web/src/player/chunkbuf.ts` — pure chunk math + decrypted byte-range
  fetcher (the only unit-testable piece; the rest is MSE orchestration).
- `web/src/player/msePlayer.ts` — mp4box + MediaSource orchestration.
- `web/src/components/Mp4Player.vue` — `<video>` wrapper that mounts the
  player and disposes on unmount.
- `web/src/stores/files.ts` `openVideo` — routes MP4 → MSE payload, else
  blob/download.

## Limitations

- MP4 family only for streaming. WebM/AVI/MKV use the blob fallback (or
  "use Download" when too large); a WebM MSE demuxer is future work.
- MSE/codec support still varies by browser (e.g. HEVC). Unsupported codecs
  fall back to blob/download.
```

- [ ] **Step 2: Final full verification**

```bash
npm run test --prefix web
npm run typecheck --prefix web
npm run build --prefix web
```
Expected: all green; build succeeds; no SW artifacts in `web/dist`.

- [ ] **Step 3: Manual browser acceptance (the real gate for this feature)**

In Chrome AND Firefox, against a dev server (`npm run dev --prefix web` + backend):
1. Upload a **large fragmented / non-faststart MP4** (the screen-recording that
   originally failed) and a normal faststart MP4.
2. Open each: playback should start **progressively without loading the whole
   file**, the duration should be correct, and seeking (including to near the
   end) should work in BOTH browsers.
3. Upload a small WebM → Open → plays via blob. A large WebM → "use Download".
4. No `chunks/1 cancelled` spam in the network tab; no SW registered
   (Application → Service Workers should be empty).

If anything fails, capture the browser console + network and iterate on
`msePlayer.ts` (the orchestration is the part most likely to need tuning).

- [ ] **Step 4: Commit**

```bash
git add docs/streaming.md
git commit -m "docs: MSE + mp4box.js streaming design (replaces SW-proxy)"
```

---

## Final note

This branch (`fix/sw-chrome-streaming`) previously held two now-superseded
commits (`materialize`, `detection`). This plan's Task 5/6 undo them as part
of the MSE work, so when the branch merges to master it lands as one coherent
"MSE player replaces SW streaming" change.

