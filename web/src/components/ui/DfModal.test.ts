import { describe, it, expect } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { i18n } from "@/locales";
import DfModal from "./DfModal.vue";

describe("DfModal", () => {
  it("renders title and body when open", async () => {
    const w = mount(DfModal, {
      props: { open: true, title: "确认删除" },
      slots: { default: "<p>正文</p>" },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    expect(document.body.textContent).toMatch(/确认删除/);
    expect(document.body.textContent).toMatch(/正文/);
    w.unmount();
  });
  it("renders nothing visible when closed", () => {
    const w = mount(DfModal, {
      props: { open: false },
      slots: { default: "隐藏内容" },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    expect(document.body.textContent).not.toMatch(/隐藏内容/);
    w.unmount();
  });
  it("shows an aria-label=Close close button when open", async () => {
    const w = mount(DfModal, {
      props: { open: true, title: "标题" },
      slots: { default: "正文" },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    expect(document.querySelector('button[aria-label="Close"]')).toBeTruthy();
    w.unmount();
  });
});
