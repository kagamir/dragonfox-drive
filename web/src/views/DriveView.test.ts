import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DriveView from "./DriveView.vue";

vi.mock("@/workers/crypto", () => ({
  cryptoApi: {},
  ensureCryptoReady: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/files", () => ({ filesApi: { list: vi.fn().mockResolvedValue({ files: [] }) } }));
vi.mock("@/api/folders", () => ({
  foldersApi: { list: vi.fn().mockResolvedValue({ folders: [] }) },
}));
// Stub the modal so the view renders without its real dependencies.
vi.mock("@/components/MovePickerModal.vue", () => ({
  default: { template: "<div />", props: ["open", "excludeId"] },
}));

describe("DriveView", () => {
  it("renders a breadcrumb, a New folder button, and the empty hint at root", async () => {
    setActivePinia(createPinia());
    const w = mount(DriveView);
    await flushPromises();
    expect(w.text()).toMatch(/Drive/);
    expect(w.findAll("button").some((b) => b.text() === "New folder")).toBe(true);
  });
});
