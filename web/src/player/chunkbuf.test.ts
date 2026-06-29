import { describe, it, expect, beforeEach, vi } from "vitest";

const { fetchChunkMock, decryptMock } = vi.hoisted(() => ({
  fetchChunkMock: vi.fn(),
  decryptMock: vi.fn(),
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
  DEFAULT_CHUNK_SIZE,
} from "./chunkbuf";

describe("chunkbuf pure fns", () => {
  it("chunksCovering maps a byte range to chunk indices, clamped to size", () => {
    const sz = DEFAULT_CHUNK_SIZE * 3 + 10; // 3 full chunks + 10-byte tail → indices 0..3
    expect(chunksCovering(0, 100, sz)).toEqual({ firstIdx: 0, lastIdx: 0 });
    expect(chunksCovering(0, sz - 1, sz)).toEqual({ firstIdx: 0, lastIdx: 3 });
    expect(chunksCovering(DEFAULT_CHUNK_SIZE + 1, DEFAULT_CHUNK_SIZE * 2, sz)).toEqual({ firstIdx: 1, lastIdx: 2 });
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
    fetchChunkMock.mockReset();
    decryptMock.mockReset();
  });

  it("fetches covering chunks via the injected fetchChunk, decrypts, slices, assembles the exact range", async () => {
    // 2 chunks of 4 bytes; file size 8. Request [2..5].
    const buf = createChunkBuffer({
      fileKey: KEY, ivBase: IV, contentId: "cid", chunkSize: 4, totalSize: 8, fetchChunk: fetchChunkMock,
    });
    // injected fetchChunk returns ENCRYPTED bytes (here just [idx]); decrypt yields plaintext per idx.
    fetchChunkMock.mockImplementation((idx: number) => Promise.resolve(new Uint8Array([idx])));
    decryptMock.mockImplementation(async (_k: unknown, _iv: unknown, idx: number) =>
      idx === 0 ? new Uint8Array([1, 2, 3, 4]) : new Uint8Array([5, 6, 7, 8]));

    const out = await buf.fetchRange(2, 5);
    expect(Array.from(out)).toEqual([3, 4, 5, 6]); // chunk0→[3,4], chunk1→[5,6]
    expect(fetchChunkMock).toHaveBeenCalledWith(0);
    expect(fetchChunkMock).toHaveBeenCalledWith(1);
  });

  it("caches decrypted chunks across range calls", async () => {
    const buf = createChunkBuffer({
      fileKey: KEY, ivBase: IV, contentId: "cid", chunkSize: 4, totalSize: 8, fetchChunk: fetchChunkMock,
    });
    fetchChunkMock.mockResolvedValue(new Uint8Array([0]));
    decryptMock.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    await buf.fetchRange(0, 3);
    await buf.fetchRange(0, 3); // same chunk → cache hit
    expect(fetchChunkMock).toHaveBeenCalledTimes(1);
  });

  it("clamps end to totalSize - 1 (short tail chunk)", async () => {
    const buf = createChunkBuffer({
      fileKey: KEY, ivBase: IV, contentId: "cid", chunkSize: 4, totalSize: 6, fetchChunk: fetchChunkMock,
    });
    fetchChunkMock.mockImplementation(() => Promise.resolve(new Uint8Array([0])));
    // tail chunk idx 1 has 2 bytes
    decryptMock.mockImplementation(async (_k: unknown, _iv: unknown, idx: number) =>
      idx === 0 ? new Uint8Array([1, 2, 3, 4]) : new Uint8Array([5, 6]));
    const out = await buf.fetchRange(3, 9999); // end way past EOF
    expect(Array.from(out)).toEqual([4, 5, 6]); // chunk0 tail [4], chunk1 [5,6]
  });
});
