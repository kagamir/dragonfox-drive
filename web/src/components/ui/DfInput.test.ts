import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfInput from "./DfInput.vue";

describe("DfInput", () => {
  it("emits update:modelValue on input", async () => {
    const w = mount(DfInput, { props: { modelValue: "" } });
    await w.find("input").setValue("hello");
    expect(w.emitted("update:modelValue")![0]).toEqual(["hello"]);
  });
  it("renders label and hint", () => {
    const w = mount(DfInput, { props: { label: "用户名", hint: "3-32 字符" } });
    expect(w.text()).toMatch(/用户名/);
    expect(w.text()).toMatch(/3-32 字符/);
  });
  it("shows error text and error styles when :error set", () => {
    const w = mount(DfInput, { props: { error: "必填" } });
    expect(w.text()).toMatch(/必填/);
    expect(w.find("input").attributes("class")).toMatch(/border-danger/);
  });
});
