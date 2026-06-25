/**
 * Share crypto: file_key 的链接再封装与访客解锁。
 *
 * share_key = Argon2id(share_password, share_salt)（与 password_key 同参数）。
 * 链接内含 key 模式：share_password 为随机 32B，URL fragment 承载 base64。
 * 密码模式：share_password 为口令的 UTF-8 字节，URL 不含 key。
 */

import { encrypt, decrypt } from "./symmetric";
import { randomBytes, type RawKey } from "./kdf";
import { assertCryptoReady, sodium } from "./index";
import { toHex } from "./file";
import type { WrappedKey } from "./keys";

const KEY_BYTES = 32;

export function newShareMaterial(): { sharePassword: Uint8Array; shareSalt: Uint8Array } {
  return { sharePassword: randomBytes(32), shareSalt: randomBytes(16) };
}

export function deriveShareKey(sharePassword: Uint8Array, shareSalt: Uint8Array): RawKey {
  assertCryptoReady();
  const salt = new Uint8Array(sodium.crypto_pwhash_SALTBYTES);
  salt.set(shareSalt);
  return sodium.crypto_pwhash(
    KEY_BYTES,
    sodium.to_base64(sharePassword),
    salt,
    3,
    64 * 1024,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export async function wrapFileKeyForShare(
  fileKey: RawKey,
  shareKey: RawKey,
): Promise<WrappedKey> {
  const enc = await encrypt(shareKey, fileKey);
  return { ciphertext: enc.ciphertext, iv: enc.iv };
}

export async function unwrapFileKeyForShare(
  wrapped: WrappedKey,
  shareKey: RawKey,
): Promise<RawKey> {
  return decrypt(shareKey, wrapped.ciphertext, wrapped.iv);
}

export async function shareVerifier(shareKey: RawKey): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", shareKey as BufferSource);
  return toHex(new Uint8Array(digest));
}
