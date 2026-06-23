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
