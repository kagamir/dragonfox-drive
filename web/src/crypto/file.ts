/**
 * High-level file encrypt/decrypt orchestration.
 *
 * P1 model: the whole file is a single AES-GCM chunk (chunkIndex = 0, IV =
 * iv_base XOR 0). A random per-file file_key encrypts both the chunk and the
 * manifest; file_key itself is master_key-wrapped for storage on the server.
 */

import {
  decrypt,
  encrypt,
  chunkIv,
  decryptChunk,
  encryptChunk,
} from "./symmetric";
import {
  generateFileKey,
  unwrapMasterKey,
  wrapMasterKey,
  type WrappedKey,
} from "./keys";
import { randomBytes, type RawKey } from "./kdf";

export const FILE_CHUNK_SIZE = 4 * 1024 * 1024;

export interface Manifest {
  version: number;
  name: string;
  mime: string;
  size: number;
  chunk_size: number;
  iv_base: string; // base64 of the 12-byte iv_base
  plaintext_sha256?: string; // hex; omitted for multi-chunk P2a uploads
  created_at: string; // RFC-3339
  /** False when the container is known not to stream (e.g. non-faststart MP4
   *  with moov after mdat). Undefined = unknown / streamable. See crypto/videoprobe. */
  streamable?: boolean;
}

/** Wire-format payload returned by encryptFile (base64 for server columns). */
export interface EncryptedFilePayload {
  ciphertext: Uint8Array;
  encrypted_file_key: string; // base64
  encrypted_file_key_nonce: string; // base64
  encrypted_manifest: string; // base64
  encrypted_manifest_nonce: string; // base64
}

// --- encoding helpers (shared; auth.ts keeps its own local copy) ----------

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function toWrapped(ct: Uint8Array, iv: Uint8Array): WrappedKey {
  return { ciphertext: ct, iv };
}

export async function encryptFile(
  masterKey: RawKey,
  plaintext: Uint8Array,
  name: string,
  mime: string,
): Promise<EncryptedFilePayload> {
  const fileKey = generateFileKey();
  const ivBase = randomBytes(12);
  const ciphertext = await encryptChunk(fileKey, chunkIv(ivBase, 0), plaintext);

  const wrapped: WrappedKey = await wrapMasterKey(fileKey, masterKey);

  const sha = new Uint8Array(
    await crypto.subtle.digest("SHA-256", plaintext as BufferSource),
  );
  const manifest: Manifest = {
    version: 1,
    name,
    mime: mime || "application/octet-stream",
    size: plaintext.length,
    chunk_size: FILE_CHUNK_SIZE,
    iv_base: toBase64(ivBase),
    plaintext_sha256: toHex(sha),
    created_at: new Date().toISOString(),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const encManifest = await encrypt(fileKey, manifestBytes);

  return {
    ciphertext,
    encrypted_file_key: toBase64(wrapped.ciphertext),
    encrypted_file_key_nonce: toBase64(wrapped.iv),
    encrypted_manifest: toBase64(encManifest.ciphertext),
    encrypted_manifest_nonce: toBase64(encManifest.iv),
  };
}

export async function decryptManifest(
  masterKey: RawKey,
  encryptedFileKey: string,
  encryptedFileKeyNonce: string,
  encryptedManifest: string,
  encryptedManifestNonce: string,
): Promise<Manifest> {
  const fileKey = await unwrapMasterKey(
    toWrapped(fromBase64(encryptedFileKey), fromBase64(encryptedFileKeyNonce)),
    masterKey,
  );
  const plain = await decrypt(
    fileKey,
    fromBase64(encryptedManifest),
    fromBase64(encryptedManifestNonce),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Manifest;
}

/** Like decryptManifest, but the file_key has already been unwrapped by the
 *  caller (e.g. with a folder key rather than master_key). Used so the
 *  manifest decrypt can be folder-aware without a new unwrap path. */
export async function decryptManifestWithKey(
  fileKey: RawKey,
  encryptedManifest: string,
  encryptedManifestNonce: string,
): Promise<Manifest> {
  const plain = await decrypt(
    fileKey,
    fromBase64(encryptedManifest),
    fromBase64(encryptedManifestNonce),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Manifest;
}

export async function decryptFile(
  masterKey: RawKey,
  encryptedFileKey: string,
  encryptedFileKeyNonce: string,
  encryptedManifest: string,
  encryptedManifestNonce: string,
  ciphertext: Uint8Array,
): Promise<{ plaintext: Uint8Array; manifest: Manifest }> {
  const manifest = await decryptManifest(
    masterKey, encryptedFileKey, encryptedFileKeyNonce,
    encryptedManifest, encryptedManifestNonce,
  );
  const fileKey = await unwrapMasterKey(
    toWrapped(fromBase64(encryptedFileKey), fromBase64(encryptedFileKeyNonce)),
    masterKey,
  );
  const ivBase = fromBase64(manifest.iv_base);
  const plaintext = await decryptChunk(fileKey, chunkIv(ivBase, 0), ciphertext);
  return { plaintext, manifest };
}

/** Number of chunks for a file of `size` bytes (1-chunk floor). */
export function chunkCount(size: number, chunkSize: number = FILE_CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/** Encrypt chunk `index` of a file (thin wrapper over the IV scheme). */
export async function encryptFileChunk(
  fileKey: RawKey,
  ivBase: Uint8Array,
  index: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  return encryptChunk(fileKey, chunkIv(ivBase, index), plaintext);
}

/** Decrypt chunk `index` of a file. */
export async function decryptFileChunk(
  fileKey: RawKey,
  ivBase: Uint8Array,
  index: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  return decryptChunk(fileKey, chunkIv(ivBase, index), ciphertext);
}
