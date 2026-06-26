import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import UploadQueueDrawer from "./UploadQueueDrawer.vue";

describe("UploadQueueDrawer", () => {
  it("renders nothing when no uploads", () => {
    const w = mount(UploadQueueDrawer, { props: { uploads: [] } });
    expect(w.text()).toBe("");
  });
  it("lists uploads with progress and cancel emits id", async () => {
    const w = mount(UploadQueueDrawer, {
      props: { uploads: [{ fileId: "f1", name: "a.mp4", progress: 0.4, phase: "uploading" }] },
    });
    expect(w.text()).toMatch(/a\.mp4/);
    await w.find("button").trigger("click");
    expect(w.emitted("cancel")![0]).toEqual(["f1"]);
  });
});
