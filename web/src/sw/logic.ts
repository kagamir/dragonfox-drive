/** Service-Worker streaming logic. Pure (no SW globals) so it unit-tests in happy-dom. */

export const SW_CHUNK_SIZE = 4 * 1024 * 1024; // MUST equal FILE_CHUNK_SIZE

/** Per-response cap so the browser re-requests the next segment as playback
 *  progresses instead of pulling the whole file up front. 4× chunk size. */
export const STREAM_SEGMENT_BYTES = 4 * SW_CHUNK_SIZE;

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

// --- request handling --------------------------------------------------------

export interface StreamMeta {
  fileId: string;
  fileKey: Uint8Array;
  ivBase: Uint8Array;
  size: number;
  chunkCount: number;
  chunkSize: number;
  token: string;
  mime: string;
}

export type ChunkFetcher =
  (idx: number, signal?: AbortSignal) => Promise<Uint8Array>; // returns ciphertext

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

/** Serve a Range request: fetch+decrypt the covering chunks (cached) and
 *  respond 206/200 with the requested byte window, capped to `segmentBytes` so
 *  the browser re-requests the next segment as playback advances.
 *
 *  The body is MATERIALIALIZED into one buffer up front (not a streaming
 *  ReadableStream). Chrome's media cache does not progressively read
 *  SW-synthesized streaming 206 bodies — it reads ~320 KiB blocks then cancels
 *  and re-requests, thrashing large videos. A complete buffer body is read like
 *  any normal response. Memory cost is one segment (default 16 MiB) per request,
 *  which is fine alongside the 256 MiB LRU. */
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

  // Materialize the segment: fetch+decrypt every covering chunk, slice each to
  // the requested window, concatenate into one buffer. chunkSlice bounds itself
  // by plaintext.length so a short tail chunk still slices correctly.
  const body = new Uint8Array(length);
  let off = 0;
  for (let idx = firstIdx; idx <= lastIdx; idx++) {
    const pt = await getPlain(idx);
    const slice = chunkSlice(pt, idx, meta.chunkSize, start, effectiveEnd);
    if (slice.length) {
      body.set(slice, off);
      off += slice.length;
    }
  }

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
