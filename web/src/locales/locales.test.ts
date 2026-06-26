import { describe, it, expect, beforeEach } from "vitest";
import { detectLocale } from "./index";

describe("detectLocale", () => {
  beforeEach(() => localStorage.clear());

  it("localStorage df-lang wins", () => {
    localStorage.setItem("df-lang", "zh");
    expect(detectLocale("en-US")).toBe("zh");
  });
  it("navigator zh* → zh", () => {
    expect(detectLocale("zh-CN")).toBe("zh");
    expect(detectLocale("zh-TW")).toBe("zh");
  });
  it("navigator non-zh → en", () => {
    expect(detectLocale("en-US")).toBe("en");
    expect(detectLocale("fr-FR")).toBe("en");
  });
  it("falls back to en when nothing set", () => {
    expect(detectLocale(undefined)).toBe("en");
  });
});
