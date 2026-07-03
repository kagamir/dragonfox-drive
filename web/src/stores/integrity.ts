/**
 * Page-side counterpart to the frontend-pinning service worker: registers the
 * SW, tracks the pinned manifest vs. the latest one published on the server,
 * and drives the (opt-in) apply-update flow. Never throws out of `register()`
 * -- environments without SW support (or a failing registration) just leave
 * `enabled` false and the app keeps working as a normal direct load.
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import type { SwManifest } from "@/sw/pinning";

const IGNORED_KEY = "df.integrity.ignored";
const MANIFEST_URL = "/sw-manifest.json";

/**
 * How long to wait for a reply to a message posted to the service worker
 * before giving up. Without this, a registered-but-unresponsive SW would leave
 * the awaiting promise pending forever, stranding the integrity UI.
 */
export const SW_REPLY_TIMEOUT_MS = 10_000;

/**
 * How long to wait for `navigator.serviceWorker.ready` to resolve during
 * registration. If SW install fails permanently, `ready` never resolves, so
 * without a timeout `register()` would hang forever. On timeout we leave
 * `enabled` false and return -- same degraded-but-working outcome as any
 * other registration failure.
 */
export const SW_READY_TIMEOUT_MS = 15_000;

/**
 * Post `message` to `sw` and wait for a matching reply. `onReply` inspects each
 * incoming message and returns true once it has handled a terminal reply; that
 * (or the timeout) tears down the listener and clears the timer exactly once.
 * `onTimeout` runs only when the SW never answers in time.
 */
function postAndWait(
  sw: ServiceWorker,
  message: unknown,
  onReply: (e: MessageEvent) => boolean,
  onTimeout: () => void,
): void {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    navigator.serviceWorker.removeEventListener("message", onMsg);
  };
  const onMsg = (e: MessageEvent) => {
    if (onReply(e)) finish();
  };
  const timer = setTimeout(() => {
    finish();
    onTimeout();
  }, SW_REPLY_TIMEOUT_MS);
  navigator.serviceWorker.addEventListener("message", onMsg);
  sw.postMessage(message);
}

export const useIntegrityStore = defineStore("integrity", () => {
  const enabled = ref(false); // SW registered & controlling this page
  const pinned = ref<SwManifest | null>(null);
  const latestHash = ref<string | null>(null);
  const updateAvailable = ref(false);
  const lastChecked = ref<number | null>(null);
  const applying = ref(false);
  const firstPin = ref(false); // true right after the very first pin in this browser

  let reg: ServiceWorkerRegistration | null = null;

  function ignored(): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(IGNORED_KEY) ?? "[]"));
    } catch {
      return new Set();
    }
  }

  function ignoreVersion(hash: string): void {
    const s = ignored();
    s.add(hash);
    localStorage.setItem(IGNORED_KEY, JSON.stringify([...s]));
    updateAvailable.value = false;
  }

  function activeWorker(): ServiceWorker | null {
    return navigator.serviceWorker?.controller ?? reg?.active ?? null;
  }

  function refreshPinned(): Promise<void> {
    return new Promise((resolve) => {
      const sw = activeWorker();
      if (!sw) return resolve();
      postAndWait(
        sw,
        { type: "GET_PINNED" },
        (e) => {
          if (e.data?.type === "PINNED") {
            pinned.value = e.data.manifest ?? null;
            resolve();
            return true;
          }
          return false;
        },
        // Non-fatal: leave `pinned` as-is; a later manual check can retry.
        () => resolve(),
      );
    });
  }

  async function checkForUpdate(): Promise<void> {
    try {
      const res = await fetch(MANIFEST_URL, { cache: "no-store" });
      const latest = (await res.json()) as SwManifest;
      latestHash.value = latest.buildHash;
      lastChecked.value = Date.now();
      const differs = !!pinned.value && latest.buildHash !== pinned.value.buildHash;
      updateAvailable.value = differs && !ignored().has(latest.buildHash);
    } catch {
      /* offline / not built: leave state as-is */
    }
  }

  async function register(): Promise<void> {
    if (!("serviceWorker" in navigator)) return;
    try {
      const hadController = !!navigator.serviceWorker.controller;
      reg = await navigator.serviceWorker.register("/sw.js", { type: "module" });
      const timedOut = Symbol("sw-ready-timeout");
      const timeout = new Promise<typeof timedOut>((resolve) =>
        setTimeout(() => resolve(timedOut), SW_READY_TIMEOUT_MS),
      );
      const result = await Promise.race([navigator.serviceWorker.ready, timeout]);
      if (result === timedOut) {
        enabled.value = false;
        return;
      }
      enabled.value = true;
      if (!hadController) firstPin.value = true;
      await refreshPinned();
      await checkForUpdate();
    } catch {
      enabled.value = false;
    }
  }

  function applyUpdate(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sw = activeWorker();
      if (!sw) return reject(new Error("no active service worker"));
      applying.value = true;
      postAndWait(
        sw,
        { type: "APPLY_UPDATE" },
        (e) => {
          if (e.data?.type === "UPDATE_DONE") {
            window.location.reload();
            resolve();
            return true;
          }
          if (e.data?.type === "UPDATE_FAILED") {
            applying.value = false;
            reject(new Error(e.data.error));
            return true;
          }
          return false;
        },
        () => {
          applying.value = false;
          reject(new Error("service worker did not respond"));
        },
      );
    });
  }

  return {
    enabled,
    pinned,
    latestHash,
    updateAvailable,
    lastChecked,
    applying,
    firstPin,
    register,
    checkForUpdate,
    applyUpdate,
    ignoreVersion,
  };
});
