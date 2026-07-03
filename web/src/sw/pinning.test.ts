import { describe, it, expect } from "vitest";
import {
  fetchAndVerifySnapshot,
  commitSnapshot,
  readPinnedManifest,
  cacheFirst,
  type SwManifest,
} from "./pinning";
import { computeBuildHash } from "./hash";

const enc = (s: string) => new TextEncoder().encode(s);

// Minimal in-memory Cache stand-in (happy-dom lacks CacheStorage).
class FakeCache {
  store = new Map<string, Response>();
  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const key = typeof req === "string" ? req : req instanceof URL ? req.pathname : new URL((req as Request).url).pathname;
    const r = this.store.get(key);
    return r ? r.clone() : undefined;
  }
  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    const key = typeof req === "string" ? req : req instanceof URL ? req.pathname : new URL((req as Request).url).pathname;
    this.store.set(key, res);
  }
}

async function manifestFor(files: Record<string, string>): Promise<SwManifest> {
  const entries = Object.entries(files).map(([path, body]) => ({ path, bytes: enc(body) }));
  return { version: "t", buildHash: await computeBuildHash(entries), assets: Object.keys(files) };
}

function fetcherFor(files: Record<string, string>, tamper = false): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const path = String(input);
    const body = files[path];
    if (body === undefined) return new Response("nope", { status: 404 });
    return new Response(tamper ? body + "X" : body, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("fetchAndVerifySnapshot", () => {
  const files = { "/index.html": "<html>", "/assets/a.js": "code" };

  it("returns items when bytes match the manifest hash", async () => {
    const m = await manifestFor(files);
    const items = await fetchAndVerifySnapshot(m, fetcherFor(files));
    expect(items.map((i) => i.path).sort()).toEqual(["/assets/a.js", "/index.html"]);
  });

  it("throws on a build-hash mismatch (tampered bytes)", async () => {
    const m = await manifestFor(files);
    await expect(fetchAndVerifySnapshot(m, fetcherFor(files, true))).rejects.toThrow(/hash mismatch/);
  });

  it("throws when an asset is missing", async () => {
    const m = await manifestFor(files);
    const missing = { "/index.html": "<html>" }; // /assets/a.js -> 404
    await expect(fetchAndVerifySnapshot(m, fetcherFor(missing))).rejects.toThrow(/HTTP 404/);
  });
});

describe("commit + read pinned manifest", () => {
  it("round-trips the manifest and serves cached assets", async () => {
    const cache = new FakeCache() as unknown as Cache;
    const files = { "/index.html": "<html>", "/assets/a.js": "code" };
    const m = await manifestFor(files);
    const items = await fetchAndVerifySnapshot(m, fetcherFor(files));
    await commitSnapshot(cache, items, m);
    expect(await readPinnedManifest(cache)).toEqual(m);
    const hit = await cache.match("/assets/a.js");
    expect(await hit!.text()).toBe("code");
  });
});

describe("cacheFirst", () => {
  it("returns a cache hit, else index.html for navigations, else undefined", async () => {
    const cache = new FakeCache() as unknown as Cache;
    await cache.put("/index.html", new Response("<html>"));
    await cache.put("/assets/a.js", new Response("code"));

    const hit = await cacheFirst(new Request("http://x/assets/a.js"), cache);
    expect(await hit!.text()).toBe("code");

    // The Fetch spec forbids constructing a Request with mode "navigate" from
    // script (`new Request(url, { mode: "navigate" })` throws a TypeError in
    // Node/undici, happy-dom, and real browsers alike). Only the browser sets
    // that mode on genuine navigations. Override it post-construction so we can
    // exercise cacheFirst's navigation fallback. Do NOT "simplify" this back
    // into the constructor init — it will break the test.
    const navReq = new Request("http://x/some/route");
    Object.defineProperty(navReq, "mode", { value: "navigate" });
    const nav = await cacheFirst(navReq, cache);
    expect(await nav!.text()).toBe("<html>");

    const miss = await cacheFirst(new Request("http://x/assets/missing.js"), cache);
    expect(miss).toBeUndefined();
  });
});
