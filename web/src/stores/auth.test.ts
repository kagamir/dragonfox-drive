import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the crypto + worker deps so the test exercises store orchestration
// (prelogin → derive → login → unwrap → persist → setSession), not real Argon2.
vi.mock("@/crypto/kdf", () => ({
  normaliseUsername: (s: string) => s.trim().toLowerCase(),
  derivePasswordKey: vi.fn(async () => new Uint8Array(32)),
  deriveAuthVerifier: vi.fn(() => new Uint8Array(32)),
  KDF_SALT_BYTES: 16,
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
  persistDeviceId: vi.fn(async () => {}),
  loadDeviceWrap: vi.fn(async () => null),
  loadDeviceId: vi.fn(async () => null),
  clearDeviceWrap: vi.fn(async () => {}),
  clearDeviceId: vi.fn(async () => {}),
}));
vi.mock("@/workers/crypto", () => ({ ensureCryptoReady: vi.fn(async () => {}) }));

import { setActivePinia, createPinia } from "pinia";
import { useAuthStore } from "./auth";
import { setAuthToken, getRefreshToken } from "@/api/client";
import { loadDeviceWrap } from "@/crypto/keys";

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
            device_id: "dev-1",
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

describe("ensureSessionRestored (refresh-page race fix)", () => {
  function mockRefreshSuccess() {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/auth/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "AT2", refresh_token: "RT2", expires_in: 900 }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });
  }

  function mockRefreshFailure() {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ error: "token expired" }), { status: 401 }),
    );
  }

  it("triggers the refresh-token exchange only once across concurrent callers", async () => {
    localStorage.setItem("df_refresh_token", "RT");
    mockRefreshSuccess();
    const auth = useAuthStore();
    // The router guard and main.ts both call this on first paint; Pinia
    // wraps action return values so identity comparison is unreliable, but
    // the underlying restore must run exactly once (single /refresh call).
    await Promise.all([auth.ensureSessionRestored(), auth.ensureSessionRestored()]);
    const refreshCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).endsWith("/api/auth/refresh"),
    );
    expect(refreshCalls).toHaveLength(1);
    expect(auth.isAuthenticated).toBe(true);
  });

  it("marks the session authenticated when the refresh token is still valid", async () => {
    localStorage.setItem("df_refresh_token", "RT");
    mockRefreshSuccess();
    const auth = useAuthStore();
    await auth.ensureSessionRestored();
    expect(auth.isAuthenticated).toBe(true);
    expect(getRefreshToken()).toBe("RT2");
  });

  it("leaves the session unauthenticated when the refresh token is expired/revoked", async () => {
    localStorage.setItem("df_refresh_token", "RT");
    mockRefreshFailure();
    const auth = useAuthStore();
    await auth.ensureSessionRestored();
    expect(auth.isAuthenticated).toBe(false);
    expect(getRefreshToken()).toBeNull();
  });

  it("keeps isRestoring true until the restore promise settles", async () => {
    localStorage.setItem("df_refresh_token", "RT");
    let resolveRefresh!: (r: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const auth = useAuthStore();
    const p = auth.ensureSessionRestored();
    // Let the restore coroutine advance until it hits the pending fetch.
    await vi.waitFor(() => expect(resolveRefresh).toBeDefined());
    expect(auth.isRestoring).toBe(true);
    resolveRefresh(
      new Response(
        JSON.stringify({ access_token: "AT2", refresh_token: "RT2", expires_in: 900 }),
        { status: 200 },
      ),
    );
    await p;
    expect(auth.isRestoring).toBe(false);
    expect(auth.isAuthenticated).toBe(true);
  });

  it("treats an absent refresh token as 'nothing to restore' (no logout storm)", async () => {
    // No df_refresh_token in localStorage.
    const auth = useAuthStore();
    await auth.ensureSessionRestored();
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.isRestoring).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restores the username from the persisted device wrap", async () => {
    // The /api/auth/refresh response only carries tokens, so the username
    // must come from the device-identity bundle in IndexedDB. Without this,
    // the Settings page's "Signed in as <name>" goes blank after refresh.
    localStorage.setItem("df_refresh_token", "RT");
    vi.mocked(loadDeviceWrap).mockResolvedValueOnce({
      userId: "u1",
      username: "alice",
      wrap: { ciphertext: new Uint8Array(8), iv: new Uint8Array(12) },
    });
    mockRefreshSuccess();
    const auth = useAuthStore();
    await auth.ensureSessionRestored();
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.username).toBe("alice");
  });
});
