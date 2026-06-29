import { describe, it, expect, beforeAll } from "vitest";

import { api } from "./crypto.worker";
import { randomBytes } from "@/crypto/kdf";
import { fromBase64 } from "@/crypto/file";

describe("crypto worker api", () => {
  beforeAll(async () => {
    await api.init();
  });

  it("derives a deterministic 32-byte password key", async () => {
    const salt = new Uint8Array(16).fill(3);
    const a = await api.derivePasswordKey("pw", salt);
    const b = await api.derivePasswordKey("pw", salt);
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

  it("folder name round-trips through the worker api", async () => {
    const fk = api.newFolderKey();
    const enc = await api.encryptFolderName(fk, "Photos");
    expect(await api.decryptFolderName(fk, enc.ciphertext, enc.iv)).toBe("Photos");
  });

  it("parent id encrypts/decrypts and null means root", async () => {
    const mk = api.newMasterKey();
    expect(await api.encryptParentId(mk, null)).toBeNull();
    const enc = await api.encryptParentId(mk, "pid");
    expect(enc).not.toBeNull();
    expect(await api.decryptParentId(mk, enc!.ciphertext, enc!.iv)).toBe("pid");
  });

  it("folder_key wraps by master_key then unwraps via worker api", async () => {
    const mk = api.newMasterKey();
    const fk = api.newFolderKey();
    const wrapped = await api.wrapFolderKey(fk, mk);
    expect(Array.from(await api.unwrapFolderKey(wrapped, mk))).toEqual(Array.from(fk));
  });

  it("decryptManifestWithKey decrypts using an already-unwrapped fileKey", async () => {
    const mk = api.newMasterKey();
    const pt = new TextEncoder().encode("manifest body");
    const payload = await api.encryptFile(mk, pt, "a.txt", "text/plain");
    // Unwrap the file_key with master_key, then decrypt the manifest WITHOUT
    // re-unwrapping (mirrors the folder-aware download/preview path).
    const fileKey = await api.unwrap(
      {
        ciphertext: fromBase64(payload.encrypted_file_key),
        iv: fromBase64(payload.encrypted_file_key_nonce),
      },
      mk,
    );
    const m = await api.decryptManifestWithKey(
      fileKey,
      payload.encrypted_manifest,
      payload.encrypted_manifest_nonce,
    );
    expect(m.name).toBe("a.txt");
    expect(m.mime).toBe("text/plain");
    expect(m.iv_base).toBeTruthy();
  });
});
