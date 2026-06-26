import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const createMock = vi.fn();
const loadMock = vi.fn();
const revokeMock = vi.fn();
const purgeMock = vi.fn();
vi.mock("@/stores/shares", () => ({
  useSharesStore: () => ({
    byFile: {},
    all: [],
    creating: false,
    error: null,
    load: loadMock,
    loadAll: vi.fn(),
    create: createMock,
    revoke: revokeMock,
    purge: purgeMock,
  }),
}));

import ShareDialog from "@/components/ShareDialog.vue";
import type { FileMeta } from "@/api/types";

const file = { id: "f1" } as unknown as FileMeta;

// DfModal wraps Headless UI Dialog, which teleports its panel to document.body.
// Wrapper-level find()/text() can't see teleported content, so we drive inputs
// and buttons through document.body and flushPromises after every async step.
function queryBody(selector: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el;
}
function setInputValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function clickByText(text: string): void {
  const btn = [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`no button with text ${text}`);
  btn.click();
}

describe("ShareDialog", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    createMock.mockResolvedValue({ id: "s1", url: "https://x/#/s/s1?k=k" });
    document.body.innerHTML = "";
  });

  it("creates a share using numeric expiry (hours) and a numeric limit", async () => {
    const w = mount(ShareDialog, { props: { file }, attachTo: document.body });
    await flushPromises();

    setInputValue(queryBody('input[placeholder="永不"]') as HTMLInputElement, "2");
    setInputValue(queryBody("select") as HTMLSelectElement, "hours");
    setInputValue(queryBody('input[placeholder="不限"]') as HTMLInputElement, "5");

    clickByText("创建分享链接");
    await vi.waitFor(() => expect(createMock).toHaveBeenCalled());
    await flushPromises();

    const arg = createMock.mock.calls[0][1] as {
      expiresAt: string;
      downloadLimit: number | null;
      password: string | undefined;
    };
    expect(arg.downloadLimit).toBe(5);
    const lower = Date.now() + 2 * 3_600_000 - 5000;
    const upper = Date.now() + 2 * 3_600_000 + 5000;
    expect(new Date(arg.expiresAt).getTime()).toBeGreaterThanOrEqual(lower);
    expect(new Date(arg.expiresAt).getTime()).toBeLessThanOrEqual(upper);
    w.unmount();
  });

  it("omits expiresAt and downloadLimit when left blank", async () => {
    const w = mount(ShareDialog, { props: { file }, attachTo: document.body });
    await flushPromises();

    clickByText("创建分享链接");
    await vi.waitFor(() => expect(createMock).toHaveBeenCalled());
    await flushPromises();

    const arg = createMock.mock.calls[0][1] as {
      expiresAt: string | null;
      downloadLimit: number | null;
    };
    expect(arg.expiresAt).toBeNull();
    expect(arg.downloadLimit).toBeNull();
    w.unmount();
  });

  it("shows the created URL after a successful create", async () => {
    const w = mount(ShareDialog, { props: { file }, attachTo: document.body });
    await flushPromises();

    clickByText("创建分享链接");
    await vi.waitFor(() => expect(createMock).toHaveBeenCalled());
    await flushPromises();

    expect(document.body.querySelector("code")?.textContent).toBe("https://x/#/s/s1?k=k");
    clickByText("复制链接");
    await flushPromises();
    w.unmount();
  });
});
