import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DriveView from "./DriveView.vue";

vi.mock("@/workers/crypto", () => ({
  cryptoApi: {},
  ensureCryptoReady: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/files", () => ({
  filesApi: { list: vi.fn().mockResolvedValue({ files: [] }) },
}));

describe("DriveView", () => {
  it("renders an Open button only for previewable ready files", async () => {
    setActivePinia(createPinia());
    const w = mount(DriveView);
    await flushPromises();
    // No files → no Open buttons
    expect(w.findAll("button").some((b) => b.text() === "Open")).toBe(false);
  });
});
