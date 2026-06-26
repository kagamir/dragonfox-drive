import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import AppHeader from "./AppHeader.vue";
import { i18n } from "@/locales";

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ username: "alice", logout: vi.fn().mockResolvedValue(undefined) }),
}));

const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: "/", name: "drive", component: { template: "<div/>" } },
  { path: "/shares", name: "shares", component: { template: "<div/>" } },
  { path: "/set", name: "settings", component: { template: "<div/>" } },
]});

const plugins = { plugins: [router, i18n] } as const;

describe("AppHeader", () => {
  it("renders brand and nav links", () => {
    const w = mount(AppHeader, { props: { active: "drive", username: "alice" }, global: plugins });
    expect(w.text()).toMatch(/DragonFox/);
    expect(w.text()).toMatch(/My files/);
  });
  it("shows upload button and emits upload when showUpload set", async () => {
    const w = mount(AppHeader, { props: { active: "drive", username: "a", showUpload: true }, global: plugins });
    const btn = w.findAll("button").find((b) => b.text().includes("Upload"));
    expect(btn).toBeTruthy();
    await btn!.trigger("click");
    expect(w.emitted("upload")).toBeTruthy();
  });
  it("renders a language switcher and a shares nav link", () => {
    const w = mount(AppHeader, { props: { active: "drive", username: "a" }, global: plugins });
    expect(w.text()).toMatch(/My files/);
    expect(w.findAll("a").some((a) => a.attributes("href")?.includes("shares"))).toBe(true);
  });
});
