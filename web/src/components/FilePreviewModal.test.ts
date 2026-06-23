import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import FilePreviewModal from "./FilePreviewModal.vue";

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
});
