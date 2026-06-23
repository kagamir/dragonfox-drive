import { describe, it, expect, beforeAll } from "vitest";

import { encryptFile, decryptFile, decryptManifest } from "./file";
import { generateMasterKey } from "./keys";
import { initCrypto } from "./index";

describe("file crypto", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it("round-trips a small file byte-identical", async () => {
    const master = generateMasterKey();
    const pt = new TextEncoder().encode("hello dragonfox");
    const payload = await encryptFile(master, pt, "note.txt", "text/plain");
    const { plaintext, manifest } = await decryptFile(
      master,
      payload.encrypted_file_key,
      payload.encrypted_file_key_nonce,
      payload.encrypted_manifest,
      payload.encrypted_manifest_nonce,
      payload.ciphertext,
    );
    expect(Array.from(plaintext)).toEqual(Array.from(pt));
    expect(manifest.name).toBe("note.txt");
    expect(manifest.mime).toBe("text/plain");
    expect(manifest.size).toBe(pt.length);
  });

  it("round-trips an empty file", async () => {
    const master = generateMasterKey();
    const pt = new Uint8Array(0);
    const payload = await encryptFile(master, pt, "empty.bin", "");
    const { plaintext } = await decryptFile(
      master,
      payload.encrypted_file_key,
      payload.encrypted_file_key_nonce,
      payload.encrypted_manifest,
      payload.encrypted_manifest_nonce,
      payload.ciphertext,
    );
    expect(plaintext.length).toBe(0);
  });

  it("decryptManifest alone recovers metadata", async () => {
    const master = generateMasterKey();
    const pt = new TextEncoder().encode("x");
    const payload = await encryptFile(master, pt, "a.txt", "text/plain");
    const m = await decryptManifest(
      master,
      payload.encrypted_file_key,
      payload.encrypted_file_key_nonce,
      payload.encrypted_manifest,
      payload.encrypted_manifest_nonce,
    );
    expect(m.name).toBe("a.txt");
    expect(m.iv_base).toBeTruthy();
  });
});
