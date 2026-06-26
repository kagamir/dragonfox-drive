/**
 * Key hierarchy & lifecycle helpers.
 *
 * Key layout (see docs/crypto-design.md):
 *   - `master_key`: random 32 bytes, generated once per user. Root of trust.
 *   - `file_key`:   random 32 bytes, one per file. Wraps file chunks.
 *   - `password_key`: Argon2id(password, username). Used to wrap `master_key`
 *     for cross-device password login.
 *   - `device_key`: random 32 bytes, persisted in IndexedDB per browser.
 *     Wraps `master_key` for passwordless unlock from this device.
 *
 * Wrapping format:
 *   AES-GCM(wrap_key, master_key, iv) → { ciphertext, iv }
 */

import localforage from "localforage";

import {
  decrypt,
  encrypt,
} from "./symmetric";
import {
  derivePasswordKey,
  randomBytes,
  type RawKey,
} from "./kdf";

const STORE_KEYS = localforage.createInstance({
  name: "dragonfox-drive",
  storeName: "keys",
});

const KEY_DEVICE = "device_key";
const KEY_DEVICE_WRAP = "device_wrap"; // master_key wrapped by device_key
const KEY_USER_ID = "user_id";
const KEY_DEVICE_ID = "device_id";
const KEY_USERNAME = "username";

export interface WrappedKey {
  ciphertext: Uint8Array;
  iv: Uint8Array;
}

export function toWrapped(ciphertext: Uint8Array, iv: Uint8Array): WrappedKey {
  return { ciphertext, iv };
}

/** Generate a fresh `master_key` for a new user. */
export function generateMasterKey(): RawKey {
  return randomBytes(32);
}

/** Generate a fresh per-file key. */
export function generateFileKey(): RawKey {
  return randomBytes(32);
}

/** Generate (or load existing) `device_key` for this browser. */
export async function getOrCreateDeviceKey(): Promise<RawKey> {
  const existing = (await STORE_KEYS.getItem<Uint8Array>(KEY_DEVICE)) ?? null;
  if (existing) return existing;
  const fresh = randomBytes(32);
  await STORE_KEYS.setItem(KEY_DEVICE, fresh);
  return fresh;
}

/** Wrap `master_key` with `wrapper` key. */
export async function wrapMasterKey(
  masterKey: RawKey,
  wrapper: RawKey,
): Promise<WrappedKey> {
  const { ciphertext, iv } = await encrypt(wrapper, masterKey);
  return { ciphertext, iv };
}

/** Unwrap `master_key` from a `WrappedKey` using `wrapper` key. */
export async function unwrapMasterKey(
  wrapped: WrappedKey,
  wrapper: RawKey,
): Promise<RawKey> {
  return decrypt(wrapper, wrapped.ciphertext, wrapped.iv);
}

/** Wrap `master_key` with the password-derived key. */
export async function wrapWithPassword(
  masterKey: RawKey,
  password: string,
  username: string,
): Promise<WrappedKey> {
  const passwordKey = await derivePasswordKey(password, username);
  return wrapMasterKey(masterKey, passwordKey);
}

/** Unwrap `master_key` using password (login flow). */
export async function unwrapWithPassword(
  wrapped: WrappedKey,
  password: string,
  username: string,
): Promise<RawKey> {
  const passwordKey = await derivePasswordKey(password, username);
  return unwrapMasterKey(wrapped, passwordKey);
}

/** Persist a `device_wrap` so the next visit can unlock without password. */
export async function persistDeviceWrap(
  userId: string,
  username: string,
  wrap: WrappedKey,
): Promise<void> {
  await STORE_KEYS.setItem(KEY_USER_ID, userId);
  await STORE_KEYS.setItem(KEY_USERNAME, username);
  await STORE_KEYS.setItem(KEY_DEVICE_WRAP, wrap);
}

/** Read persisted `device_wrap` (if any) for the current device. */
export async function loadDeviceWrap(): Promise<{
  userId: string;
  username: string | null;
  wrap: WrappedKey;
} | null> {
  const userId = await STORE_KEYS.getItem<string>(KEY_USER_ID);
  const wrap = await STORE_KEYS.getItem<WrappedKey>(KEY_DEVICE_WRAP);
  if (!userId || !wrap) return null;
  // `username` was added after the initial release, so legacy entries may
  // not have it; surface null rather than failing the whole restore.
  const username = await STORE_KEYS.getItem<string>(KEY_USERNAME);
  return { userId, username, wrap };
}

/** Forget this device's stored wrap (logout). */
export async function clearDeviceWrap(): Promise<void> {
  await STORE_KEYS.removeItem(KEY_DEVICE_WRAP);
  await STORE_KEYS.removeItem(KEY_USER_ID);
  await STORE_KEYS.removeItem(KEY_DEVICE_ID);
  await STORE_KEYS.removeItem(KEY_USERNAME);
}

/** Persist the server-assigned `device_id` alongside the user id. */
export async function persistDeviceId(
  userId: string,
  deviceId: string,
): Promise<void> {
  await STORE_KEYS.setItem(KEY_USER_ID, userId);
  await STORE_KEYS.setItem(KEY_DEVICE_ID, deviceId);
}

/** Read persisted `device_id` (if any) for the current device. */
export async function loadDeviceId(): Promise<string | null> {
  return await STORE_KEYS.getItem<string>(KEY_DEVICE_ID);
}

/** Forget only the `device_id` entry. */
export async function clearDeviceId(): Promise<void> {
  await STORE_KEYS.removeItem(KEY_DEVICE_ID);
}
