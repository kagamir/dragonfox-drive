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

// The redesigned SettingsView routes confirms through useConfirm and surfaces
// outcomes through useToast. Mock both so the test can drive confirmations
// without rendering the global dialog, and assert side effects deterministically.
const confirmMock = vi.fn().mockResolvedValue(true);
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("../composables/useConfirm", () => ({
  useConfirm: () => ({ state: { value: { open: false } }, confirm: confirmMock }),
}));
vi.mock("../composables/useToast", () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: vi.fn(), warning: vi.fn() }),
}));

const SettingsView = (await import("../views/SettingsView.vue")).default;

function mountWith(currentId: string) {
  setActivePinia(createPinia());
  currentDeviceId.value = currentId;
  return mount(SettingsView);
}

// The redesign hides devices behind the "设备" segmented tab; switch to it
// before assertions so the devices card is rendered.
async function switchToDevices(w: ReturnType<typeof mount>) {
  const tabBtn = w.findAll("button").find((b) => b.text() === "设备");
  await tabBtn?.trigger("click");
  await flushPromises();
}

describe("SettingsView Devices card", () => {
  beforeEach(() => {
    listMock.mockReset();
    revokeMock.mockReset();
    logoutMock.mockReset();
    confirmMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    confirmMock.mockResolvedValue(true);
  });

  it("marks the current device and renders revoke for others", async () => {
    listMock.mockResolvedValueOnce([
      { id: "cur",   name: "Chrome · macOS",   last_seen_at: null, created_at: "2026-06-25T00:00:00Z" },
      { id: "other", name: "Firefox · Windows", last_seen_at: null, created_at: "2026-06-20T00:00:00Z" },
    ]);
    const w = mountWith("cur");
    await flushPromises();
    await switchToDevices(w);

    const text = w.text();
    expect(text).toContain("Chrome · macOS");
    expect(text).toContain("当前设备");
    expect(text).toContain("Firefox · Windows");

    const labels = w.findAll("button").map((b) => b.text());
    expect(labels).toContain("退出登录");
    expect(labels).toContain("吊销");
  });

  it("clicking 吊销 calls devicesApi.revoke, refetches, and toasts success", async () => {
    listMock.mockResolvedValueOnce([
      { id: "cur",   name: "A", last_seen_at: null, created_at: "t" },
      { id: "other", name: "B", last_seen_at: null, created_at: "t" },
    ]);
    listMock.mockResolvedValueOnce([
      { id: "cur", name: "A", last_seen_at: null, created_at: "t" },
    ]);
    revokeMock.mockResolvedValueOnce(undefined);

    const w = mountWith("cur");
    await flushPromises();
    await switchToDevices(w);

    const revokeBtn = w.findAll("button").find((b) => b.text() === "吊销");
    await revokeBtn?.trigger("click");
    await flushPromises();

    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ danger: true, confirmText: "吊销" }));
    expect(revokeMock).toHaveBeenCalledWith("other");
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(toastSuccess).toHaveBeenCalledWith("已吊销");
  });

  it("canceling the confirm dialog leaves the device list untouched", async () => {
    listMock.mockResolvedValueOnce([
      { id: "cur",   name: "A", last_seen_at: null, created_at: "t" },
      { id: "other", name: "B", last_seen_at: null, created_at: "t" },
    ]);
    confirmMock.mockResolvedValueOnce(false);

    const w = mountWith("cur");
    await flushPromises();
    await switchToDevices(w);

    const revokeBtn = w.findAll("button").find((b) => b.text() === "吊销");
    await revokeBtn?.trigger("click");
    await flushPromises();

    expect(revokeMock).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
