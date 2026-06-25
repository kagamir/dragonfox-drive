import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const createMock = vi.fn();
const loadMock = vi.fn();
vi.mock("@/stores/shares", () => ({
  useSharesStore: () => ({
    byFile: {},
    all: [],
    creating: false,
    error: null,
    load: loadMock,
    loadAll: vi.fn(),
    create: createMock,
    revoke: vi.fn(),
    purge: vi.fn(),
  }),
}));

import ShareDialog from "@/components/ShareDialog.vue";
import type { FileMeta } from "@/api/types";

const file = { id: "f1" } as unknown as FileMeta;

describe("ShareDialog", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    createMock.mockResolvedValue({ id: "s1", url: "https://x/#/s/s1?k=k" });
  });

  it("creates a share using numeric expiry (hours) and a numeric limit", async () => {
    const w = mount(ShareDialog, { props: { file } });

    const expiryInput = w.find('input[placeholder="Never"]');
    const limitInput = w.find('input[placeholder="Unlimited"]');
    await expiryInput.setValue("2");
    await w.find("select").setValue("hours");
    await limitInput.setValue("5");

    await w.find("button.primary").trigger("click");
    await vi.waitFor(() => expect(createMock).toHaveBeenCalled());

    const arg = createMock.mock.calls[0][1] as {
      expiresAt: string;
      downloadLimit: number | null;
      password: string | undefined;
    };
    expect(arg.downloadLimit).toBe(5);
    const lower = Date.now() + 2 * 3_600_000 - 5000;
    const upper = Date.now() + 2 * 3_600_000 + 5000;
    expect(new Date(arg.expiresAt).getTime()).toBeGreaterThanOrEqual(lower);
    expect(new Date(arg.expiresAt).getTime()).toBeLessThanOrEqual(upper);
  });

  it("omits expiresAt and downloadLimit when left blank", async () => {
    const w = mount(ShareDialog, { props: { file } });
    await w.find("button.primary").trigger("click");
    await vi.waitFor(() => expect(createMock).toHaveBeenCalled());
    const arg = createMock.mock.calls[0][1] as {
      expiresAt: string | null;
      downloadLimit: number | null;
    };
    expect(arg.expiresAt).toBeNull();
    expect(arg.downloadLimit).toBeNull();
  });
});
