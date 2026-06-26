import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SharesView from "./SharesView.vue";
import { useConfirm } from "@/composables/useConfirm";
import { i18n } from "@/locales";
import type { ShareListItem } from "@/api/types";

// Mutable, per-test-controllable stub state. vi.hoisted makes `STUB` available
// to the vi.mock factories below (which run at module load) and to each test.
const STUB = vi.hoisted(() => ({
  shares: [] as ShareListItem[],
  displayNames: {} as Record<string, string>,
  refresh: vi.fn().mockResolvedValue(undefined),
  loadAll: vi.fn().mockResolvedValue(undefined),
  revoke: vi.fn().mockResolvedValue(undefined),
  purge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ username: "tester" }),
}));
vi.mock("@/stores/files", () => ({
  useFilesStore: () => ({
    get displayNames() { return STUB.displayNames; },
    refresh: STUB.refresh,
  }),
}));
vi.mock("@/stores/shares", () => ({
  useSharesStore: () => ({
    get all() { return STUB.shares; },
    loadAll: STUB.loadAll,
    revoke: STUB.revoke,
    purge: STUB.purge,
  }),
}));

const stubs = { RouterLink: { template: "<slot />" } };

function makeShare(over: Partial<ShareListItem> = {}): ShareListItem {
  return {
    file_id: "file-1",
    id: "share-1",
    state: "active",
    requires_password: false,
    expires_at: null,
    download_limit: null,
    download_count: 0,
    revoked_at: null,
    created_at: "2025-01-01T00:00:00Z",
    ...over,
  };
}

describe("SharesView", () => {
  beforeEach(() => {
    STUB.shares = [];
    STUB.displayNames = {};
    STUB.refresh.mockClear();
    STUB.loadAll.mockClear();
    STUB.revoke.mockClear();
    STUB.purge.mockClear();
  });

  it("renders the empty state when there are no shares", async () => {
    setActivePinia(createPinia());
    const w = mount(SharesView, { global: { stubs, plugins: [i18n] } });
    await flushPromises();
    expect(w.text()).toContain(i18n.global.t("share.noShares"));
    expect(STUB.loadAll).toHaveBeenCalled();
  });

  it("renders a share row with its display name, badge and action buttons", async () => {
    setActivePinia(createPinia());
    STUB.shares = [makeShare()];
    STUB.displayNames = { "file-1": "report.pdf" };
    const w = mount(SharesView, { global: { stubs, plugins: [i18n] } });
    await flushPromises();
    expect(w.text()).toContain("report.pdf");
    expect(w.findAll("button").some((b) => b.text() === i18n.global.t("share.revoke"))).toBe(true);
    expect(w.findAll("button").some((b) => b.text() === i18n.global.t("share.purge"))).toBe(true);
  });

  it("revokes the share when the confirm dialog is accepted", async () => {
    setActivePinia(createPinia());
    STUB.shares = [makeShare({ id: "share-1", file_id: "file-1" })];
    const w = mount(SharesView, { global: { stubs, plugins: [i18n] } });
    await flushPromises();

    await w.findAll("button").find((b) => b.text() === i18n.global.t("share.revoke"))!.trigger("click");
    useConfirm()._resolve(true);
    await flushPromises();

    expect(STUB.revoke).toHaveBeenCalledWith("file-1", "share-1");
  });

  it("does nothing when the revoke confirm dialog is cancelled", async () => {
    setActivePinia(createPinia());
    STUB.shares = [makeShare({ id: "share-1", file_id: "file-1" })];
    const w = mount(SharesView, { global: { stubs, plugins: [i18n] } });
    await flushPromises();

    await w.findAll("button").find((b) => b.text() === i18n.global.t("share.revoke"))!.trigger("click");
    useConfirm()._resolve(false);
    await flushPromises();

    expect(STUB.revoke).not.toHaveBeenCalled();
  });
});
