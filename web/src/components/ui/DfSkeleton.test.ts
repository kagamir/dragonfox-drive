import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfSkeleton from "./DfSkeleton.vue";

describe("DfSkeleton", () => {
  it("renders a pulsing block with size classes", () => {
    const w = mount(DfSkeleton, { attrs: { class: "w-32 h-4" } });
    expect(w.attributes("class")).toMatch(/animate-pulse/);
    expect(w.attributes("class")).toMatch(/w-32/);
  });
});
