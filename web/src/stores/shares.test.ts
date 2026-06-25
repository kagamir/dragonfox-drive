import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/api/shares", () => ({
  sharesApi: {
    listAll: vi.fn(),
    listForFile: vi.fn(),
    revoke: vi.fn(),
    purge: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    verify: vi.fn(),
    getChunk: vi.fn(),
  },
}));
vi.mock("@/workers/crypto", () => ({ cryptoApi: {}, ensureCryptoReady: vi.fn() }));
vi.mock("@/stores/files", () => ({ useFilesStore: () => ({}) }));
vi.mock("@/crypto/file", () => ({ toBase64: vi.fn() }));

import { useSharesStore } from "@/stores/shares";
import { sharesApi } from "@/api/shares";
import type { ShareListItem } from "@/api/types";

function item(id: string, fileId: string): ShareListItem {
  return {
    file_id: fileId,
    id,
    state: "active",
    requires_password: false,
    expires_at: null,
    download_limit: null,
    download_count: 0,
    revoked_at: null,
    created_at: "t",
  };
}

describe("shares store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("loadAll populates all from the api", async () => {
    (sharesApi.listAll as any).mockResolvedValue({ shares: [item("s1", "f1")] });
    const s = useSharesStore();
    await s.loadAll();
    expect(s.all).toHaveLength(1);
    expect(s.all[0].id).toBe("s1");
    expect(s.all[0].file_id).toBe("f1");
  });

  it("purge calls the api and reloads all", async () => {
    (sharesApi.purge as any).mockResolvedValue({ ok: true });
    (sharesApi.listAll as any).mockResolvedValue({ shares: [] });
    const s = useSharesStore();
    await s.purge("s1");
    expect(sharesApi.purge).toHaveBeenCalledWith("s1");
    expect(sharesApi.listAll).toHaveBeenCalled();
    expect(s.all).toHaveLength(0);
  });
});
