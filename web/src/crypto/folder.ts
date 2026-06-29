/**
 * Folder crypto: the folder_key hierarchy + encrypted metadata helpers.
 *
 * Model (see docs/crypto-design.md P3 §):
 *   - Each folder has a random 32-byte folder_key.
 *   - folder_key is wrapped (AES-GCM) by the PARENT's folder_key, or by
 *     master_key for root folders.
 *   - A folder's NAME is encrypted with its OWN folder_key.
 *   - The PARENT POINTER is ALWAYS encrypted with master_key — never
 *     folder_key — so the client can recover tree shape before walking the
 *     key-wrap chain (breaks the bootstrapping cycle).
 *
 * Operates on raw Uint8Array; base64 (de)serialization is the store's job.
 */

import { encrypt, decrypt } from "./symmetric";
import { randomBytes, type RawKey } from "./kdf";
import { pad, unpad } from "./pad";
import type { WrappedKey } from "./keys";

/** Block size (bytes) for name padding — hides exact name length. */
const NAME_PAD_BLOCK = 32;

export interface EncryptedFieldRaw {
  ciphertext: Uint8Array;
  iv: Uint8Array;
}

export function newFolderKey(): RawKey {
  return randomBytes(32);
}

export async function encryptFolderName(
  folderKey: RawKey,
  name: string,
): Promise<EncryptedFieldRaw> {
  // Pad before encrypting so the ciphertext length only reveals the 32-byte
  // bucket the name falls into, not its exact length.
  const padded = pad(new TextEncoder().encode(name), NAME_PAD_BLOCK);
  const enc = await encrypt(folderKey, padded);
  return { ciphertext: enc.ciphertext, iv: enc.iv };
}

export async function decryptFolderName(
  folderKey: RawKey,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<string> {
  const plain = await decrypt(folderKey, ciphertext, iv);
  return new TextDecoder().decode(unpad(plain));
}

export async function encryptParentId(
  masterKey: RawKey,
  parentId: string | null,
): Promise<EncryptedFieldRaw | null> {
  if (parentId === null) return null;
  const enc = await encrypt(masterKey, new TextEncoder().encode(parentId));
  return { ciphertext: enc.ciphertext, iv: enc.iv };
}

export async function decryptParentId(
  masterKey: RawKey,
  ciphertext: Uint8Array | null,
  iv: Uint8Array | null,
): Promise<string | null> {
  if (ciphertext === null || iv === null) return null;
  const plain = await decrypt(masterKey, ciphertext, iv);
  return new TextDecoder().decode(plain);
}

export async function wrapFolderKey(
  folderKey: RawKey,
  wrapperKey: RawKey,
): Promise<WrappedKey> {
  const enc = await encrypt(wrapperKey, folderKey);
  return { ciphertext: enc.ciphertext, iv: enc.iv };
}

export async function unwrapFolderKey(
  wrapped: WrappedKey,
  wrapperKey: RawKey,
): Promise<RawKey> {
  return decrypt(wrapperKey, wrapped.ciphertext, wrapped.iv);
}
