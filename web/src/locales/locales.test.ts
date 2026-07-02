import { describe, it, expect, beforeEach } from "vitest";
import { detectLocale } from "./index";
import en from "./en";
import zh from "./zh";

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

/** Recursively collect dotted key paths of a message object; nested plain
 *  objects are branches, everything else (strings, etc.) is a leaf. */
function collectKeyPaths(obj: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      paths.push(...collectKeyPaths(value as Record<string, unknown>, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

describe("locale key parity", () => {
  it("en and zh expose the exact same set of message keys", () => {
    const enKeys = new Set(collectKeyPaths(en));
    const zhKeys = new Set(collectKeyPaths(zh));

    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));

    expect(
      { missingInZh, missingInEn },
      `en/zh key mismatch — missing in zh: [${missingInZh.join(", ")}]; missing in en: [${missingInEn.join(", ")}]`,
    ).toEqual({ missingInZh: [], missingInEn: [] });
  });
});
