import { describe, it, expect, beforeAll } from "vitest";

import { api } from "./crypto.worker";
import { randomBytes } from "@/crypto/kdf";

describe("crypto worker api", () => {
  beforeAll(async () => {
    await api.init();
  });

  it("derives a deterministic 32-byte password key", async () => {
    const a = await api.derivePasswordKey("pw", "u@x.com");
    const b = await api.derivePasswordKey("pw", "u@x.com");
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(32);
  });

  it("produces a 16-byte server salt (crypto_pwhash_SALTBYTES)", () => {
    expect(api.randomServerSalt().length).toBe(16);
  });

  it("generates a 32-byte master key", () => {
    expect(api.newMasterKey().length).toBe(32);
  });

  it("round-trips encrypt/decrypt chunk via ivBase + index", async () => {
    const key = api.newMasterKey();
    const ivBase = randomBytes(12);
    const pt = new TextEncoder().encode("worker payload");
    const ct = await api.encryptChunk(key, ivBase, 0, pt);
    expect(Array.from(await api.decryptChunk(key, ivBase, 0, ct))).toEqual(
      Array.from(pt),
    );
  });

  it("round-trips wrap/unwrap master key", async () => {
    const master = api.newMasterKey();
    const wrapper = api.newMasterKey();
    const wrapped = await api.wrap(master, wrapper);
    expect(Array.from(await api.unwrap(wrapped, wrapper))).toEqual(
      Array.from(master),
    );
  });
});
