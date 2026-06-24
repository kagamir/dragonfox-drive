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
