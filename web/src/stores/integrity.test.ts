import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useIntegrityStore, SW_REPLY_TIMEOUT_MS } from "./integrity";
import type { SwManifest } from "@/sw/pinning";

const mk = (hash: string): SwManifest => ({ version: "v", buildHash: hash, assets: [] });

describe("integrity store update detection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it("flags an update when the latest hash differs from the pinned one", async () => {
    const store = useIntegrityStore();
    store.pinned = mk("aaa");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(mk("bbb")))));
    await store.checkForUpdate();
    expect(store.latestHash).toBe("bbb");
    expect(store.updateAvailable).toBe(true);
  });

  it("does not flag when hashes match", async () => {
    const store = useIntegrityStore();
    store.pinned = mk("aaa");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(mk("aaa")))));
    await store.checkForUpdate();
    expect(store.updateAvailable).toBe(false);
  });

  it("does not flag a version the user chose to ignore, and persists it", async () => {
    const store = useIntegrityStore();
    store.pinned = mk("aaa");
    store.ignoreVersion("bbb");
    expect(JSON.parse(localStorage.getItem("df.integrity.ignored")!)).toContain("bbb");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(mk("bbb")))));
    await store.checkForUpdate();
    expect(store.updateAvailable).toBe(false);
  });

  it("rejects applyUpdate after the timeout when the worker never replies", async () => {
    vi.useFakeTimers();
    try {
      const store = useIntegrityStore();
      const worker = { postMessage: vi.fn() };
      vi.stubGlobal("navigator", {
        serviceWorker: {
          controller: worker,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      });

      const p = store.applyUpdate();
      p.catch(() => {}); // avoid an unhandled-rejection race while timers advance
      expect(store.applying).toBe(true);

      await vi.advanceTimersByTimeAsync(SW_REPLY_TIMEOUT_MS);

      await expect(p).rejects.toThrow("service worker did not respond");
      expect(store.applying).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
