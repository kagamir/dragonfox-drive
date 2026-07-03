import { computeBuildHash } from "./hash";

export interface SwManifest {
  version: string;
  buildHash: string;
  assets: string[];
}

/** Sentinel URL under which the pinned manifest is stored inside the cache. */
export const PINNED_MANIFEST_URL = "/__df_pinned_manifest__";

/** Minimal shape guard: is `v` a plausible `SwManifest`? */
function isSwManifest(v: unknown): v is SwManifest {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return typeof m.version === "string" && typeof m.buildHash === "string" && Array.isArray(m.assets);
}

export async function readPinnedManifest(cache: Cache): Promise<SwManifest | null> {
  const res = await cache.match(PINNED_MANIFEST_URL);
  if (!res) return null;
  const parsed: unknown = await res.json();
  // Treat a corrupt/foreign value as un-pinned rather than propagating it.
  if (!isSwManifest(parsed)) return null;
  return parsed;
}

export async function writePinnedManifest(cache: Cache, m: SwManifest): Promise<void> {
  await cache.put(
    PINNED_MANIFEST_URL,
    new Response(JSON.stringify(m), { headers: { "content-type": "application/json" } }),
  );
}

/**
 * Fetch every asset in the manifest, recompute the canonical build hash from
 * the bytes actually received, and reject if it does not match. Keeps the
 * original Response (with server headers/MIME) so the caller can cache it
 * verbatim once verification passes.
 */
export async function fetchAndVerifySnapshot(
  m: SwManifest,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<{ path: string; response: Response; bytes: Uint8Array }>> {
  const items = await Promise.all(
    m.assets.map(async (path) => {
      const response = await fetchImpl(path, { cache: "no-store" });
      if (!response.ok) throw new Error(`asset ${path} -> HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.clone().arrayBuffer());
      return { path, response, bytes };
    }),
  );
  const got = await computeBuildHash(items.map(({ path, bytes }) => ({ path, bytes })));
  if (got !== m.buildHash) {
    throw new Error(`build hash mismatch: expected ${m.buildHash}, got ${got}`);
  }
  return items;
}

export async function commitSnapshot(
  cache: Cache,
  items: Array<{ path: string; response: Response }>,
  m: SwManifest,
): Promise<void> {
  // Intentionally fail-safe: the pinned manifest is written LAST. If a
  // mid-loop `cache.put` fails, the pin still points at the previous good
  // snapshot (or none), so a retry re-pins cleanly instead of leaving a
  // manifest that references partially-cached assets.
  for (const { path, response } of items) await cache.put(path, response);
  await writePinnedManifest(cache, m);
}

/**
 * cache-first: return the pinned response; for same-origin navigations that
 * miss, fall back to the pinned index.html (SPA routing). Returns undefined
 * when the SW should let the request hit the network.
 */
export async function cacheFirst(request: Request, cache: Cache): Promise<Response | undefined> {
  const hit = await cache.match(request);
  if (hit) return hit;
  if (request.mode === "navigate") {
    const index = await cache.match("/index.html");
    if (index) return index;
  }
  return undefined;
}
