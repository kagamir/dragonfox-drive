import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { i18n } from "@/locales";
import { useConfirm } from "@/composables/useConfirm";
import FilePreviewModal from "./FilePreviewModal.vue";
import Mp4Player from "./Mp4Player.vue";

// FilePreviewModal -> Mp4Player -> chunkbuf -> @/workers/crypto, which calls
// `new Worker(...)` at module load. happy-dom has no Worker constructor, so
// mock the module the same way every other crypto-touching test does.
vi.mock("@/workers/crypto", () => ({
  cryptoApi: {},
  ensureCryptoReady: vi.fn(),
}));

// DfModal wraps Headless UI Dialog, which teleports its panel to document.body.
// Wrapper-level find()/text() can't see teleported content, so the non-player
// branch asserts against document.body. The player branch (Mp4Player owns its
// own <video>, no DfModal) still uses wrapper queries.
function mountAttached(props: Record<string, unknown>) {
  return mount(FilePreviewModal, { props, global: { plugins: [i18n] }, attachTo: document.body });
}

describe("FilePreviewModal", () => {
  it("renders an <img> for image kind", async () => {
    const w = mountAttached({ kind: "image", url: "blob:i", name: "a.png" });
    await flushPromises();
    expect((document.body.querySelector("img") as HTMLImageElement)?.src).toContain("blob:i");
    w.unmount();
  });

  it("renders a <video> for video kind", async () => {
    const w = mountAttached({ kind: "video", url: "blob:v", name: "a.mp4" });
    await flushPromises();
    expect(document.body.querySelector("video")).toBeTruthy();
    w.unmount();
  });

  it("renders an <audio> for audio kind", async () => {
    const w = mountAttached({ kind: "audio", url: "blob:a", name: "a.mp3" });
    await flushPromises();
    expect(document.body.querySelector("audio")).toBeTruthy();
    w.unmount();
  });

  it("reads decrypted text directly under the same-origin connection policy", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const w = mountAttached({ kind: "text", url: "blob:t", name: "a.txt", previewBlob: new Blob(["café"]) });
    await vi.waitFor(() => expect(document.body.querySelector("pre")?.textContent).toBe("café"));
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    w.unmount();
  });

  it("emits close when the DfModal close button is clicked", async () => {
    const w = mountAttached({ kind: "image", url: "blob:i", name: "a.png" });
    await flushPromises();
    (document.body.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click();
    await w.vm.$nextTick();
    expect(w.emitted("close")).toBeTruthy();
    w.unmount();
  });

  it("renders the MSE player (Mp4Player) when a player payload is passed", async () => {
    // MediaSource stub: msePlayer.playMp4's `new MediaSource()` + synchronous
    // ms.addEventListener must not throw under happy-dom. Only the synchronous
    // setup in onMounted runs; sourceopen/feed never fire, so no further
    // methods are required.
    (globalThis as unknown as { MediaSource: unknown }).MediaSource = class {
      static isTypeSupported = () => true;
      addEventListener() {}
      removeEventListener() {}
    };
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:ms"),
      revokeObjectURL: vi.fn(),
    });
    const payload = {
      fileKey: new Uint8Array(32),
      ivBase: new Uint8Array(12),
      chunkSize: 4 * 1024 * 1024,
      totalSize: 100,
      fetchChunk: async () => new Uint8Array(0),
    };
    const w = mount(FilePreviewModal, {
      props: { kind: "video", url: "", name: "clip.mp4", player: payload },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    // The `player` branch mounts <Mp4Player> (which owns the <video> element);
    // the v-else blob <video> must NOT render.
    expect(w.findComponent(Mp4Player).exists()).toBe(true);
    expect(w.find("video").exists()).toBe(true);
    delete (globalThis as unknown as { MediaSource?: unknown }).MediaSource;
    vi.unstubAllGlobals();
  });
});

describe("FilePreviewModal text editing", () => {
  // useConfirm's state is module-level global; a dialog left open by a failed
  // assertion (or one this test intentionally opened) must not bleed into the
  // next test, so make sure it's always resolved & closed afterward.
  afterEach(() => {
    if (useConfirm().state.value.open) useConfirm()._resolve(false);
  });

  it("shows an edit button for text kind only when onSave is provided", async () => {
    const w = mountAttached({ kind: "text", url: "blob:t", previewBlob: new Blob(["hello"]), name: "a.txt", onSave: async () => {} });
    await flushPromises();
    expect(document.body.querySelector('[data-testid="edit-btn"]')).toBeTruthy();
    w.unmount();
    const w2 = mountAttached({ kind: "text", url: "blob:t", name: "a.txt" });
    await flushPromises();
    expect(document.body.querySelector('[data-testid="edit-btn"]')).toBeFalsy();
    w2.unmount();
    vi.unstubAllGlobals();
  });

  it("edit switches to a textarea seeded with the loaded text", async () => {
    const w = mountAttached({ kind: "text", url: "blob:t", previewBlob: new Blob(["hello"]), name: "a.txt", onSave: async () => {} });
    await vi.waitFor(() => {
      expect(document.body.querySelector("pre")?.textContent).toBe("hello");
    });
    (document.body.querySelector('[data-testid="edit-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    const ta = document.body.querySelector('[data-testid="text-editor"]') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    expect(ta.value).toBe("hello");
    expect(document.body.querySelector("pre")).toBeFalsy();
    w.unmount();
    vi.unstubAllGlobals();
  });

  it("save calls onSave with the draft and exits edit mode on resolve", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const w = mountAttached({ kind: "text", url: "blob:t", previewBlob: new Blob(["hello"]), name: "a.txt", onSave });
    await vi.waitFor(() => {
      expect(document.body.querySelector("pre")?.textContent).toBe("hello");
    });
    (document.body.querySelector('[data-testid="edit-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    const ta = document.body.querySelector('[data-testid="text-editor"]') as HTMLTextAreaElement;
    ta.value = "changed";
    ta.dispatchEvent(new Event("input"));
    await flushPromises();
    (document.body.querySelector('[data-testid="edit-save-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(onSave).toHaveBeenCalledWith("changed");
    // back to view mode, showing the saved draft
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="text-editor"]')).toBeFalsy();
      expect(document.body.querySelector("pre")?.textContent).toBe("changed");
    });
    w.unmount();
    vi.unstubAllGlobals();
  });

  it("stays in edit mode when onSave rejects", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("boom"));
    const w = mountAttached({ kind: "text", url: "blob:t", previewBlob: new Blob(["hello"]), name: "a.txt", onSave });
    await vi.waitFor(() => {
      expect(document.body.querySelector("pre")?.textContent).toBe("hello");
    });
    (document.body.querySelector('[data-testid="edit-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    const ta = document.body.querySelector('[data-testid="text-editor"]') as HTMLTextAreaElement;
    ta.value = "changed";
    ta.dispatchEvent(new Event("input"));
    await flushPromises();
    (document.body.querySelector('[data-testid="edit-save-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="text-editor"]')).toBeTruthy();
    expect((document.body.querySelector('[data-testid="text-editor"]') as HTMLTextAreaElement).value).toBe("changed");
    w.unmount();
    vi.unstubAllGlobals();
  });

  it("disables save while the draft is empty", async () => {
    const w = mountAttached({ kind: "text", url: "", name: "new.txt", onSave: async () => {}, startEditing: true });
    await flushPromises();
    const btn = document.body.querySelector('[data-testid="edit-save-btn"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    w.unmount();
  });

  it("startEditing opens directly in edit mode without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const w = mountAttached({ kind: "text", url: "", name: "new.txt", onSave: async () => {}, startEditing: true });
    await flushPromises();
    expect(document.body.querySelector('[data-testid="text-editor"]')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    w.unmount();
    vi.unstubAllGlobals();
  });

  it("cancel with clean draft exits edit mode without confirm", async () => {
    const w = mountAttached({ kind: "text", url: "blob:t", previewBlob: new Blob(["hello"]), name: "a.txt", onSave: async () => {} });
    await vi.waitFor(() => {
      expect(document.body.querySelector("pre")?.textContent).toBe("hello");
    });
    (document.body.querySelector('[data-testid="edit-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    (document.body.querySelector('[data-testid="edit-cancel-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="text-editor"]')).toBeFalsy();
    expect(useConfirm().state.value.open).toBe(false);
    w.unmount();
    vi.unstubAllGlobals();
  });

  it("cancel with dirty draft asks confirm; declining keeps the editor", async () => {
    const w = mountAttached({ kind: "text", url: "blob:t", previewBlob: new Blob(["hello"]), name: "a.txt", onSave: async () => {} });
    await vi.waitFor(() => {
      expect(document.body.querySelector("pre")?.textContent).toBe("hello");
    });
    (document.body.querySelector('[data-testid="edit-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    const ta = document.body.querySelector('[data-testid="text-editor"]') as HTMLTextAreaElement;
    ta.value = "changed";
    ta.dispatchEvent(new Event("input"));
    await flushPromises();
    (document.body.querySelector('[data-testid="edit-cancel-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(useConfirm().state.value.open).toBe(true);

    useConfirm()._resolve(false);
    await flushPromises();
    const ta2 = document.body.querySelector('[data-testid="text-editor"]') as HTMLTextAreaElement;
    expect(ta2).toBeTruthy();
    expect(ta2.value).toBe("changed");
    w.unmount();
    vi.unstubAllGlobals();
  });

  it("cancel with dirty draft + confirm accept discards and exits", async () => {
    const w = mountAttached({ kind: "text", url: "blob:t", previewBlob: new Blob(["hello"]), name: "a.txt", onSave: async () => {} });
    await vi.waitFor(() => {
      expect(document.body.querySelector("pre")?.textContent).toBe("hello");
    });
    (document.body.querySelector('[data-testid="edit-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    const ta = document.body.querySelector('[data-testid="text-editor"]') as HTMLTextAreaElement;
    ta.value = "changed";
    ta.dispatchEvent(new Event("input"));
    await flushPromises();
    (document.body.querySelector('[data-testid="edit-cancel-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(useConfirm().state.value.open).toBe(true);

    useConfirm()._resolve(true);
    await flushPromises();
    expect(document.body.querySelector('[data-testid="text-editor"]')).toBeFalsy();
    expect(document.body.querySelector("pre")?.textContent).toBe("hello");
    w.unmount();
    vi.unstubAllGlobals();
  });

  it("close with dirty draft asks confirm and only emits close when accepted", async () => {
    const w = mountAttached({ kind: "text", url: "blob:t", previewBlob: new Blob(["hello"]), name: "a.txt", onSave: async () => {} });
    await vi.waitFor(() => {
      expect(document.body.querySelector("pre")?.textContent).toBe("hello");
    });
    (document.body.querySelector('[data-testid="edit-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    const ta = document.body.querySelector('[data-testid="text-editor"]') as HTMLTextAreaElement;
    ta.value = "changed";
    ta.dispatchEvent(new Event("input"));
    await flushPromises();

    (document.body.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(useConfirm().state.value.open).toBe(true);
    expect(w.emitted("close")).toBeFalsy();

    useConfirm()._resolve(false);
    await flushPromises();
    expect(useConfirm().state.value.open).toBe(false);
    expect(w.emitted("close")).toBeFalsy();

    (document.body.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click();
    await flushPromises();
    useConfirm()._resolve(true);
    await flushPromises();
    expect(w.emitted("close")).toBeTruthy();
    w.unmount();
    vi.unstubAllGlobals();
  });

  it("after a rejected onSave the save button is re-enabled", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("boom"));
    const w = mountAttached({ kind: "text", url: "blob:t", previewBlob: new Blob(["hello"]), name: "a.txt", onSave });
    await vi.waitFor(() => {
      expect(document.body.querySelector("pre")?.textContent).toBe("hello");
    });
    (document.body.querySelector('[data-testid="edit-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    const ta = document.body.querySelector('[data-testid="text-editor"]') as HTMLTextAreaElement;
    ta.value = "changed";
    ta.dispatchEvent(new Event("input"));
    await flushPromises();
    (document.body.querySelector('[data-testid="edit-save-btn"]') as HTMLButtonElement).click();
    await flushPromises();
    const saveBtn = document.body.querySelector('[data-testid="edit-save-btn"]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    expect((document.body.querySelector('[data-testid="text-editor"]') as HTMLTextAreaElement).value).toBe("changed");
    w.unmount();
    vi.unstubAllGlobals();
  });
});
