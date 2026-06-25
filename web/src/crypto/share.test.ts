import { describe, it, expect } from "vitest";
import { randomBytes } from "./kdf";
import {
  newShareMaterial,
  deriveShareKey,
  wrapFileKeyForShare,
  unwrapFileKeyForShare,
  shareVerifier,
} from "./share";

describe("newShareMaterial", () => {
  it("returns 32-byte password + 16-byte salt", () => {
    const m = newShareMaterial();
    expect(m.sharePassword.length).toBe(32);
    expect(m.shareSalt.length).toBe(16);
  });
  it("is random on each call", () => {
    const a = newShareMaterial();
    const b = newShareMaterial();
    expect(Array.from(a.sharePassword)).not.toEqual(Array.from(b.sharePassword));
  });
});

describe("deriveShareKey", () => {
  it("is deterministic for same inputs", () => {
    const pw = randomBytes(32);
    const salt = randomBytes(16);
    expect(Array.from(deriveShareKey(pw, salt))).toEqual(
      Array.from(deriveShareKey(pw, salt)),
    );
  });
  it("produces 32 bytes", () => {
    expect(deriveShareKey(randomBytes(32), randomBytes(16)).length).toBe(32);
  });
  it("differs for different passwords", () => {
    const salt = randomBytes(16);
    expect(Array.from(deriveShareKey(randomBytes(32), salt))).not.toEqual(
      Array.from(deriveShareKey(randomBytes(32), salt)),
    );
  });
});

describe("wrap/unwrap fileKey for share", () => {
  it("round-trips the file key", async () => {
    const fileKey = randomBytes(32);
    const shareKey = deriveShareKey(randomBytes(32), randomBytes(16));
    const wrapped = await wrapFileKeyForShare(fileKey, shareKey);
    const recovered = await unwrapFileKeyForShare(wrapped, shareKey);
    expect(Array.from(recovered)).toEqual(Array.from(fileKey));
  });
  it("fails to unwrap under a wrong share key", async () => {
    const fileKey = randomBytes(32);
    const k1 = deriveShareKey(randomBytes(32), randomBytes(16));
    const k2 = deriveShareKey(randomBytes(32), randomBytes(16));
    const wrapped = await wrapFileKeyForShare(fileKey, k1);
    await expect(unwrapFileKeyForShare(wrapped, k2)).rejects.toThrow();
  });
});

describe("shareVerifier", () => {
  it("is deterministic and hex", async () => {
    const k = deriveShareKey(randomBytes(32), randomBytes(16));
    const a = await shareVerifier(k);
    const b = await shareVerifier(k);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("differs for different share keys", async () => {
    const a = await shareVerifier(deriveShareKey(randomBytes(32), randomBytes(16)));
    const b = await shareVerifier(deriveShareKey(randomBytes(32), randomBytes(16)));
    expect(a).not.toBe(b);
  });
});
