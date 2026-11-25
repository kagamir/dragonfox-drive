import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "@/locales";
import PhotoCanvas from "./PhotoCanvas.vue";

async function setup(canPrevious = true, canNext = true) {
  const wrapper = mount(PhotoCanvas, {
    props: { url: "blob:one", name: "One.jpg", canPrevious, canNext }, global: { plugins: [i18n] },
  });
  const stage = wrapper.get('[data-testid="photo-stage"]');
  const image = wrapper.get("img");
  Object.defineProperties(stage.element, { clientWidth: { value: 800, configurable: true }, clientHeight: { value: 600, configurable: true } });
  Object.defineProperties(image.element, { naturalWidth: { value: 1600 }, naturalHeight: { value: 1200 } });
  await image.trigger("load");
  async function point(type: string, x: number, y: number, id = 1) {
    await stage.trigger(type, { button: 0, clientX: x, clientY: y, pointerId: id });
  }
  function offset() {
    const transform = (image.element as HTMLImageElement).style.transform;
    return Array.from(transform.matchAll(/([-\d.]+)px/g), match => Number(match[1]));
  }
  return { wrapper, stage, image, point, offset };
}

describe("photo canvas", () => {
  it("anchors wheel zoom at the cursor and clamps panning at the four edges", async () => {
    const { wrapper, stage, point, offset } = await setup();
    expect(wrapper.vm.scale).toBe(0.5);
    // happy-dom does not expose the inherited mouse coordinates on WheelEvent.
    const wheel = Object.assign(new WheelEvent("wheel", { deltaY: -Math.log(2) / .0025, cancelable: true }),
      { clientX: 550, clientY: 200 });
    stage.element.dispatchEvent(wheel);
    await wrapper.vm.$nextTick();
    expect(wheel.defaultPrevented).toBe(true);
    expect(wrapper.vm.scale).toBeCloseTo(1);
    expect(offset()[0]).toBeCloseTo(-150);
    expect(offset()[1]).toBeCloseTo(100);
    expect(wrapper.find('[data-testid="photo-next"]').exists()).toBe(false);
    await point("pointerdown", 400, 300);
    await point("pointermove", 490, 330);
    expect(offset()[0]).toBeCloseTo(-60);
    expect(offset()[1]).toBeCloseTo(130);
    await point("pointermove", -2000, 4000);
    expect(offset()).toEqual([-400, 300]);
    await point("pointermove", 4000, -2000);
    expect(offset()).toEqual([400, -300]);
    await point("pointerup", 4000, -2000);
    await point("click", 790, 200);
    expect(wrapper.emitted("navigate")).toBeUndefined();
    wrapper.unmount();
  });

  it("only navigates on stationary clicks at fit, respecting the ends of the gallery", async () => {
    const { wrapper, point } = await setup(false, true);
    expect(wrapper.get('[data-testid="photo-previous"]').attributes("disabled")).toBeDefined();
    await point("click", 10, 20);
    await point("pointerdown", 650, 150);
    await point("pointermove", 700, 150);
    await point("pointermove", 650, 150);
    await point("pointerup", 650, 150);
    await point("click", 650, 150);
    expect(wrapper.emitted("navigate")).toBeUndefined();
    await point("pointerdown", 750, 300);
    await point("pointerup", 750, 300);
    await point("click", 750, 300);
    await wrapper.setProps({ canPrevious: true, canNext: false });
    await point("click", 10, 100);
    expect(wrapper.emitted("navigate")).toEqual([[1], [-1]]);
    wrapper.vm.zoomIn();
    await point("pointerdown", 10, 100);
    await point("pointerup", 10, 100);
    wrapper.vm.resetZoom();
    // A click queued by a zoomed gesture cannot advance even after a reset.
    await point("click", 10, 100);
    expect(wrapper.emitted("navigate")).toHaveLength(2);
    wrapper.unmount();
  });

  it("allows a two-finger pinch back to fit without turning a page", async () => {
    const { wrapper, point } = await setup();
    await point("pointerdown", 300, 200, 1);
    await point("pointerdown", 500, 200, 2);
    await point("pointermove", 700, 200, 2);
    expect(wrapper.vm.scale).toBe(1);
    await point("pointermove", 500, 200, 2);
    expect(wrapper.vm.isZoomed).toBe(false);
    await point("pointerup", 500, 200, 2);
    await point("pointerup", 300, 200, 1);
    await point("click", 300, 200);
    expect(wrapper.emitted("navigate")).toBeUndefined();
    wrapper.unmount();
  });

  it("refits when resizing the viewport makes a previous zoom level fit", async () => {
    let resize!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    try {
      const { wrapper, stage } = await setup();
      wrapper.vm.zoomIn();
      expect(wrapper.vm.scale).toBe(.75);
      Object.defineProperties(stage.element, { clientWidth: { value: 1600 }, clientHeight: { value: 1200 } });
      resize();
      expect(wrapper.vm.scale).toBe(1);
      expect(wrapper.vm.isZoomed).toBe(false);
      wrapper.unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("resets the scale and bounds on a new file and allows navigation when decoding fails", async () => {
    const { wrapper, point } = await setup();
    for (let n = 0; n < 10; n++) wrapper.vm.zoomIn();
    expect(wrapper.vm.scale).toBe(4);
    expect(wrapper.vm.canZoomIn).toBe(false);
    await wrapper.setProps({ url: "blob:two", name: "Two.jpg" });
    expect(wrapper.emitted("dimensions")).toEqual([[1600, 1200], [0, 0]]);
    expect(wrapper.vm.isZoomed).toBe(false);
    expect(wrapper.vm.canZoomIn).toBe(false);
    await wrapper.get("img").trigger("error");
    expect(wrapper.find('[role="status"]').exists()).toBe(true);
    await point("pointerdown", 10, 100);
    await point("pointerup", 10, 100);
    await point("click", 10, 100);
    expect(wrapper.emitted("navigate")).toEqual([[-1]]);
    await wrapper.setProps({ canPrevious: false, canNext: false });
    expect(wrapper.find("button").exists()).toBe(false);
    wrapper.unmount();
  });
});
