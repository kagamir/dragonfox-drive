import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/api/config", () => ({
  configApi: {
    get: vi.fn(),
  },
}));

import { useConfigStore } from "@/stores/config";
import { configApi } from "@/api/config";

describe("config store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("defaults to open registration and not-loaded", () => {
    const s = useConfigStore();
    expect(s.allowRegistration).toBe(true);
    expect(s.loaded).toBe(false);
  });

  it("load() mirrors the server flag and marks loaded", async () => {
    (configApi.get as any).mockResolvedValue({ allow_registration: false });
    const s = useConfigStore();
    await s.load();
    expect(s.allowRegistration).toBe(false);
    expect(s.loaded).toBe(true);
  });

  it("load() keeps the optimistic default on fetch failure and still marks loaded", async () => {
    (configApi.get as any).mockRejectedValue(new Error("network"));
    const s = useConfigStore();
    await s.load();
    expect(s.allowRegistration).toBe(true);
    expect(s.loaded).toBe(true);
  });
});
