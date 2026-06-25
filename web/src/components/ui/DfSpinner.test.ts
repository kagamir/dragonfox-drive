import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfSpinner from "./DfSpinner.vue";

describe("DfSpinner", () => {
  it("renders an animated svg accepting size classes", () => {
    const w = mount(DfSpinner, { attrs: { class: "w-5 h-5" } });
    expect(w.find("svg.animate-spin").exists()).toBe(true);
    expect(w.attributes("class")).toMatch(/w-5/);
  });
});
