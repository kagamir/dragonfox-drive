import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/workers/crypto", () => ({ cryptoApi: {}, ensureCryptoReady: vi.fn() }));
vi.mock("@/api/files", () => ({ filesApi: {} }));
vi.mock("@/api/folders", () => ({ foldersApi: {} }));

import MovePickerModal from "./MovePickerModal.vue";
import { useFoldersStore } from "@/stores/folders";
import { useAuthStore } from "@/stores/auth";

describe("MovePickerModal", () => {
  it("lists root folders + a Move to root button, emits pick(null) for root", async () => {
    setActivePinia(createPinia());
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const folders = useFoldersStore();
    folders.folders = [
      { id: "a", parentId: null, folderKey: new Uint8Array(32), name: "Alpha", createdAt: "" },
      { id: "b", parentId: "a", folderKey: new Uint8Array(32), name: "Beta", createdAt: "" },
    ] as any;

    const w = mount(MovePickerModal, { props: { open: true, excludeId: "a" } });
    // "Alpha" is excluded (it's the moved folder itself); "Beta" is its
    // descendant and must also be excluded to prevent cycles.
    expect(w.text()).not.toMatch(/Alpha/);
    expect(w.text()).not.toMatch(/Beta/);
    expect(w.text()).toMatch(/Move to root/);

    await w.findAll("button").find((b) => b.text() === "Move to root")!.trigger("click");
    expect(w.emitted("pick")?.[0]).toEqual([null]);
  });

  it("renders nothing when open is false", () => {
    setActivePinia(createPinia());
    const w = mount(MovePickerModal, { props: { open: false } });
    expect(w.find(".picker-backdrop").exists()).toBe(false);
  });
});
