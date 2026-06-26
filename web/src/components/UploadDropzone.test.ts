import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import UploadDropzone from "./UploadDropzone.vue";

describe("UploadDropzone", () => {
  it("renders default slot content", () => {
    const w = mount(UploadDropzone, { slots: { default: "<p>区域</p>" } });
    expect(w.text()).toMatch(/区域/);
  });
});
