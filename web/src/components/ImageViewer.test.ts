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
  return mount(ImageViewer, { attachTo: document.body, props: { canPrevious: true, canNext: true, url: "blob:one", blob: imageBlob, name: "One.jpg" }, global: { plugins: [i18n] } });
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

  it("keeps the drawer open across photos, then restores keyboard focus when Escape closes it", async () => {
    const wrapper = setup();
    const toggle = wrapper.get('[data-testid="photo-info-toggle"]');
    const panel = wrapper.get('[data-testid="photo-info-drawer"]');
    await toggle.trigger("click");
    await flushPromises();
    expect(panel.element.contains(document.activeElement)).toBe(true);
    await wrapper.setProps({ url: "blob:two", name: "Two.jpg", blob: new Blob(["two"]) });
    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(panel.text()).toContain("Two.jpg");
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    await panel.get("button").trigger("keydown", { key: "Escape" });
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle.element);
    expect(wrapper.emitted("close")).toBeUndefined();
    wrapper.unmount();
  });

  it("allows keyboard navigation at fit, locks it while zoomed or loading, and restores it with 0", async () => {
    const wrapper = setup();
    const stage = wrapper.get('[data-testid="photo-stage"]');
    Object.defineProperties(stage.element, { clientWidth: { value: 500 }, clientHeight: { value: 400 } });
    const img = wrapper.get("img");
    Object.defineProperties(img.element, { naturalWidth: { value: 1000 }, naturalHeight: { value: 600 } });
    await img.trigger("load");
    const keyboard = (key: string) => stage.trigger("keydown", { key });
    const percent = wrapper.get('[data-testid="photo-zoom"]');
    expect(percent.text()).toBe("50%");
    await keyboard("ArrowRight");
    expect(wrapper.emitted("navigate")).toEqual([[1]]);
    await keyboard("+");
    expect(percent.text()).toBe("75%");
    await keyboard("ArrowLeft");
    expect(wrapper.emitted("navigate")).toHaveLength(1);
    await keyboard("0");
    expect(percent.text()).toBe("50%");
    await wrapper.setProps({ navigating: true });
    await keyboard("ArrowLeft");
    expect(wrapper.emitted("navigate")).toHaveLength(1);
    await wrapper.setProps({ navigating: false });
    await keyboard("ArrowLeft");
    expect(wrapper.emitted("navigate")).toEqual([[1], [-1]]);
    wrapper.unmount();
  });
});
