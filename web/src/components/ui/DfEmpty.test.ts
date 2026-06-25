import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfEmpty from "./DfEmpty.vue";

describe("DfEmpty", () => {
  it("renders title and description", () => {
    const w = mount(DfEmpty, { props: { title: "这里还很空", description: "拖个文件进来吧" } });
    expect(w.text()).toMatch(/这里还很空/);
    expect(w.text()).toMatch(/拖个文件进来吧/);
  });
  it("renders #action slot when provided", () => {
    const w = mount(DfEmpty, { props: { title: "x" }, slots: { action: "<button>上传</button>" } });
    expect(w.find("button").exists()).toBe(true);
  });
});
