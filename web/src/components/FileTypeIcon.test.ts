import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import FileTypeIcon from "./FileTypeIcon.vue";

describe("FileTypeIcon", () => {
  it("classifies pdf as doc", () => {
    const w = mount(FileTypeIcon, { props: { name: "report.pdf" } });
    expect(w.attributes("class")).toMatch(/text-blue/);
  });
  it("classifies folder", () => {
    const w = mount(FileTypeIcon, { props: { name: "工作", isFolder: true } });
    expect(w.attributes("class")).toMatch(/text-orange/);
  });
  it("unknown ext falls back to other", () => {
    const w = mount(FileTypeIcon, { props: { name: "data.xyz" } });
    expect(w.attributes("class")).toMatch(/text-gray/);
  });
});
