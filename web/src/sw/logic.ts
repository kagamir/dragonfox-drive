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
