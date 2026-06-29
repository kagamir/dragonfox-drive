import { describe, it, expect, beforeAll } from "vitest";

import {
  newFolderKey,
  encryptFolderName,
  decryptFolderName,
  encryptParentId,
  decryptParentId,
  wrapFolderKey,
  unwrapFolderKey,
} from "./folder";
import { generateMasterKey } from "./keys";
import { initCrypto } from "./index";

describe("folder crypto", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it("newFolderKey returns a 32-byte key", () => {
    expect(newFolderKey().length).toBe(32);
  });

  it("folder name encrypt/decrypt round-trips", async () => {
    const fk = newFolderKey();
    const enc = await encryptFolderName(fk, "Taxes 2026");
    expect(await decryptFolderName(fk, enc.ciphertext, enc.iv)).toBe("Taxes 2026");
  });

  it("folder name decrypt throws with the wrong key", async () => {
    const fk = newFolderKey();
    const enc = await encryptFolderName(fk, "secret");
    await expect(decryptFolderName(newFolderKey(), enc.ciphertext, enc.iv)).rejects.toThrow();
  });

  it("pads names so short names of different length share a ciphertext length", async () => {
    const fk = newFolderKey();
    const a = await encryptFolderName(fk, "a");
    const b = await encryptFolderName(fk, "a-longer-folder-name");
    // Both ≤ 28 bytes → same 32-byte padding bucket → equal ciphertext length.
    expect(a.ciphertext.length).toBe(b.ciphertext.length);
  });

  it("round-trips a multibyte unicode name (padding is byte-based)", async () => {
    const fk = newFolderKey();
    const name = "项目-📁-2026";
    const enc = await encryptFolderName(fk, name);
    expect(await decryptFolderName(fk, enc.ciphertext, enc.iv)).toBe(name);
  });

  it("encryptParentId returns null for a root (null) parent", async () => {
    const mk = generateMasterKey();
    expect(await encryptParentId(mk, null)).toBeNull();
  });

  it("parent id encrypt/decrypt round-trips for a non-root parent", async () => {
    const mk = generateMasterKey();
    const enc = await encryptParentId(mk, "parent-uuid-123");
    expect(enc).not.toBeNull();
    expect(await decryptParentId(mk, enc!.ciphertext, enc!.iv)).toBe("parent-uuid-123");
  });

  it("decryptParentId returns null for null inputs (root)", async () => {
    const mk = generateMasterKey();
    expect(await decryptParentId(mk, null, null)).toBeNull();
  });

  it("folder_key wraps by master_key at the root", async () => {
    const mk = generateMasterKey();
    const fk = newFolderKey();
    const wrapped = await wrapFolderKey(fk, mk);
    expect(Array.from(await unwrapFolderKey(wrapped, mk))).toEqual(Array.from(fk));
  });

  it("folder_key wraps in a chain (child folder_key by root folder_key)", async () => {
    const mk = generateMasterKey();
    const rootFk = newFolderKey();
    const childFk = newFolderKey();
    const rootWrapped = await wrapFolderKey(rootFk, mk);
    const rootRecovered = await unwrapFolderKey(rootWrapped, mk);
    const childWrapped = await wrapFolderKey(childFk, rootRecovered);
    expect(Array.from(await unwrapFolderKey(childWrapped, rootFk))).toEqual(Array.from(childFk));
  });
});
