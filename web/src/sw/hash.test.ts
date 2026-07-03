import { describe, it, expect } from "vitest";
import { computeBuildHash, type HashEntry } from "./hash";

const enc = (s: string) => new TextEncoder().encode(s);

describe("computeBuildHash", () => {
  const a: HashEntry = { path: "/a.js", bytes: enc("alpha") };
  const b: HashEntry = { path: "/b.css", bytes: enc("beta") };

  it("is a 64-char hex sha-256", async () => {
    const h = await computeBuildHash([a, b]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of input order", async () => {
    expect(await computeBuildHash([a, b])).toBe(await computeBuildHash([b, a]));
  });

  it("changes when any byte changes", async () => {
    const b2: HashEntry = { path: "/b.css", bytes: enc("beta!") };
    expect(await computeBuildHash([a, b])).not.toBe(await computeBuildHash([a, b2]));
  });

  it("changes when a path changes (no boundary ambiguity)", async () => {
    const x: HashEntry = { path: "/ab.js", bytes: enc("c") };
    const y: HashEntry = { path: "/a.js", bytes: enc("bc") };
    // Without length-prefixing these could collide; assert they don't.
    expect(await computeBuildHash([x])).not.toBe(await computeBuildHash([y]));
  });
});
