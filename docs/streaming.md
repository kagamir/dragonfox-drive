# Video Streaming Design (Service-Worker Proxy)

Goal: play arbitrarily large encrypted videos (up to ~100 GiB) with
byte-exact random seek, without ever exposing plaintext to the server and
without holding the whole file in page memory.

> **Superseded.** An earlier revision of this document described an
> MSE / `SourceBuffer` pipeline with a JS transmuxer (mp4box.js / mux.js)
> and client-side container-index (`moov` / `Cues`) parsing to map
> `currentTime → byte offset → chunk index`. That plan was abandoned in
> favor of the **Service-Worker proxy** described below: the browser's
> native media engine drives seeking/buffering/codecs and emits the byte
> `Range` requests; the SW maps bytes → chunks by simple division and
> decrypts on demand. This is materially simpler, has no transmuxer
> dependency, supports every native-playable container, and makes
> byte-exact seek free.

## Pipeline overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Page (main thread)                                             │
│                                                                 │
│  openVideoPreview(meta)                                         │
│    │ worker.unwrap(fileKey, masterKey) ──► fileKey              │
│    │ worker.decryptManifest(...) ──► { ivBase, size, mime, … }  │
│    │ ensureStreamSw()  (register + wait for controller)         │
│    │ controller.postMessage({ type:'play', fileId, fileKey,     │
│    │                          ivBase, size, mime, chunkCount,   │
│    │                          token })                          │
│    ▼                                                            │
│  preview.url = `/api/stream/${fileId}`                          │
│    │                                                            │
│    ▼                                                            │
│  <video :src=url>   ──► browser emits Range requests on the     │
│                         virtual plaintext URL                    │
└─────────────────────────┬───────────────────────────────────────┘
                          │  GET /api/stream/:id  +  Range: bytes=a-b
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Service Worker  (fetch event, matches GET /api/stream/:id)     │
│                                                                 │
│  1. parse Range: bytes=start-end   (end ∅ ⇒ EOF, clamp size-1)  │
│  2. firstIdx = ⌊start / 4 MiB⌋ ; lastIdx = ⌊end / 4 MiB⌋        │
│  3. for idx in [firstIdx .. lastIdx]:                           │
│       LRU(256 MiB) hit  ⇒ reuse plaintext                       │
│       miss ⇒ fetch /api/files/:id/chunks/:idx (Bearer token)    │
│             ⇒ crypto.subtle AES-GCM decrypt(iv = chunkIv(       │
│               ivBase, idx))  ⇒ store in LRU                     │
│  4. slice the requested byte window from the covering plaintexts│
│  5. respond: 206 + Content-Range + Content-Length               │
│              (200 when no Range header present)                 │
└─────────────────────────────────────────────────────────────────┘
```

The native `<video>` element owns seeking, buffering, and codec support.
The page never assembles buffers itself — it simply points the element at
the virtual plaintext URL and the SW serves whatever byte ranges the
browser asks for.

## Byte → chunk mapping

There is **no container-index parsing**. The browser already knows where
`moov`/data live; it asks for the bytes it wants, and the SW maps a byte
window to chunks by division:

```
firstIdx = floor(start / 4 MiB)
lastIdx  = floor(end   / 4 MiB)
```

Each 4 MiB chunk is encrypted with its own IV derived as
`chunkIv(ivBase, idx)` (an XOR counter), so any chunk can be fetched and
decrypted independently. The requested byte window is then sliced out of
the covering plaintexts.

## Key delivery to the SW

The SW cannot read the page's `localStorage` (refresh token) or module
state, so the page pushes everything it needs on play:

| Field        | Source                                  |
|--------------|-----------------------------------------|
| `fileKey`    | worker `unwrap(fileKey, masterKey)`     |
| `ivBase`     | decrypted manifest                      |
| `size`       | decrypted manifest                      |
| `mime`       | decrypted manifest                      |
| `chunkCount` | decrypted manifest                      |
| `token`      | current access token (Bearer for fetch) |

The SW holds this in an in-memory `metaStore: Map<fileId, Meta>` until
the page sends `stop` (on `closePreview`) — at which point the meta and
that file's LRU entries are dropped. Plaintext exists only in SW process
memory (transient slice buffers + the 256 MiB LRU) and is **never
persisted to disk**.

## Token refresh

SW chunk fetches hit the authenticated chunk endpoint. On `401` the SW
asks the page for a fresh token rather than implementing refresh itself,
keeping all refresh logic in one place (`client.ts`):

```
SW chunk-fetch returns 401
  └─ SW.postMessage to page { type:'needToken', fileId }
       └─ page: refreshAuthToken() ──► controller.postMessage
                                       { type:'token', token }
            └─ SW retries the chunk fetch with the fresh Bearer token
```

## Cache layer

Decrypted chunks are cached in an **in-SW memory LRU bounded to 256 MiB**
(keyed by `fileId:chunkIndex`). Eviction is by byte budget: `set` drops
the oldest entries until the new chunk fits. Repeat playback and
back-and-forth seeking hit the cache (instant); forward seek past the
cache window fetches only the uncovered chunks.

The cache is memory-only by design — no plaintext is ever written to
IndexedDB / Cache API / disk. It is cleared on `stop`, page close, or SW
restart.

## SW build wiring

`vite-plugin-pwa` (injectManifest strategy) builds the SW from TypeScript
source at `web/src/sw/sw.ts`:

- `install` → `self.skipWaiting()`; `activate` → `clients.claim()`.
- `message` handler: `play` (store meta), `stop` (drop meta + evict that
  file's chunks), `token` (update the stored token).
- `fetch` handler: if `GET` and URL matches `/api/stream/:id` and meta is
  present → `respondWith(handleStreamRequest(...))`; otherwise the request
  passes through to the network unmodified. The SW intercepts **only**
  `GET /api/stream/:id` — never `/api/auth`, `/api/files`, etc.

The SW does not import Workbox or the app/worker bundle (which would pull
in libsodium); it uses `crypto.subtle` directly and a self-contained
`chunkIv` copy of the symmetric IV derivation. The pure streaming logic
(byte math, slicing, LRU, `handleStreamRequest`) lives in
`web/src/sw/logic.ts` so it is unit-testable in happy-dom without a real
SW.

## Fallback path

If the SW is unavailable (older browsers, registration failure, iOS
Safari restrictions, or no controller after the `ensureStreamSw()`
timeout), `video/*` files degrade gracefully:

1. `size ≤ PREVIEW_CAPS.video` (256 MiB) → P2a whole-file blob:
   fetch all chunks → decrypt → single in-memory `Blob` →
   `video.src = URL.createObjectURL(blob)`.
2. Otherwise → the modal shows "streaming unavailable, use Download".

The small-file path works for typical short clips; large videos require
the SW.

## Performance targets (1080p, 5 Mbps stream)

| Metric                     | Target |
|----------------------------|--------|
| Time to first frame        | < 1.5 s |
| Seek response (cached)     | < 100 ms |
| Seek response (uncached)   | < 800 ms |
| UI frame rate during seek  | 60 fps (crypto off the main thread) |

These are achieved by:

- 4 MiB chunks (≈ 6 s of 1080p content) — good granularity for seeking.
- All crypto in the SW (no main-thread blocking during playback).
- 256 MiB in-memory LRU — repeated/backward seek is a cache hit.
- HTTP/2 multiplexing for parallel chunk downloads.

## Known limitations

- **SW cold start**: first play after install may need one reload until
  the controller is active; `ensureStreamSw()` polls `controllerchange`.
- **v1 range assembly** buffers the covering chunks before slicing
  (browser Range requests are typically a few MB, bounded). Streaming
  pipe-assembly for pathological huge Ranges is deferred.
- **iOS Safari** may restrict module SWs / certain Range behavior → the
  fallback path applies.
- Abandoned playback without `closePreview` leaves SW meta + LRU entries
  until the next `stop` or SW restart (bounded by the 256 MiB budget).
