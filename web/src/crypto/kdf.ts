/**
 * Key Derivation Functions.
 *
 * `derivePasswordKey`: master KDF from the user's password. Uses Argon2id with
 *   high memory cost (64 MiB) so brute-force is expensive. The salt is derived
 *   from the email so the same password+email always produces the same key
 *   (allowing re-derivation on new devices).
 *
 * `deriveAuthVerifier`: a second Argon2id pass over `password_key` with a
 *   server-provided salt. The output is what the server stores (after its own
 *   hash). The server never sees `password_key`.
 *
 * `deriveSubkey`: HKDF-based key separation off `master_key`.
 */

import { assertCryptoReady, sodium } from "./index";

export const ARGON2_MEMORY_KIB = 64 * 1024; // 64 MiB
export const ARGON2_TIME_COST = 3;
export const ARGON2_PARALLELISM = 1; // WebCrypto/WASM single-threaded; raise in Worker if needed
export const KEY_BYTES = 32;

export type RawKey = Uint8Array;

/** Normalise email for use as KDF salt source (lowercased, trimmed). */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Derive a deterministic Argon2id salt (16 bytes) from the email. */
export async function emailToSalt(email: string): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normaliseEmail(email)) as BufferSource,
  );
  return new Uint8Array(hash).slice(0, 16);
}

/** Derive the user's `password_key` (32 bytes) from password + email. */
export async function derivePasswordKey(
  password: string,
  email: string,
): Promise<RawKey> {
  assertCryptoReady();
  const salt = await emailToSalt(email);
  // Extend salt to pwhash_SALTBYTES (16 bytes) by padding with zeros.
  const fullSalt = new Uint8Array(sodium.crypto_pwhash_SALTBYTES);
  fullSalt.set(salt);
  return sodium.crypto_pwhash(
    KEY_BYTES,
    password,
    fullSalt,
    ARGON2_TIME_COST,
    ARGON2_MEMORY_KIB,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/**
 * Derive the verifier sent to the server during registration/login.
 * The server stores a further hash of this value.
 */
export function deriveAuthVerifier(
  passwordKey: RawKey,
  serverSalt: Uint8Array,
): RawKey {
  assertCryptoReady();
  return sodium.crypto_pwhash(
    KEY_BYTES,
    sodium.to_base64(passwordKey),
    serverSalt,
    ARGON2_TIME_COST,
    ARGON2_MEMORY_KIB,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** HKDF-style subkey derivation from `master_key` (uses HKDF on WebCrypto). */
export async function deriveSubkey(
  masterKey: RawKey,
  info: string,
  length = KEY_BYTES,
): Promise<RawKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    masterKey as BufferSource,
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0) as BufferSource,
      info: new TextEncoder().encode(info) as BufferSource,
    },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Generate `n` cryptographically random bytes. */
export function randomBytes(n: number): RawKey {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}
