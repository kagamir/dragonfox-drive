import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfSegmented from "./DfSegmented.vue";
describe("DfSegmented", () => {
  it("marks the active option and emits on click", async () => {
    const w = mount(DfSegmented, {
      props: { modelValue: "list", options: [{ value: "list", label: "列表" }, { value: "grid", label: "网格" }] },
    });
    const active = w.findAll("button").find((b) => b.text() === "列表")!;
    expect(active.classes().join(" ")).toMatch(/bg-brand/);
    const grid = w.findAll("button").find((b) => b.text() === "网格")!;
    await grid.trigger("click");
    expect(w.emitted("update:modelValue")![0]).toEqual(["grid"]);
  });
});
