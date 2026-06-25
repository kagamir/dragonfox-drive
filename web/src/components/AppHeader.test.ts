import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import AppHeader from "./AppHeader.vue";

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ username: "alice", logout: vi.fn().mockResolvedValue(undefined) }),
}));

const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: "/", name: "drive", component: { template: "<div/>" } },
  { path: "/s", name: "shares", component: { template: "<div/>" } },
  { path: "/set", name: "settings", component: { template: "<div/>" } },
]});

describe("AppHeader", () => {
  it("renders brand and nav links", () => {
    const w = mount(AppHeader, { props: { active: "drive", username: "alice" }, global: { plugins: [router] } });
    expect(w.text()).toMatch(/DragonFox/);
    expect(w.text()).toMatch(/我的文件/);
  });
  it("shows upload button and emits upload when showUpload set", async () => {
    const w = mount(AppHeader, { props: { active: "drive", username: "a", showUpload: true }, global: { plugins: [router] } });
    const btn = w.findAll("button").find((b) => b.text().includes("上传"));
    expect(btn).toBeTruthy();
    await btn!.trigger("click");
    expect(w.emitted("upload")).toBeTruthy();
  });
});
