/**
 * Crypto subsystem entry point.
 *
 * Design summary (see docs/crypto-design.md):
 *
 *   password ─Argon2id→ password_key
 *                  ├──→ auth_verifier (sent to server for auth)
 *                  └──→ unwrap master_key
 *
 *   master_key (random 32B, never leaves client) ─→ wrap per-file key
 *
 *   file_key (random AES-256-GCM key per file) ─→ encrypt manifest + chunks
 *
 * Crypto primitives are split for performance:
 *   - Argon2id, X25519, Ed25519  → libsodium (WASM)
 *   - AES-GCM, HKDF, getRandomValues → WebCrypto (native, fastest)
 */

import sodium from "libsodium-wrappers-sumo";

let ready = false;

/** Initialise libsodium (WASM). Must be awaited before any crypto call. */
export async function initCrypto(): Promise<void> {
  if (ready) return;
  await sodium.ready;
  ready = true;
}

/** Internal: assert libsodium is ready. */
export function assertCryptoReady(): void {
  if (!ready) {
    throw new Error("Crypto subsystem not initialised - await initCrypto() first");
  }
}

export { sodium };
