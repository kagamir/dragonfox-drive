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
      const onMsg = (e: MessageEvent) => {
        if (e.data?.type === "PINNED") {
          pinned.value = e.data.manifest ?? null;
          navigator.serviceWorker.removeEventListener("message", onMsg);
          resolve();
        }
      };
      navigator.serviceWorker.addEventListener("message", onMsg);
      sw.postMessage({ type: "GET_PINNED" });
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
      await navigator.serviceWorker.ready;
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
      const onMsg = (e: MessageEvent) => {
        if (e.data?.type === "UPDATE_DONE") {
          navigator.serviceWorker.removeEventListener("message", onMsg);
          window.location.reload();
          resolve();
        } else if (e.data?.type === "UPDATE_FAILED") {
          navigator.serviceWorker.removeEventListener("message", onMsg);
          applying.value = false;
          reject(new Error(e.data.error));
        }
      };
      navigator.serviceWorker.addEventListener("message", onMsg);
      sw.postMessage({ type: "APPLY_UPDATE" });
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
