import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the crypto + worker deps so the test exercises store orchestration
// (prelogin → derive → login → unwrap → persist → setSession), not real Argon2.
vi.mock("@/crypto/kdf", () => ({
  normaliseUsername: (s: string) => s.trim().toLowerCase(),
  derivePasswordKey: vi.fn(async () => new Uint8Array(32)),
  deriveAuthVerifier: vi.fn(() => new Uint8Array(32)),
  usernameToSalt: vi.fn(async () => new Uint8Array(16)),
  randomBytes: vi.fn(() => new Uint8Array(16)),
}));
vi.mock("@/crypto/keys", () => ({
  generateMasterKey: () => new Uint8Array(32),
  wrapMasterKey: vi.fn(async () => ({
    ciphertext: new Uint8Array(8),
    iv: new Uint8Array(12),
  })),
  unwrapMasterKey: vi.fn(async () => new Uint8Array(32)),
  getOrCreateDeviceKey: vi.fn(async () => new Uint8Array(32)),
  persistDeviceWrap: vi.fn(async () => {}),
  loadDeviceWrap: vi.fn(async () => null),
  clearDeviceWrap: vi.fn(async () => {}),
}));
vi.mock("@/workers/crypto", () => ({ ensureCryptoReady: vi.fn(async () => {}) }));

import { setActivePinia, createPinia } from "pinia";
import { useAuthStore } from "./auth";
import { setAuthToken, getRefreshToken } from "@/api/client";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setActivePinia(createPinia());
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setAuthToken(null);
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login", () => {
  it("calls prelogin then login and sets the session", async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/api/auth/prelogin")) {
        return new Response(JSON.stringify({ kdf_salt: "ab", server_salt: "cd" }), {
          status: 200,
        });
      }
      if (url.endsWith("/api/auth/login")) {
        return new Response(
          JSON.stringify({
            user_id: "u1",
            username: "alice",
            encrypted_master_key: "eA==",
            encrypted_master_key_nonce: "bm9uY2U=",
            kdf_salt: "ab",
            tokens: {
              access_token: "AT",
              refresh_token: "RT",
              expires_in: 900,
            },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const auth = useAuthStore();
    await auth.login({ username: "Alice", password: "pw" });

    expect(auth.isAuthenticated).toBe(true);
    expect(auth.username).toBe("alice");
    expect(getRefreshToken()).toBe("RT");
    expect(calls.some((u) => u.endsWith("/api/auth/prelogin"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/api/auth/login"))).toBe(true);
  });

  it("leaves the session unset when login fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/auth/prelogin")) {
        return new Response(JSON.stringify({ kdf_salt: "ab", server_salt: "cd" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: "bad credentials" }), { status: 401 });
    });
    const auth = useAuthStore();
    await expect(auth.login({ username: "alice", password: "bad" })).rejects.toThrow();
    expect(auth.isAuthenticated).toBe(false);
  });
});
