import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import FilePreviewModal from "./FilePreviewModal.vue";
import Mp4Player from "./Mp4Player.vue";

// FilePreviewModal -> Mp4Player -> chunkbuf -> @/workers/crypto, which calls
// `new Worker(...)` at module load. happy-dom has no Worker constructor, so
// mock the module the same way every other crypto-touching test does.
vi.mock("@/workers/crypto", () => ({
  cryptoApi: {},
  ensureCryptoReady: vi.fn(),
}));

describe("FilePreviewModal", () => {
  it("renders an <img> for image kind", () => {
    const w = mount(FilePreviewModal, { props: { kind: "image", url: "blob:i", name: "a.png" } });
    expect(w.find("img").attributes("src")).toBe("blob:i");
  });

  it("renders a <video> for video kind", () => {
    const w = mount(FilePreviewModal, { props: { kind: "video", url: "blob:v", name: "a.mp4" } });
    expect(w.find("video").exists()).toBe(true);
  });

  it("renders an <audio> for audio kind", () => {
    const w = mount(FilePreviewModal, { props: { kind: "audio", url: "blob:a", name: "a.mp3" } });
    expect(w.find("audio").exists()).toBe(true);
  });

  it("renders decoded text for text kind", async () => {
    vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    const w = mount(FilePreviewModal, { props: { kind: "text", url: "blob:t", name: "a.txt" } });
    // wait for the fetch+decode cycle
    await vi.waitFor(() => {
      expect(w.find("pre").text().length).toBeGreaterThan(0);
    });
  });

  it("emits close on backdrop click", async () => {
    const w = mount(FilePreviewModal, { props: { kind: "image", url: "blob:i", name: "a.png" } });
    await w.find(".preview-backdrop").trigger("click");
    expect(w.emitted("close")).toBeTruthy();
  });

  it("emits close on Esc", async () => {
    const w = mount(FilePreviewModal, { props: { kind: "image", url: "blob:i", name: "a.png" } });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await w.vm.$nextTick();
    expect(w.emitted("close")).toBeTruthy();
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
    });
    // The `player` branch mounts <Mp4Player> (which owns the <video> element);
    // the v-else blob <video> must NOT render.
    expect(w.findComponent(Mp4Player).exists()).toBe(true);
    expect(w.find("video").exists()).toBe(true);
    delete (globalThis as unknown as { MediaSource?: unknown }).MediaSource;
    vi.unstubAllGlobals();
  });
});
