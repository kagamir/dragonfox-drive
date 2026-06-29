/**
 * Key Derivation Functions.
 *
 * `derivePasswordKey`: master KDF from the user's password. Uses Argon2id with
 *   high memory cost (64 MiB) so brute-force is expensive. The caller supplies a
 *   random per-user `kdf_salt` (generated at registration, fetched via
 *   `/api/auth/prelogin` on login) so the salt carries real per-user entropy —
 *   unlike a username-derived salt, it cannot be precomputed against a known
 *   username. The salt is non-secret and stored server-side.
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

/** Normalise a username for use as the account identifier (lowercased, trimmed). */
export function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Length (bytes) of the random per-user KDF salt. */
export const KDF_SALT_BYTES = 16;

/**
 * Derive the user's `password_key` (32 bytes) from the password and a random
 * per-user `salt`. The salt must be the value stored for this account (random
 * 16 B from registration); pass the bytes returned by `/api/auth/prelogin`.
 */
export async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
): Promise<RawKey> {
  assertCryptoReady();
  // Extend/clamp to pwhash_SALTBYTES (16 bytes): pad short salts with zeros,
  // truncate longer ones. Registration always supplies exactly 16 bytes.
  const fullSalt = new Uint8Array(sodium.crypto_pwhash_SALTBYTES);
  fullSalt.set(salt.subarray(0, sodium.crypto_pwhash_SALTBYTES));
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
