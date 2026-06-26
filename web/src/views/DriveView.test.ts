import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DriveView from "./DriveView.vue";

vi.mock("@/workers/crypto", () => ({ cryptoApi: {}, ensureCryptoReady: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/api/files", () => ({ filesApi: { list: vi.fn().mockResolvedValue({ files: [] }) } }));
vi.mock("@/api/folders", () => ({ foldersApi: { list: vi.fn().mockResolvedValue({ folders: [] }) } }));
vi.mock("@/components/MovePickerModal.vue", () => ({ default: { template: "<div />", props: ["open", "excludeId"] } }));

describe("DriveView", () => {
  it("renders header, breadcrumb and new-folder button at root", async () => {
    setActivePinia(createPinia());
    const w = mount(DriveView, { global: { stubs: { RouterLink: { template: "<slot />" } } } });
    await flushPromises();
    expect(w.text()).toMatch(/DragonFox/);
    expect(w.text()).toMatch(/Drive/);
    expect(w.findAll("button").some((b) => b.text().includes("新建文件夹"))).toBe(true);
  });
});
