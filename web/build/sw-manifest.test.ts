import { describe, it, expect } from "vitest";
import { buildManifest } from "./sw-manifest";
import { computeBuildHash, type HashEntry } from "../src/sw/hash";

const enc = (s: string) => new TextEncoder().encode(s);

describe("buildManifest", () => {
  const entries: HashEntry[] = [
    { path: "/index.html", bytes: enc("<html>") },
    { path: "/assets/app-abc.js", bytes: enc("code") },
  ];

  it("sorts assets and embeds the shared build hash", async () => {
    const m = await buildManifest("1.2.3", entries);
    expect(m.version).toBe("1.2.3");
    expect(m.assets).toEqual(["/assets/app-abc.js", "/index.html"]);
    expect(m.buildHash).toBe(await computeBuildHash(entries));
  });
});
