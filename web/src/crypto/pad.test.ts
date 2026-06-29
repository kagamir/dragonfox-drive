import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { pad, unpad } from "./pad";

describe("pad / unpad", () => {
  it("round-trips arbitrary bytes", () => {
    const data = new TextEncoder().encode("holiday-in-paris.mp4");
    expect(Array.from(unpad(pad(data)))).toEqual(Array.from(data));
  });

  it("round-trips empty input", () => {
    expect(unpad(pad(new Uint8Array(0))).length).toBe(0);
  });

  it("pads to a multiple of the block size (at least one block)", () => {
    expect(pad(new Uint8Array(0), 32).length).toBe(32);
    expect(pad(new Uint8Array(1), 32).length).toBe(32); // 4 + 1 = 5 → 32
    expect(pad(new Uint8Array(28), 32).length).toBe(32); // 4 + 28 = 32
    expect(pad(new Uint8Array(29), 32).length).toBe(64); // 4 + 29 = 33 → 64
  });

  it("hides length: different-length names below a bucket pad equal", () => {
    const a = pad(new TextEncoder().encode("a.txt"), 32);
    const b = pad(new TextEncoder().encode("a-much-longer-name.txt"), 32);
    expect(a.length).toBe(b.length); // both ≤ 28 bytes → same 32-byte bucket
  });

  it("survives trailing zero bytes in the plaintext", () => {
    const data = new Uint8Array([1, 2, 0, 0, 0]);
    expect(Array.from(unpad(pad(data)))).toEqual([1, 2, 0, 0, 0]);
  });

  it("rejects corrupt padding whose length prefix overruns", () => {
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, 999);
    expect(() => unpad(bad)).toThrow();
  });
});

describe("pad / unpad [property]", () => {
  it("round-trips for random (bytes, block)", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 512 }),
        fc.integer({ min: 1, max: 256 }),
        (bytes, block) => {
          const r = unpad(pad(bytes, block));
          return r.length === bytes.length && r.every((v, i) => v === bytes[i]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
