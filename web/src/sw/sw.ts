/// <reference lib="webworker" />
import {
  fetchAndVerifySnapshot,
  commitSnapshot,
  readPinnedManifest,
  cacheFirst,
  type SwManifest,
} from "./pinning";

declare const self: ServiceWorkerGlobalScope;

// Update model (do not conflate these two paths):
//  (a) Frontend *asset-snapshot* updates are user-consented: the page shows a
//      dialog with old/new build hashes and only re-pins when the user sends
//      APPLY_UPDATE (see the message handler below).
//  (b) `sw.js` *script* updates are NOT gated by that dialog. They follow the
//      browser's native Service Worker lifecycle: since we never call
//      `skipWaiting()`, a new SW version installs and sits `waiting` until all
//      tabs controlled by the old SW are closed, at which point it activates
//      on its own. This is intentional and accepted (see design doc §1).
//  (c) CACHE_NAME must NOT be bumped without a migration path. `pinIfNeeded`
//      re-pins whenever no pinned manifest is found under the current cache
//      name. If CACHE_NAME changed, a freshly-activated SW would find no
//      pinned manifest and silently TOFU whatever the server happens to be
//      serving at that moment -- outside the consent dialog entirely. Keep
//      this a single constant; any future migration needs an explicit,
//      reviewed plan for carrying the old pin forward.
const CACHE_NAME = "df-frontend-pin-v1";
const MANIFEST_URL = "/sw-manifest.json";

async function pinIfNeeded(): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  // Keep an existing pinned snapshot: don't silently re-pin on SW reinstall.
  if (await readPinnedManifest(cache)) return;
  const res = await fetch(MANIFEST_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
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
          if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
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
