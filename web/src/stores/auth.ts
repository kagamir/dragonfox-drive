/**
 * Auth store: holds the decrypted `master_key` in memory (never persisted)
 * and manages login / register / device-restore flows.
 */

import { defineStore } from "pinia";
import { ref } from "vue";

import { authApi } from "@/api/auth";
import {
  setAuthToken,
  setRefreshToken,
  clearRefreshToken,
  loadStoredRefreshToken,
  getRefreshToken,
} from "@/api/client";
import type { TokenPair } from "@/api/types";
import {
  deriveAuthVerifier,
  derivePasswordKey,
  normaliseUsername,
  randomBytes,
  usernameToSalt,
  type RawKey,
} from "@/crypto/kdf";
import {
  clearDeviceWrap,
  generateMasterKey,
  getOrCreateDeviceKey,
  loadDeviceId,
  loadDeviceWrap,
  persistDeviceId,
  persistDeviceWrap,
  unwrapMasterKey,
  wrapMasterKey,
} from "@/crypto/keys";
import { ensureCryptoReady } from "@/workers/crypto";

export const useAuthStore = defineStore("auth", () => {
  const isAuthenticated = ref(false);
  const userId = ref<string | null>(null);
  const username = ref<string | null>(null);
  const masterKey = ref<RawKey | null>(null);
  const deviceId = ref<string | null>(null);
  const isRestoring = ref(true);

  function setSession(
    info: { user_id: string; username: string },
    key: RawKey,
    tokens: TokenPair,
  ) {
    userId.value = info.user_id;
    username.value = info.username;
    masterKey.value = key;
    setAuthToken(tokens.access_token);
    setRefreshToken(tokens.refresh_token);
    isAuthenticated.value = true;
  }

  async function tryRestoreSession(): Promise<void> {
    try {
      await ensureCryptoReady();
      loadStoredRefreshToken();

      // Restore master_key from device wrap (if present).
      const stored = await loadDeviceWrap();
      if (stored) {
        const deviceKey = await getOrCreateDeviceKey();
        masterKey.value = await unwrapMasterKey(stored.wrap, deviceKey);
        userId.value = stored.userId;
        deviceId.value = await loadDeviceId();
      }

      // Obtain a fresh access token via the refresh endpoint.
      const rt = getRefreshToken();
      if (rt) {
        const pair = await authApi.refresh(rt);
        setAuthToken(pair.access_token);
        setRefreshToken(pair.refresh_token);
        isAuthenticated.value = true;
      }
    } catch (e) {
      console.warn("Failed to restore session:", e);
      clearRefreshToken();
      setAuthToken(null);
    } finally {
      isRestoring.value = false;
    }
  }

  async function register(p: { username: string; password: string }): Promise<void> {
    await ensureCryptoReady();
    const normalised = normaliseUsername(p.username);

    const passwordKey = await derivePasswordKey(p.password, normalised);
    const serverSalt = randomBytes(16);
    const authVerifier = deriveAuthVerifier(passwordKey, serverSalt);

    const master = generateMasterKey();
    const { ciphertext, iv } = await wrapMasterKey(master, passwordKey);

    // Pre-create a device wrap so the user is immediately logged-in on
    // this device without re-entering the password.
    const deviceKey = await getOrCreateDeviceKey();
    const deviceWrap = await wrapMasterKey(master, deviceKey);

    const res = await authApi.register({
      username: normalised,
      auth_verifier: toHex(authVerifier),
      kdf_salt: toHex(await usernameToSalt(normalised)),
      server_salt: toHex(serverSalt),
      encrypted_master_key: toBase64(ciphertext),
      encrypted_master_key_nonce: toBase64(iv),
    });

    await persistDeviceWrap(res.user_id, deviceWrap);
    await persistDeviceId(res.user_id, res.device_id);
    deviceId.value = res.device_id;
    setSession(res, master, res.tokens);
  }

  async function login(p: { username: string; password: string }): Promise<void> {
    await ensureCryptoReady();
    const normalised = normaliseUsername(p.username);

    const pre = await authApi.prelogin(normalised);
    const passwordKey = await derivePasswordKey(p.password, normalised);
    const authVerifier = deriveAuthVerifier(passwordKey, fromHex(pre.server_salt));

    const res = await authApi.login({
      username: normalised,
      auth_verifier: toHex(authVerifier),
    });

    const master = await unwrapMasterKey(
      {
        ciphertext: fromBase64(res.encrypted_master_key),
        iv: fromBase64(res.encrypted_master_key_nonce),
      },
      passwordKey,
    );

    const deviceKey = await getOrCreateDeviceKey();
    const deviceWrap = await wrapMasterKey(master, deviceKey);
    await persistDeviceWrap(res.user_id, deviceWrap);
    await persistDeviceId(res.user_id, res.device_id);
    deviceId.value = res.device_id;

    setSession(res, master, res.tokens);
  }

  async function logout(): Promise<void> {
    setAuthToken(null);
    clearRefreshToken();
    isAuthenticated.value = false;
    userId.value = null;
    username.value = null;
    masterKey.value = null;
    await clearDeviceWrap();
    deviceId.value = null;
  }

  return {
    isAuthenticated,
    userId,
    username,
    masterKey,
    deviceId,
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

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
