import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { bytes } from "@/__tests__/fc-arbitrary";
import { randomBytes } from "./kdf";
import {
  chunkIv,
  encryptChunk,
  decryptChunk,
  encrypt,
  decrypt,
  CONSTANTS,
} from "./symmetric";

describe("chunkIv", () => {
  it("throws when ivBase is not 12 bytes", () => {
    expect(() => chunkIv(new Uint8Array(11), 0)).toThrow();
    expect(() => chunkIv(new Uint8Array(13), 0)).toThrow();
  });

  it("returns the base unchanged when index is 0", () => {
    const base = randomBytes(12);
    expect(Array.from(chunkIv(base, 0))).toEqual(Array.from(base));
  });

  it("does not mutate the input ivBase", () => {
    const base = randomBytes(12);
    const snapshot = Array.from(base);
    chunkIv(base, 42);
    expect(Array.from(base)).toEqual(snapshot);
  });

  it("produces different IVs for different indices", () => {
    const base = randomBytes(12);
    expect(Array.from(chunkIv(base, 1))).not.toEqual(Array.from(chunkIv(base, 2)));
  });

  it("is deterministic for the same (base, index)", () => {
    const base = randomBytes(12);
    expect(Array.from(chunkIv(base, 5))).toEqual(Array.from(chunkIv(base, 5)));
  });
});

describe("chunkIv [property]", () => {
  it("index 0 equals base for random bases", () => {
    fc.assert(
      fc.property(bytes(12, 12), (b) => {
        const base = new Uint8Array(b);
        const iv = chunkIv(base, 0);
        return Array.from(iv).every((v, i) => v === b[i]);
      }),
      { numRuns: 100 },
    );
  });

  it("is deterministic across calls for random (base, index)", () => {
    fc.assert(
      fc.property(
        bytes(12, 12),
        fc.integer({ min: 0, max: 1 << 24 }),
        (b, idx) => {
          const base = new Uint8Array(b);
          return (
            Array.from(chunkIv(base, idx)).join() ===
            Array.from(chunkIv(base, idx)).join()
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("encryptChunk / decryptChunk", () => {
  it("round-trips plaintext", async () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const pt = new TextEncoder().encode("hello world");
    const ct = await encryptChunk(key, iv, pt);
    expect(Array.from(await decryptChunk(key, iv, ct))).toEqual(Array.from(pt));
  });

  it("throws when ciphertext is tampered", async () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const ct = await encryptChunk(key, iv, new TextEncoder().encode("hello"));
    ct[0] ^= 0xff;
    await expect(decryptChunk(key, iv, ct)).rejects.toThrow();
  });

  it("throws when AAD mismatches", async () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const ct = await encryptChunk(
      key,
      iv,
      new TextEncoder().encode("hello"),
      new TextEncoder().encode("v1"),
    );
    await expect(
      decryptChunk(key, iv, ct, new TextEncoder().encode("v2")),
    ).rejects.toThrow();
  });

  it("produces different ciphertexts for different IVs", async () => {
    const key = randomBytes(32);
    const pt = new TextEncoder().encode("hello");
    expect(Array.from(await encryptChunk(key, randomBytes(12), pt))).not.toEqual(
      Array.from(await encryptChunk(key, randomBytes(12), pt)),
    );
  });
});

describe("encryptChunk / decryptChunk [property]", () => {
  it("round-trips for random plaintext / AAD", () => {
    return fc.assert(
      fc.asyncProperty(
        bytes(1, 4096),
        bytes(0, 64),
        async (plainBytes, aadBytes) => {
          const key = randomBytes(32);
          const iv = randomBytes(12);
          const pt = new Uint8Array(plainBytes);
          const aad = new Uint8Array(aadBytes);
          const ct = await encryptChunk(key, iv, pt, aad);
          const recovered = await decryptChunk(key, iv, ct, aad);
          return Array.from(recovered).every((v, i) => v === plainBytes[i]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("encrypt / decrypt (random IV)", () => {
  it("round-trips", async () => {
    const key = randomBytes(32);
    const pt = new TextEncoder().encode("blob");
    const { ciphertext, iv } = await encrypt(key, pt);
    expect(Array.from(await decrypt(key, ciphertext, iv))).toEqual(Array.from(pt));
  });

  it("uses a fresh random IV per call", async () => {
    const key = randomBytes(32);
    const pt = new TextEncoder().encode("blob");
    expect(Array.from((await encrypt(key, pt)).iv)).not.toEqual(
      Array.from((await encrypt(key, pt)).iv),
    );
  });
});

describe("CONSTANTS", () => {
  it("matches the documented values", () => {
    expect(CONSTANTS.IV_BYTES).toBe(12);
    expect(CONSTANTS.TAG_BYTES).toBe(16);
    expect(CONSTANTS.KEY_BYTES).toBe(32);
  });
});
