import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfButton from "./DfButton.vue";

describe("DfButton", () => {
  it("renders default slot with primary classes", () => {
    const w = mount(DfButton, { slots: { default: "上传" } });
    expect(w.text()).toBe("上传");
    expect(w.attributes("class")).toMatch(/bg-brand/);
    expect(w.attributes("type")).toBe("button");
  });
  it("shows spinner and is disabled when loading", () => {
    const w = mount(DfButton, { props: { loading: true } });
    expect(w.find("svg.animate-spin").exists()).toBe(true);
    expect(w.attributes("disabled")).toBeDefined();
  });
  it("applies danger variant", () => {
    const w = mount(DfButton, { props: { variant: "danger" } });
    expect(w.attributes("class")).toMatch(/bg-danger/);
  });
  it("renders #icon slot before label", () => {
    const w = mount(DfButton, {
      slots: { default: "新建", icon: "<span class='ic'/>" },
    });
    expect(w.find(".ic").exists()).toBe(true);
  });
});
