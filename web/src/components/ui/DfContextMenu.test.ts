import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfContextMenu from "./DfContextMenu.vue";

function cmRoot(): HTMLElement {
  return document.body.querySelector('[data-cm="root"]') as HTMLElement;
}

describe("DfContextMenu", () => {
  it("hidden until show(event) is called", async () => {
    const w = mount(DfContextMenu, {
      props: { items: [{ label: "打开", onClick: () => {} }] },
      attachTo: document.body,
    });
    // v-show="open=false" sets display:none; content is teleported to body,
    // so we must query document.body rather than the wrapper's own root.
    expect(cmRoot().style.display).toBe("none");
    (w.vm as any).show({ preventDefault: () => {}, clientX: 100, clientY: 50 });
    await w.vm.$nextTick();
    expect(cmRoot().style.display).toBe("");
    expect(cmRoot().style.left).toBe("100px");
    expect(cmRoot().style.top).toBe("50px");
    expect(document.body.textContent).toMatch(/打开/);
    w.unmount();
  });
});
