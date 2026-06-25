import { describe, it, expect, beforeEach } from "vitest";
import { nextTick } from "vue";
import { useTheme } from "./useTheme";

describe("useTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("default mode is auto and resolves to a concrete theme", () => {
    const t = useTheme();
    expect(t.store.value).toBe("auto");
    expect(["light", "dark"]).toContain(t.system.value);
  });

  it("set to dark adds .dark class on <html>", async () => {
    const t = useTheme();
    t.store.value = "dark";
    await nextTick();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("df-theme")).toBe("dark");
  });

  it("set to light removes .dark class on <html>", async () => {
    document.documentElement.classList.add("dark");
    const t = useTheme();
    t.store.value = "light";
    await nextTick();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("df-theme")).toBe("light");
  });
});
