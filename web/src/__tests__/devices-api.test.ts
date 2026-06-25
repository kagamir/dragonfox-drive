import { describe, expect, it, vi, beforeEach } from "vitest";

const get = vi.fn();
const del = vi.fn();
vi.mock("../api/client", () => ({
  http: {
    get: (...a: unknown[]) => get(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

const { devicesApi } = await import("../api/devices");

describe("devicesApi", () => {
  beforeEach(() => {
    get.mockReset();
    del.mockReset();
  });

  it("list unwraps .devices", async () => {
    get.mockResolvedValueOnce({
      devices: [
        {
          id: "d1",
          name: "n",
          last_seen_at: null,
          created_at: "t",
          revoked_at: null,
        },
      ],
    });
    const out = await devicesApi.list();
    expect(get).toHaveBeenCalledWith("/api/devices");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("d1");
  });

  it("revoke DELETEs the device id (URL-encoded)", async () => {
    del.mockResolvedValueOnce({ ok: true });
    await devicesApi.revoke("dev 1");
    expect(del).toHaveBeenCalledWith("/api/devices/dev%201");
  });
});
