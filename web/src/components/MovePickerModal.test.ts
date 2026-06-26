import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/workers/crypto", () => ({ cryptoApi: {}, ensureCryptoReady: vi.fn() }));
vi.mock("@/api/files", () => ({ filesApi: {} }));
vi.mock("@/api/folders", () => ({ foldersApi: {} }));

import MovePickerModal from "./MovePickerModal.vue";
import { useFoldersStore } from "@/stores/folders";
import { useAuthStore } from "@/stores/auth";

// DfModal wraps Headless UI Dialog, which teleports its panel to document.body.
// Text/button assertions must therefore target document.body, not wrapper.text().
describe("MovePickerModal", () => {
  it("lists root folders + a 根目录 button, emits pick(null) for root", async () => {
    setActivePinia(createPinia());
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const folders = useFoldersStore();
    folders.folders = [
      { id: "a", parentId: null, folderKey: new Uint8Array(32), name: "Alpha", createdAt: "" },
      { id: "b", parentId: "a", folderKey: new Uint8Array(32), name: "Beta", createdAt: "" },
    ] as any;

    const w = mount(MovePickerModal, { props: { open: true, excludeId: "a" }, attachTo: document.body });
    await flushPromises();
    // "Alpha" is excluded (it's the moved folder itself); "Beta" is its
    // descendant and must also be excluded to prevent cycles.
    expect(document.body.textContent).not.toMatch(/Alpha/);
    expect(document.body.textContent).not.toMatch(/Beta/);
    expect(document.body.textContent).toMatch(/根目录/);

    const rootBtn = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "根目录",
    )!;
    rootBtn.click();
    await flushPromises();
    expect(w.emitted("pick")?.[0]).toEqual([null]);
    w.unmount();
  });

  it("renders nothing when open is false", () => {
    setActivePinia(createPinia());
    const w = mount(MovePickerModal, { props: { open: false }, attachTo: document.body });
    expect(document.body.textContent).not.toMatch(/移动到/);
    w.unmount();
  });
});
