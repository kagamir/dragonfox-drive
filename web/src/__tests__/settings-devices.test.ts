import { describe, expect, it, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const listMock = vi.fn();
const revokeMock = vi.fn();
const logoutMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../api/devices", () => ({
  devicesApi: {
    list: () => listMock(),
    revoke: (id: string) => revokeMock(id),
  },
}));

vi.mock("../api/auth", () => ({
  authApi: { logout: () => logoutMock() },
}));

vi.mock("../api/client", () => ({
  // settings-deps shim; SettingsView doesn't import these directly but Vue's
  // reactivity graph can pull them in transitively.
  setAuthToken: () => {},
  setRefreshToken: () => {},
  clearRefreshToken: () => {},
  loadStoredRefreshToken: () => null,
  getRefreshToken: () => null,
  onSessionLost: () => {},
  http: { get: () => Promise.resolve({}), post: () => Promise.resolve({}) },
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
  RouterLink: { template: "<a><slot /></a>" },
}));

vi.mock("../stores/files", () => ({
  useFilesStore: () => ({ refresh: vi.fn().mockResolvedValue(undefined), displayNames: {} }),
}));
vi.mock("../stores/shares", () => ({
  useSharesStore: () => ({ all: [], loadAll: vi.fn().mockResolvedValue(undefined) }),
}));

// Stub the auth store so we can inject a deterministic deviceId without
// driving the full login flow. Keep the shape compatible with the real store.
// Real Pinia stores unwrap refs on property access; the mock returns a plain
// object, so we read `.value` here to surface the unwrapped string the
// component expects (matching `auth.deviceId` semantics in production).
const currentDeviceId = { value: "cur" };
vi.mock("../stores/auth", () => ({
  useAuthStore: () => ({
    username: "alice",
    deviceId: currentDeviceId.value,
    isAuthenticated: true,
    logout: vi.fn().mockResolvedValue(undefined),
  }),
}));

const SettingsView = (await import("../views/SettingsView.vue")).default;

function mountWith(currentId: string) {
  setActivePinia(createPinia());
  currentDeviceId.value = currentId;
  return mount(SettingsView);
}

describe("SettingsView Devices card", () => {
  beforeEach(() => {
    listMock.mockReset();
    revokeMock.mockReset();
    logoutMock.mockReset();
  });

  it("marks the current device; revoked rows have no action button", async () => {
    listMock.mockResolvedValueOnce([
      { id: "cur",   name: "Chrome · macOS",   last_seen_at: null, created_at: "2026-06-25T00:00:00Z", revoked_at: null },
      { id: "other", name: "Firefox · Windows", last_seen_at: null, created_at: "2026-06-20T00:00:00Z", revoked_at: null },
      { id: "gone",  name: "Safari · iOS",     last_seen_at: null, created_at: "2026-06-10T00:00:00Z", revoked_at: "2026-06-15T00:00:00Z" },
    ]);
    const w = mountWith("cur");
    await flushPromises();

    const text = w.text();
    expect(text).toContain("Chrome · macOS");
    expect(text).toContain("Current device");
    expect(text).toContain("Firefox · Windows");
    expect(text).toContain("Safari · iOS");

    const labels = w.findAll("button").map((b) => b.text());
    expect(labels).toContain("Sign out");
    expect(labels).toContain("Revoke");

    const revokedRow = w.findAll("tr").find((tr) => tr.text().includes("Safari"));
    expect(revokedRow?.findAll("button").length).toBe(0);
  });

  it("clicking Revoke calls devicesApi.revoke and refetches the list", async () => {
    listMock.mockResolvedValueOnce([
      { id: "cur",   name: "A", last_seen_at: null, created_at: "t", revoked_at: null },
      { id: "other", name: "B", last_seen_at: null, created_at: "t", revoked_at: null },
    ]);
    listMock.mockResolvedValueOnce([
      { id: "cur",   name: "A", last_seen_at: null, created_at: "t", revoked_at: null },
      { id: "other", name: "B", last_seen_at: null, created_at: "t", revoked_at: "2026-06-25T00:00:00Z" },
    ]);
    revokeMock.mockResolvedValueOnce(undefined);

    const w = mountWith("cur");
    await flushPromises();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const revokeBtn = w.findAll("button").find((b) => b.text() === "Revoke");
    await revokeBtn?.trigger("click");
    await flushPromises();

    expect(revokeMock).toHaveBeenCalledWith("other");
    expect(listMock).toHaveBeenCalledTimes(2);
    confirmSpy.mockRestore();
  });
});
