import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfCard from "./DfCard.vue";

describe("DfCard", () => {
  it("renders default slot", () => {
    expect(mount(DfCard, { slots: { default: "body" } }).text()).toMatch(/body/);
  });
  it("renders optional header and footer slots", () => {
    const w = mount(DfCard, {
      slots: { default: "body", header: "H", footer: "F" },
    });
    expect(w.text()).toMatch(/H/);
    expect(w.text()).toMatch(/F/);
  });
});
