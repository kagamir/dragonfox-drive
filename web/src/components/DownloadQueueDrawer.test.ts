import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "@/locales";
import DownloadQueueDrawer from "./DownloadQueueDrawer.vue";

describe("DownloadQueueDrawer", () => {
  it("renders nothing when no downloads", () => {
    const w = mount(DownloadQueueDrawer, {
      props: { downloads: [] },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    // Panel is v-if-gated, so nothing teleports to body when empty.
    expect(document.body.textContent).toBe("");
    w.unmount();
  });
  it("lists downloads with progress and cancel emits id", async () => {
    const w = mount(DownloadQueueDrawer, {
      props: { downloads: [{ fileId: "f1", name: "a.mp4", progress: 0.4, phase: "downloading" }] },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    // Content is teleported to body, so query document.body (cf. DfContextMenu test).
    expect(document.body.textContent).toMatch(/a\.mp4/);
    const btn = document.body.querySelector("button") as HTMLButtonElement;
    await btn.click();
    expect(w.emitted("cancel")![0]).toEqual(["f1"]);
    w.unmount();
  });
});
