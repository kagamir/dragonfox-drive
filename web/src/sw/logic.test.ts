import { describe, it, expect } from "vitest";
import {
  SW_CHUNK_SIZE,
  chunksCovering,
  chunkSlice,
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
    size: 0, chunkCount: 0, chunkSize: 4 * 1024 * 1024, token: "tok",
    mime: "video/mp4", ...over,
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
    expect(res.headers.get("content-type")).toBe("video/mp4");
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

  it("decryptChunkSubtle round-trips against WebCrypto encrypt", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const ivBase = crypto.getRandomValues(new Uint8Array(12));
    const pt = new Uint8Array([42, 43, 44]);
    const ct = await enc(key, ivBase, 7, pt);
    const out = await decryptChunkSubtle(key, ivBase, 7, ct);
    expect(Array.from(out)).toEqual([42, 43, 44]);
  });

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
