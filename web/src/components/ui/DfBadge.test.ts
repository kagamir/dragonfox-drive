import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfBadge from "./DfBadge.vue";

describe("DfBadge", () => {
  it("renders slot text", () => {
    expect(mount(DfBadge, { slots: { default: "就绪" } }).text()).toBe("就绪");
  });
  it("proc variant uses brand color", () => {
    const w = mount(DfBadge, { props: { variant: "proc" } });
    expect(w.attributes("class")).toMatch(/text-brand/);
    expect(w.attributes("class")).toMatch(/bg-brand/);
  });
  it("falls back to neutral", () => {
    const w = mount(DfBadge);
    expect(w.attributes("class")).toMatch(/text-fg-muted/);
  });
});
