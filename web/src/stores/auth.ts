/**
 * Auth store: holds the decrypted `master_key` in memory (never persisted)
 * and manages login / register / device-restore flows.
 */

import { defineStore } from "pinia";
import { ref } from "vue";

import { authApi } from "@/api/auth";
import { setAuthToken } from "@/api/client";
import {
  deriveAuthVerifier,
  derivePasswordKey,
  normaliseEmail,
  randomBytes,
  type RawKey,
} from "@/crypto/kdf";
import {
  clearDeviceWrap,
  generateMasterKey,
  getOrCreateDeviceKey,
  loadDeviceWrap,
  persistDeviceWrap,
  unwrapMasterKey,
  unwrapWithPassword,
  wrapMasterKey,
} from "@/crypto/keys";
import { ensureCryptoReady } from "@/workers/crypto";

export const useAuthStore = defineStore("auth", () => {
  const isAuthenticated = ref(false);
  const userId = ref<string | null>(null);
  const email = ref<string | null>(null);
  const masterKey = ref<RawKey | null>(null);
  const isRestoring = ref(true);

  function setSession(
    info: { user_id: string; email: string },
    key: RawKey,
    accessToken: string,
  ) {
    userId.value = info.user_id;
    email.value = info.email;
    masterKey.value = key;
    setAuthToken(accessToken);
    isAuthenticated.value = true;
  }

  /**
   * Try to restore the session by reading the device_wrap from IndexedDB and
   * unwrapping the master_key with the device_key. Enables passwordless
   * re-entry on a previously authenticated browser.
   */
  async function tryRestoreSession(): Promise<void> {
    try {
      await ensureCryptoReady();
      const stored = await loadDeviceWrap();
      if (!stored) return;

      const deviceKey = await getOrCreateDeviceKey();
      const key = await unwrapMasterKey(stored.wrap, deviceKey);
      // Note: in a full impl we'd also fetch a fresh access_token here.
      // For now we only restore the master_key; the user will be redirected
      // to /login to obtain a new short-lived JWT.
      masterKey.value = key;
      userId.value = stored.userId;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("Failed to restore device session:", e);
    } finally {
      isRestoring.value = false;
    }
  }

  async function register(p: {
    email: string;
    password: string;
  }): Promise<void> {
    await ensureCryptoReady();
    const normalised = normaliseEmail(p.email);

    const passwordKey = await derivePasswordKey(p.password, normalised);
    const serverSalt = randomBytes(16);
    const authVerifier = deriveAuthVerifier(passwordKey, serverSalt);

    const master = generateMasterKey();
    const { ciphertext, iv } = await wrapMasterKey(master, passwordKey);

    // Pre-create device wrap so the user is immediately logged-in on
    // this device without re-entering the password.
    const deviceKey = await getOrCreateDeviceKey();
    const deviceWrap = await wrapMasterKey(master, deviceKey);

    const res = await authApi.register({
      email: normalised,
      auth_verifier: toHex(authVerifier),
      kdf_salt: toHex(await derivePasswordKeySalt(normalised)),
      server_salt: toHex(serverSalt),
      encrypted_master_key: toBase64(ciphertext),
      encrypted_master_key_nonce: toBase64(iv),
    });

    await persistDeviceWrap(res.user_id, deviceWrap);
    setSession(res, master, res.tokens.access_token);
  }

  async function login(p: { email: string; password: string }): Promise<void> {
    await ensureCryptoReady();
    const normalised = normaliseEmail(p.email);

    const _passwordKey = await derivePasswordKey(p.password, normalised);
    // The client doesn't know the server_salt ahead of time; the real flow
    // will fetch it from a /api/auth/prelogin endpoint. For the scaffold we
    // assume the server returns it in the login response challenge.
    // TODO(p1-impl): add prelogin endpoint that returns kdf_salt + server_salt.
    void _passwordKey;
    throw new Error(
      "login flow requires prelogin endpoint (to be implemented in p1)",
    );
  }

  async function logout(): Promise<void> {
    setAuthToken(null);
    isAuthenticated.value = false;
    userId.value = null;
    email.value = null;
    masterKey.value = null;
    await clearDeviceWrap();
  }

  return {
    isAuthenticated,
    userId,
    email,
    masterKey,
    isRestoring,
    tryRestoreSession,
    register,
    login,
    logout,
  };
});

// --- encoding helpers (kept local to avoid a separate util import) -------

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function derivePasswordKeySalt(_email: string): Promise<Uint8Array> {
  // Placeholder - in p1 this comes from the prelogin endpoint.
  return Promise.resolve(new Uint8Array(16));
}
