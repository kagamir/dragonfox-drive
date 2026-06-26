import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import UploadQueueDrawer from "./UploadQueueDrawer.vue";

describe("UploadQueueDrawer", () => {
  it("renders nothing when no uploads", () => {
    const w = mount(UploadQueueDrawer, { props: { uploads: [] }, attachTo: document.body });
    // Panel is v-if-gated, so nothing teleports to body when empty.
    expect(document.body.textContent).toBe("");
    w.unmount();
  });
  it("lists uploads with progress and cancel emits id", async () => {
    const w = mount(UploadQueueDrawer, {
      props: { uploads: [{ fileId: "f1", name: "a.mp4", progress: 0.4, phase: "uploading" }] },
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
