/// <reference lib="webworker" />
import {
  fetchAndVerifySnapshot,
  commitSnapshot,
  readPinnedManifest,
  cacheFirst,
  type SwManifest,
} from "./pinning";

declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = "df-frontend-pin-v1";
const MANIFEST_URL = "/sw-manifest.json";

async function pinIfNeeded(): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  // Keep an existing pinned snapshot: don't silently re-pin on SW reinstall.
  if (await readPinnedManifest(cache)) return;
  const res = await fetch(MANIFEST_URL, { cache: "no-store" });
  const manifest = (await res.json()) as SwManifest;
  const items = await fetchAndVerifySnapshot(manifest, fetch);
  await commitSnapshot(cache, items, manifest);
}

self.addEventListener("install", (event) => {
  // No skipWaiting(): the first SW activates naturally; a later SW-script
  // update stays "waiting" until the page applies it with explicit consent.
  event.waitUntil(pinIfNeeded());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // third-party: passthrough
  if (req.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return; // API + video streaming
  if (url.pathname === MANIFEST_URL) return; // always network: it's the update signal
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cacheFirst(req, cache);
      return hit ?? fetch(req);
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data as { type?: string } | null;
  if (!data || typeof data !== "object") return;
  const reply = (msg: unknown) => (event.source as Client | null)?.postMessage(msg);

  if (data.type === "GET_PINNED") {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        reply({ type: "PINNED", manifest: await readPinnedManifest(cache) });
      })(),
    );
  } else if (data.type === "APPLY_UPDATE") {
    event.waitUntil(
      (async () => {
        try {
          const cache = await caches.open(CACHE_NAME);
          const res = await fetch(MANIFEST_URL, { cache: "no-store" });
          const manifest = (await res.json()) as SwManifest;
          const items = await fetchAndVerifySnapshot(manifest, fetch);
          await commitSnapshot(cache, items, manifest);
          reply({ type: "UPDATE_DONE", manifest });
        } catch (err) {
          reply({ type: "UPDATE_FAILED", error: String(err) });
        }
      })(),
    );
  }
});
