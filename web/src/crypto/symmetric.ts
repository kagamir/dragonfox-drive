/**
 * Symmetric encryption: AES-256-GCM via WebCrypto (native, fastest).
 *
 * All file chunks and manifests use AES-GCM. Each chunk has its own 96-bit IV
 * derived from a file-level `iv_base` XOR'd with the chunk index, so chunks are
 * independently decryptable for Range-based video seeking.
 */

import type { RawKey } from "./kdf";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export type Iv = Uint8Array;

/** Construct a 96-bit IV from a file-level base and a chunk index. */
export function chunkIv(ivBase: Uint8Array, chunkIndex: number): Iv {
  if (ivBase.length !== IV_BYTES) {
    throw new Error(`ivBase must be ${IV_BYTES} bytes, got ${ivBase.length}`);
  }
  const iv = new Uint8Array(ivBase);
  // XOR the last 4 bytes of the IV with the chunk index (counter-style).
  const view = new DataView(iv.buffer, iv.length - 4, 4);
  view.setUint32(0, view.getUint32(0) ^ (chunkIndex >>> 0));
  return iv;
}

async function importAesKey(raw: RawKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM", length: raw.length * 8 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a single plaintext chunk with the given key + IV. */
export async function encryptChunk(
  key: RawKey,
  iv: Iv,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await importAesKey(key);
  const buf = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: (aad ?? new Uint8Array(0)) as BufferSource,
      tagLength: TAG_BYTES * 8,
    },
    cryptoKey,
    plaintext as BufferSource,
  );
  return new Uint8Array(buf);
}

/** Decrypt a single ciphertext chunk. */
export async function decryptChunk(
  key: RawKey,
  iv: Iv,
  ciphertext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await importAesKey(key);
  const buf = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: (aad ?? new Uint8Array(0)) as BufferSource,
      tagLength: TAG_BYTES * 8,
    },
    cryptoKey,
    ciphertext as BufferSource,
  );
  return new Uint8Array(buf);
}

/** Encrypt an arbitrary blob (used for the master_key wrap and manifests). */
export async function encrypt(
  key: RawKey,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: Iv }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await encryptChunk(key, iv, plaintext, aad);
  return { ciphertext, iv };
}

/** Decrypt an arbitrary blob given its IV. */
export async function decrypt(
  key: RawKey,
  ciphertext: Uint8Array,
  iv: Iv,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  return decryptChunk(key, iv, ciphertext, aad);
}

export const CONSTANTS = {
  IV_BYTES,
  TAG_BYTES,
  KEY_BYTES: 32,
} as const;
