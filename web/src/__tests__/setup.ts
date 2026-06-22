import { beforeAll, vi } from "vitest";

import { initCrypto } from "@/crypto";

// --- libsodium WASM: load once for the whole suite ---------------------------
beforeAll(async () => {
  await initCrypto();
}, 30_000);

// --- localforage mock: in-memory Map per (name, storeName) -------------------
vi.mock("localforage", () => {
  const stores = new Map<string, Map<string, unknown>>();
  const factory = (opts: { name?: string; storeName?: string }) => {
    const key = `${opts.name ?? "default"}/${opts.storeName ?? "default"}`;
    let store = stores.get(key);
    if (!store) {
      store = new Map();
      stores.set(key, store);
    }
    return {
      getItem: async (k: string) => (store!.has(k) ? store!.get(k) : null),
      setItem: async (k: string, v: unknown) => {
        store!.set(k, v);
      },
      removeItem: async (k: string) => {
        store!.delete(k);
      },
    };
  };
  return {
    default: { createInstance: factory },
    createInstance: factory,
  };
});

// Note: fetch is NOT mocked globally here. api/client tests stub `fetch`
// per-test via vi.stubGlobal (see client.test.ts). msw was evaluated but its
// Response body streams conflict with happy-dom's FetchResponse.text()
// consumer ("ReadableStream is locked"), so direct vi.fn stubbing is used.
