import { describe, it, expect } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import DfDropdown from "./DfDropdown.vue";

describe("DfDropdown", () => {
  it("renders trigger slot", () => {
    const w = mount(DfDropdown, {
      props: { items: [{ label: "打开", onClick: () => {} }] },
      slots: { trigger: '<button class="t">⋯</button>' },
    });
    expect(w.find("button.t").exists()).toBe(true);
  });
  it("opens menu and shows item labels on trigger click", async () => {
    const w = mount(DfDropdown, {
      props: { items: [{ label: "打开", onClick: () => {} }, { label: "删除", danger: true, onClick: () => {} }] },
      slots: { trigger: '<button class="t">⋯</button>' },
    });
    await w.find("button.t").trigger("click");
    await flushPromises();
    expect(w.text()).toMatch(/打开/);
    expect(w.text()).toMatch(/删除/);
  });
});
