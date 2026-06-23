import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";

import { bytes } from "@/__tests__/fc-arbitrary";
import {
  generateMasterKey,
  generateFileKey,
  getOrCreateDeviceKey,
  wrapMasterKey,
  unwrapMasterKey,
  wrapWithPassword,
  unwrapWithPassword,
  persistDeviceWrap,
  loadDeviceWrap,
  clearDeviceWrap,
} from "./keys";

describe("generateMasterKey / generateFileKey", () => {
  it("produce 32-byte keys", () => {
    expect(generateMasterKey().length).toBe(32);
    expect(generateFileKey().length).toBe(32);
  });
});

describe("generateMasterKey [property]", () => {
  it("two consecutive calls are distinct", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const a = generateMasterKey();
        const b = generateMasterKey();
        return Array.from(a).some((v, i) => v !== b[i]);
      }),
      { numRuns: 32 },
    );
  });
});

describe("wrapMasterKey / unwrapMasterKey", () => {
  it("round-trip", async () => {
    const master = generateMasterKey();
    const wrapper = generateMasterKey();
    const wrapped = await wrapMasterKey(master, wrapper);
    expect(Array.from(await unwrapMasterKey(wrapped, wrapper))).toEqual(
      Array.from(master),
    );
  });

  it("throws when unwrapped with the wrong key", async () => {
    const wrapped = await wrapMasterKey(generateMasterKey(), generateMasterKey());
    await expect(
      unwrapMasterKey(wrapped, generateMasterKey()),
    ).rejects.toThrow();
  });

  it("does not mutate the master key input", async () => {
    const master = generateMasterKey();
    const snapshot = Array.from(master);
    await wrapMasterKey(master, generateMasterKey());
    expect(Array.from(master)).toEqual(snapshot);
  });
});

describe("wrapMasterKey [property]", () => {
  it("round-trips for random master/wrapper", () => {
    return fc.assert(
      fc.asyncProperty(bytes(32, 32), bytes(32, 32), async (m, w) => {
        const master = new Uint8Array(m);
        const wrapper = new Uint8Array(w);
        const wrapped = await wrapMasterKey(master, wrapper);
        const recovered = await unwrapMasterKey(wrapped, wrapper);
        return Array.from(recovered).every((v, i) => v === m[i]);
      }),
      { numRuns: 50 },
    );
  });
});

describe("wrapWithPassword / unwrapWithPassword", () => {
  it("round-trip", async () => {
    const master = generateMasterKey();
    const wrapped = await wrapWithPassword(master, "correct horse", "alice");
    expect(
      Array.from(await unwrapWithPassword(wrapped, "correct horse", "alice")),
    ).toEqual(Array.from(master));
  });

  it("throws with the wrong password", async () => {
    const wrapped = await wrapWithPassword(
      generateMasterKey(),
      "right",
      "alice",
    );
    await expect(
      unwrapWithPassword(wrapped, "wrong", "alice"),
    ).rejects.toThrow();
  });
});

describe("device-wrap persistence (localforage mock)", () => {
  // setup.ts mock isolates each store by (name, storeName); keys.ts uses
  // name:"dragonfox-drive", storeName:"keys". beforeEach resets the store.
  beforeEach(async () => {
    await clearDeviceWrap();
  });

  it("getOrCreateDeviceKey persists across calls", async () => {
    const first = await getOrCreateDeviceKey();
    expect(Array.from(await getOrCreateDeviceKey())).toEqual(Array.from(first));
  });

  it("persistDeviceWrap / loadDeviceWrap round-trip", async () => {
    const wrap = await wrapMasterKey(generateMasterKey(), generateMasterKey());
    await persistDeviceWrap("user-123", wrap);
    const loaded = await loadDeviceWrap();
    expect(loaded).not.toBeNull();
    expect(loaded!.userId).toBe("user-123");
    expect(Array.from(loaded!.wrap.ciphertext)).toEqual(
      Array.from(wrap.ciphertext),
    );
  });

  it("clearDeviceWrap makes loadDeviceWrap return null", async () => {
    const wrap = await wrapMasterKey(generateMasterKey(), generateMasterKey());
    await persistDeviceWrap("u", wrap);
    await clearDeviceWrap();
    expect(await loadDeviceWrap()).toBeNull();
  });

  it("loadDeviceWrap returns null when nothing was persisted", async () => {
    expect(await loadDeviceWrap()).toBeNull();
  });
});
