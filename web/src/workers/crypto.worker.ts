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
} from "@/crypto/symmetric";
import {
  generateMasterKey,
  unwrapMasterKey,
  wrapMasterKey,
  type WrappedKey,
} from "@/crypto/keys";

const api = {
  async init() {
    await initCrypto();
  },

  sodiumReady() {
    return true;
  },

  // --- KDF --------------------------------------------------------------

  async derivePasswordKey(password: string, email: string): Promise<RawKey> {
    return derivePasswordKey(password, email);
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
};

export type CryptoApi = typeof api;

Comlink.expose(api);
