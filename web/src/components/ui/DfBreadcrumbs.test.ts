import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfBreadcrumbs from "./DfBreadcrumbs.vue";
describe("DfBreadcrumbs", () => {
  it("emits navigate with id when a non-last crumb clicked", async () => {
    const w = mount(DfBreadcrumbs, {
      props: { items: [{ id: null, label: "Drive" }, { id: "a", label: "文档" }] },
    });
    await w.find("button").trigger("click"); // 第一项 Drive
    expect(w.emitted("navigate")![0]).toEqual([null]);
  });
  it("last crumb is not a button", () => {
    const w = mount(DfBreadcrumbs, {
      props: { items: [{ id: null, label: "Drive" }, { id: "a", label: "文档" }] },
    });
    const last = w.findAll("span,button");
    expect(w.text()).toMatch(/文档/);
    // 最后一项 "文档" 不触发 navigate：只有 1 个 button（Drive）
    expect(w.findAll("button")).toHaveLength(1);
  });
});
