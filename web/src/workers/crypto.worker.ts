/**
 * Crypto worker: off-loads Argon2id + AES-GCM from the main thread so the UI
 * never blocks during login / file encryption.
 *
 * Exposed via Comlink so the main thread can `await cryptoApi.method(...)`.
 */

import * as Comlink from "comlink";

import { initCrypto, sodium } from "@/crypto";
import {
  deriveAuthVerifier,
  derivePasswordKey,
  type RawKey,
} from "@/crypto/kdf";
import {
  decryptChunk,
  encryptChunk,
  chunkIv,
  encrypt,
} from "@/crypto/symmetric";
import {
  generateMasterKey,
  unwrapMasterKey,
  wrapMasterKey,
  type WrappedKey,
} from "@/crypto/keys";
import {
  decryptFile as decryptFilePayload,
  decryptManifest as decryptManifestPayload,
  encryptFile as encryptFilePayload,
  type EncryptedFilePayload,
  type Manifest,
} from "@/crypto/file";

export const api = {
  async init() {
    await initCrypto();
  },

  sodiumReady() {
    return true;
  },

  // --- KDF --------------------------------------------------------------

  async derivePasswordKey(password: string, username: string): Promise<RawKey> {
    return derivePasswordKey(password, username);
  },

  async deriveAuthVerifier(
    passwordKey: RawKey,
    serverSalt: RawKey,
  ): Promise<RawKey> {
    return deriveAuthVerifier(passwordKey, serverSalt);
  },

  randomServerSalt(): RawKey {
    return sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  },

  // --- Master key lifecycle ---------------------------------------------

  newMasterKey(): RawKey {
    return generateMasterKey();
  },

  async wrap(masterKey: RawKey, wrapper: RawKey): Promise<WrappedKey> {
    return wrapMasterKey(masterKey, wrapper);
  },

  async unwrap(wrapped: WrappedKey, wrapper: RawKey): Promise<RawKey> {
    return unwrapMasterKey(wrapped, wrapper);
  },

  // --- File chunks ------------------------------------------------------

  async encryptChunk(
    key: RawKey,
    ivBase: RawKey,
    chunkIndex: number,
    plaintext: RawKey,
  ): Promise<Uint8Array> {
    const iv = chunkIv(ivBase, chunkIndex);
    return encryptChunk(key, iv, plaintext);
  },

  async decryptChunk(
    key: RawKey,
    ivBase: RawKey,
    chunkIndex: number,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array> {
    const iv = chunkIv(ivBase, chunkIndex);
    return decryptChunk(key, iv, ciphertext);
  },

  /** Fresh per-file key material: random fileKey + random iv_base. */
  newFileKeyMaterial(): { fileKey: Uint8Array; ivBase: Uint8Array } {
    return {
      fileKey: sodium.randombytes_buf(32),
      ivBase: sodium.randombytes_buf(12),
    };
  },

  /** Seal an arbitrary blob with a key (random IV) — used for the manifest. */
  async seal(
    key: RawKey,
    plaintext: Uint8Array,
  ): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
    return encrypt(key, plaintext);
  },

  // --- Whole-file orchestration -----------------------------------------

  async encryptFile(
    masterKey: RawKey,
    plaintext: Uint8Array,
    name: string,
    mime: string,
  ): Promise<EncryptedFilePayload> {
    return encryptFilePayload(masterKey, plaintext, name, mime);
  },

  async decryptManifest(
    masterKey: RawKey,
    encryptedFileKey: string,
    encryptedFileKeyNonce: string,
    encryptedManifest: string,
    encryptedManifestNonce: string,
  ): Promise<Manifest> {
    return decryptManifestPayload(
      masterKey, encryptedFileKey, encryptedFileKeyNonce,
      encryptedManifest, encryptedManifestNonce,
    );
  },

  async decryptFile(
    masterKey: RawKey,
    encryptedFileKey: string,
    encryptedFileKeyNonce: string,
    encryptedManifest: string,
    encryptedManifestNonce: string,
    ciphertext: Uint8Array,
  ): Promise<{ plaintext: Uint8Array; manifest: Manifest }> {
    return decryptFilePayload(
      masterKey, encryptedFileKey, encryptedFileKeyNonce,
      encryptedManifest, encryptedManifestNonce, ciphertext,
    );
  },
};

export type CryptoApi = typeof api;

Comlink.expose(api);
