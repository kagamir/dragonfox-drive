import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import en from "@/locales/en";
import UpdatePrompt from "./UpdatePrompt.vue";
import { useIntegrityStore } from "@/stores/integrity";

const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

// DfModal wraps Headless UI's Dialog, which teleports its panel to
// document.body. Wrapper-level find()/text() can't see teleported content, so
// we mount with attachTo: document.body and assert/click through the document
// instead (mirrors the pattern used by ShareDialog.test.ts).
function mountIt() {
  return mount(UpdatePrompt, { global: { plugins: [i18n] }, attachTo: document.body });
}

describe("UpdatePrompt", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  it("is hidden when no update is available", async () => {
    mountIt();
    await flushPromises();
    expect(document.body.textContent).not.toContain(en.integrity.updateTitle);
  });

  it("shows both hashes when an update is available", async () => {
    const store = useIntegrityStore();
    store.pinned = { version: "v", buildHash: "a".repeat(64), assets: [] };
    store.latestHash = "b".repeat(64);
    store.updateAvailable = true;
    mountIt();
    await flushPromises();
    expect(document.body.textContent).toContain(en.integrity.updateTitle);
    expect(document.body.textContent).toContain("aaaaaaa"); // pinned hash prefix
    expect(document.body.textContent).toContain("bbbbbbb"); // new hash prefix
  });

  it("ignoreVersion is called with the latest hash", async () => {
    const store = useIntegrityStore();
    store.pinned = { version: "v", buildHash: "a".repeat(64), assets: [] };
    store.latestHash = "b".repeat(64);
    store.updateAvailable = true;
    const spy = vi.spyOn(store, "ignoreVersion");
    mountIt();
    await flushPromises();
    const btn = document.body.querySelector<HTMLElement>('[data-test="ignore"]');
    expect(btn).toBeTruthy();
    btn!.click();
    await flushPromises();
    expect(spy).toHaveBeenCalledWith("b".repeat(64));
  });
});
