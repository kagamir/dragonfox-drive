/**
 * Lazy Comlink wrapper around the crypto worker.
 *
 * Usage:
 *   import { cryptoApi } from "@/workers/crypto";
 *   await cryptoApi.init();
 *   const masterKey = await cryptoApi.newMasterKey();
 */

import * as Comlink from "comlink";

import type { CryptoApi } from "./crypto.worker";

export const cryptoWorker = Comlink.wrap<CryptoApi>(
  new Worker(new URL("./crypto.worker.ts", import.meta.url), {
    type: "module",
  }),
);

// Eagerly init the worker so the WASM module loads in parallel with the UI.
let initPromise: Promise<void> | null = null;
export function ensureCryptoReady(): Promise<void> {
  if (!initPromise) {
    initPromise = cryptoApi.init();
  }
  return initPromise;
}

export const cryptoApi = cryptoWorker;
