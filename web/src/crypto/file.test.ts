import { describe, it, expect, beforeAll } from "vitest";

import { encryptFile, decryptFile, decryptManifest, chunkCount, encryptFileChunk, decryptFileChunk, FILE_CHUNK_SIZE } from "./file";
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

  it("chunkCount rounds up with a 1-chunk floor", () => {
    expect(chunkCount(0)).toBe(1);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(FILE_CHUNK_SIZE)).toBe(1);
    expect(chunkCount(FILE_CHUNK_SIZE + 1)).toBe(2);
    expect(chunkCount(5 * 1024 * 1024)).toBe(2);
    expect(chunkCount(5 * 1024 * 1024, 1024)).toBe(5120);
  });

  it("encryptFileChunk / decryptFileChunk round-trip a single chunk", async () => {
    const fileKey = generateMasterKey(); // any 32-byte key
    const ivBase = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode("chunky bytes");
    const ct = await encryptFileChunk(fileKey, ivBase, 4, pt);
    const out = await decryptFileChunk(fileKey, ivBase, 4, ct);
    expect(Array.from(out)).toEqual(Array.from(pt));
  });

  it("multi-chunk encrypt+decrypt concatenates to the original", async () => {
    const fileKey = generateMasterKey();
    const ivBase = crypto.getRandomValues(new Uint8Array(12));
    const original = new Uint8Array(FILE_CHUNK_SIZE + 10);
    for (let i = 0; i < original.length; i++) original[i] = i & 0xff;
    const n = chunkCount(original.length, FILE_CHUNK_SIZE);
    const recovered: Uint8Array[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const start = i * FILE_CHUNK_SIZE;
      const slice = original.subarray(start, Math.min(start + FILE_CHUNK_SIZE, original.length));
      const ct = await encryptFileChunk(fileKey, ivBase, i, slice);
      recovered[i] = await decryptFileChunk(fileKey, ivBase, i, ct);
    }
    const joined = new Uint8Array(original.length);
    let off = 0;
    for (const r of recovered) { joined.set(r, off); off += r.length; }
    expect(Array.from(joined)).toEqual(Array.from(original));
  });
});
