import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, it, expect, vi } from "vitest";
import { i18n } from "@/locales";
import ImageViewer from "./ImageViewer.vue";

class FakeWorker {
  static instances: FakeWorker[] = [];
  postMessage = vi.fn();
  terminate = vi.fn();
  onmessage?: (event: { data: Record<string, unknown> }) => void;
  onerror?: () => void;
  constructor() { FakeWorker.instances.push(this); }
}

const imageBlob = new Blob(["photo"], { type: "image/jpeg" });
function setup() {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  return mount(ImageViewer, { props: { url: "blob:one", blob: imageBlob, name: "One.jpg" }, global: { plugins: [i18n] } });
}
afterEach(() => vi.unstubAllGlobals());

describe("local photo preview", () => {
  it("loads details on demand and keeps the photo visible when metadata fails", async () => {
    const wrapper = setup();
    expect(FakeWorker.instances).toHaveLength(0);
    await wrapper.get("button[aria-expanded]").trigger("click");
    const worker = FakeWorker.instances[0]!;
    expect(worker.postMessage).toHaveBeenCalledWith(imageBlob);
    worker.onerror?.();
    await flushPromises();
    expect(wrapper.text()).toContain("could not be read");
    expect(wrapper.find("img").exists()).toBe(true);
    expect(worker.terminate).toHaveBeenCalled();
    wrapper.unmount();
  });

  it("renders field values as text, does not restart completed metadata reads, and cancels pending work on close", async () => {
    const wrapper = setup();
    const toggle = wrapper.get("button[aria-expanded]");
    await toggle.trigger("click");
    FakeWorker.instances[0]!.onmessage?.({ data: { fields: { lens: "<b>test lens</b>" } } });
    await flushPromises();
    expect(wrapper.text()).toContain("<b>test lens</b>");
    expect(wrapper.find("b").exists()).toBe(false);
    await toggle.trigger("click");
    await toggle.trigger("click");
    expect(FakeWorker.instances).toHaveLength(1);
    wrapper.unmount();
    const second = setup();
    await second.get("button[aria-expanded]").trigger("click");
    second.unmount();
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalled();
  });

  it("changes zoom by tapping the image or using the keyboard and restores fit with 0", async () => {
    const wrapper = setup();
    const stage = wrapper.get(".photo-stage").element;
    Object.defineProperties(stage, { clientWidth: { value: 500 }, clientHeight: { value: 400 } });
    const img = wrapper.get("img");
    Object.defineProperties(img.element, { naturalWidth: { value: 1000 }, naturalHeight: { value: 600 } });
    await img.trigger("load");
    expect(wrapper.text()).toContain("50%");
    await wrapper.get("button.photo-button").trigger("click");
    expect(wrapper.text()).toContain("100%");
    await wrapper.get("section").trigger("keydown", { key: "+" });
    expect(wrapper.text()).toContain("150%");
    await wrapper.get("section").trigger("keydown", { key: "0" });
    expect(wrapper.text()).toContain("50%");
    wrapper.unmount();
  });
});
