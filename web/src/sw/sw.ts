/// <reference lib="webworker" />
/// <disable> type-only: SW globals typed loosely to avoid lib conflicts </disable>

import {
  handleStreamRequest,
  matchStreamId,
  applySwMessage,
  LruCache,
  type StreamMeta,
  type SwMessage,
} from "./logic";

// `self` is a ServiceWorkerGlobalScope inside the SW, but the app's tsconfig
// types it as Window. Cast loosely here; the logic module owns correctness.
const sw: any = self;


const metaStore = new Map<string, StreamMeta>();
const cache = new LruCache(256 * 1024 * 1024);

sw.addEventListener("install", () => { void sw.skipWaiting(); });
sw.addEventListener("activate", (event: any) => { event.waitUntil(sw.clients.claim()); });

sw.addEventListener("message", (event: MessageEvent) => {
  try { applySwMessage(metaStore, cache, event.data as SwMessage); } catch { /* ignore malformed messages */ }
});

sw.addEventListener("fetch", (event: any) => {
  const req: Request = event.request;
  if (req.method !== "GET") return;
  const fileId = matchStreamId(req.url);
  if (!fileId) return; // pass through to the network
  const meta = metaStore.get(fileId);
  if (!meta) {
    event.respondWith(new Response("stream not prepared", { status: 404 }));
    return;
  }
  event.respondWith((async () => {
    try {
      return await handleStreamRequest(req, meta, cache, makeFetcher(meta));
    } catch (err) {
      return new Response(`stream error: ${String(err)}`, { status: 500 });
    }
  })());
});

function makeFetcher(meta: StreamMeta): (idx: number) => Promise<Uint8Array> {
  return async (idx) => {
    const url = `/api/files/${meta.fileId}/chunks/${idx}`;
    const doFetch = (tok: string) => fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    let resp = await doFetch(meta.token);
    if (resp.status === 401) {
      const fresh = await requestFreshToken(meta.fileId);
      if (fresh) { meta.token = fresh; resp = await doFetch(fresh); }
    }
    if (!resp.ok) throw new Error(`chunk ${idx} fetch failed: ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  };
}

function requestFreshToken(fileId: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const onMsg = (event: MessageEvent) => {
      const d = event.data;
      if (!done && d && d.type === "token" && d.fileId === fileId && typeof d.token === "string") {
        done = true;
        sw.removeEventListener("message", onMsg);
        resolve(d.token as string);
      }
    };
    sw.addEventListener("message", onMsg);
    void sw.clients.matchAll().then((clients: any[]) =>
      clients.forEach((c) => c.postMessage({ type: "needToken", fileId })),
    );
    setTimeout(() => {
      if (!done) { sw.removeEventListener("message", onMsg); resolve(null); }
    }, 5000);
  });
}
