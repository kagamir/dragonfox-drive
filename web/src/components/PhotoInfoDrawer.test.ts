import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/locales";
import PhotoInfoDrawer from "./PhotoInfoDrawer.vue";

class MetadataWorker {
  static instances: MetadataWorker[] = [];
  postMessage = vi.fn();
  terminate = vi.fn();
  onmessage?: (event: { data: { fields: Record<string, string> } }) => void;
  onerror?: () => void;
  constructor() { MetadataWorker.instances.push(this); }
}

function setup(open: boolean) {
  MetadataWorker.instances = [];
  vi.stubGlobal("Worker", MetadataWorker);
  return mount(PhotoInfoDrawer, {
    props: { name: "A.jpg", blob: new Blob(["A"]), width: 1200, height: 800, open },
    global: { plugins: [i18n] },
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("photo information drawer", () => {
  it("reads on open, displays basic details and reuses a completed result", async () => {
    const drawer = setup(false);
    expect(MetadataWorker.instances).toHaveLength(0);
    await drawer.setProps({ open: true });
    const first = MetadataWorker.instances[0]!;
    expect(first.postMessage).toHaveBeenCalledWith(drawer.props("blob"));
    first.onmessage?.({ data: { fields: { lens: "<i>70mm</i>" } } });
    await flushPromises();
    expect(drawer.text()).toContain("A.jpg");
    expect(drawer.text()).toContain("1200 × 800 px");
    expect(drawer.text()).toContain("<i>70mm</i>");
    expect(drawer.find("i").exists()).toBe(false);
    await drawer.setProps({ open: false });
    await drawer.setProps({ open: true });
    expect(drawer.text()).toContain("<i>70mm</i>");
    expect(MetadataWorker.instances).toHaveLength(1);
    await drawer.get("button").trigger("click");
    expect(drawer.emitted("close")).toHaveLength(1);
    drawer.unmount();
  });

  it("ignores late results after navigation, closing or unmounting", async () => {
    const drawer = setup(true);
    const first = MetadataWorker.instances[0]!;
    await drawer.setProps({ name: "B.png", blob: new Blob(["B"]) });
    const second = MetadataWorker.instances[1]!;
    expect(first.terminate).toHaveBeenCalledOnce();
    first.onmessage?.({ data: { fields: { camera: "Old camera" } } });
    await flushPromises();
    expect(drawer.text()).not.toContain("Old camera");
    expect(drawer.get('[role="status"]').text()).toContain("Loading");
    second.onmessage?.({ data: { fields: {} } });
    await flushPromises();
    expect(drawer.get('[role="status"]').text()).toContain("No camera information");

    await drawer.setProps({ name: "C.jpg", blob: new Blob(["C"]) });
    const third = MetadataWorker.instances[2]!;
    await drawer.setProps({ open: false });
    expect(third.terminate).toHaveBeenCalledOnce();
    third.onerror?.();
    await drawer.setProps({ open: true });
    const last = MetadataWorker.instances[3]!;
    expect(drawer.text()).not.toContain("could not be read");
    drawer.unmount();
    expect(last.terminate).toHaveBeenCalledOnce();
  });
});
