# P2b: Service-Worker Proxy Video Streaming — Design

Status: approved (2026-06-23)
Implements: the second half of README P2. P2a shipped chunked upload/download
+ lightweight preview (small video via whole-file `<video src=blob>`). **P2b**
adds streaming playback of **large** encrypted videos with byte-exact seek.

## 1. Goal & scope

Let a tester play an encrypted video up to ~100 GiB with instant, byte-exact
seeking, without the server ever seeing plaintext and without holding the
whole file in page memory. The browser's native media engine drives
seeking/buffering/codecs; a Service Worker transparently decrypts the byte
ranges it requests.

**In scope**
- Raise `max_file_bytes` default 10 GiB → **100 GiB**.
- A Service Worker that intercepts `GET /api/stream/:id`, parses the
  `Range` header, fetches+decrypts the covering 4 MiB chunks, and returns the
  requested plaintext byte range as a `206`/`200` response.
- An in-SW memory **LRU cache (256 MiB)** of decrypted chunks so repeated
  seek/back-watch hits cache.
- Page ↔ SW message protocol: page pushes `{fileKey, ivBase, size, mime,
  chunkCount, token}` on play; SW requests token refresh on 401.
- Store `openVideoPreview(meta)` routing `video/*` through the stream URL;
  `closePreview` clears SW state. Non-SW fallback to P2a blob.
- `vite-plugin-pwa` (injectManifest) wiring so `/sw.js` is available in dev
  and prod; app-side registration.
- Docs: `docs/streaming.md` updated to the SW-proxy architecture;
  `docs/api.md` notes the virtual `/api/stream/:id` (SW-only, never reaches
  the backend).

**Out of scope (deferred)**
- MSE / `SourceBuffer` / JS transmuxer (mp4box.js, mux.js) — superseded by the
  SW-proxy choice; native `<video>` handles codecs.
- Container-index (moov/Cues) parsing — unnecessary: the browser issues byte
  Ranges, the SW maps bytes→chunks by division.
- Persistent (Cache API / IndexedDB) plaintext cache — memory-only by design.
- Streaming byte-assembly for huge single Range responses (v1 buffers the
  covering chunks, bounded by the browser's per-request Range size).
- Cross-tab coalescing of chunk fetches.
- Subtitle / audio-track / multi-angle selection UI.

## 2. Key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Streaming architecture | **SW proxy + native `<video>`** | For *encrypted* media this is materially simpler and more robust than MSE: no transmuxer dep, no manual buffer/seek logic, supports every native-playable format (progressive MP4/WebM/MOV…), byte-exact seek is free. The browser issues Range requests on a virtual plaintext URL; the SW decrypts on demand. |
| Seek mapping | **Byte→chunk by division** (no container parsing) | `firstIdx = floor(start/4MiB)`. The browser already knows where moov/data are; we just serve the bytes it asks for. Eliminates the hardest part of the MSE plan. |
| Cache | **SW in-memory LRU, 256 MiB** | Memory-only (no plaintext on disk), bounded; repeated seek/back-watch avoids re-decrypt. Eviction by byte budget. |
| Key delivery to SW | **postMessage on play** | SW cannot read page localStorage (refresh token) or the page's module state. The page unwraps `fileKey` in the worker, then pushes `{fileKey, ivBase,…,token}` to the SW; SW holds it in an in-memory `metaStore` keyed by `fileId` until `stop`. |
| Token refresh | **SW → page `needToken` → page refreshes → pushes token** | SW chunk fetches hit `/api/files/:id/chunks/:idx`; on 401 the SW asks the page, which runs the existing `refreshAuthToken()` and replies. Keeps refresh logic in one place (client.ts). |
| SW build wiring | **`vite-plugin-pwa` injectManifest** | Canonical Vite SW solution; dev (`devOptions.enabled`) + prod; SW source in TS (`src/sw/sw.ts`); no Workbox runtime (we do our own LRU). |
| SW interception scope | **`GET /api/stream/:id` only** | Everything else passes through unmodified — never hijack `/api/auth`, `/api/files`, etc. |
| `file_size` cap | **100 GiB** | Per user target. ~25 600 chunks max; SQLite `file_chunks` handles it trivially. |
| Fallback | **P2a whole-file blob (≤256 MiB) else "Download"** | When SW is unavailable (older browsers, registration failure, iOS limits), small videos still play; large ones degrade gracefully. |

## 3. Data flow

### Playback (SW proxy)

```
page: openVideoPreview(meta)
  │  worker.unwrap(fileKey, masterKey) ──► fileKey
  │  worker.decryptManifest(...)       ──► { ivBase, size, mime, chunkCount }
  │  ensureStreamSw() (register + wait for controller)
  │  controller.postMessage({ type:'play', fileId, fileKey, ivBase,
  │                           size, mime, chunkCount, token })
  ▼
<preview.url = `/api/stream/${fileId}`>
  │
  ▼
<video :src=url>   ──► browser emits Range requests on the virtual URL

Service Worker (fetch event, matches GET /api/stream/:id):
  1. parse Range: bytes=start-end   (end ∅ ⇒ EOF, clamp to size-1)
  2. firstIdx = ⌊start/4MiB⌋ ; lastIdx = ⌊end/4MiB⌋
  3. for idx in [firstIdx..lastIdx]:
       cached? ◄── LRU(256 MiB) hit ⇒ reuse
                 miss ⇒ fetch /api/files/:id/chunks/:idx (Bearer)
                         ⇒ crypto.subtle AES-GCM decrypt(iv = chunkIv(ivBase, idx))
                         ⇒ store in LRU
  4. slice the requested byte window from the covering plaintexts
  5. respond: 206 + Content-Range/Content-Length  (200 if no Range header)
```

### Token refresh

```
SW chunk-fetch returns 401
  └─ SW.postMessage to page { type:'needToken', fileId }
       └─ page: refreshAuthToken() ──► controller.postMessage { type:'token', token }
            └─ SW retries the chunk fetch with the fresh Bearer token
```

## 4. Service-Worker core (`web/src/sw/`)

Decomposed so the logic is unit-testable in happy-dom **without** a real SW:

- **`logic.ts`** (pure):
  - `chunksCovering(start, end, size, chunkSize): { firstIdx, lastIdx }`
  - `sliceRange(plaintexts: Uint8Array[], firstIdx, chunkSize, start, end): Uint8Array`
  - `chunkIv(ivBase: Uint8Array, idx: number): Uint8Array` — XOR-counter copy
    of `symmetric.ts` (the SW cannot import the worker/app bundle).
  - `class LruCache` — `Map` + insertion-order eviction by byte budget
    (`get/set/has/size/evict`; `set` evicts oldest until budget holds).
  - `async handleStreamRequest(req, meta, cache, chunkFetcher): Promise<Response>`
    — the heart: reads `Range`, iterates covering indices, hits cache or
    awaits `chunkFetcher(idx)` → `crypto.subtle` decrypt, assembles via
    `sliceRange`, returns `206` (or `200` when no `Range`). All I/O is
    injected so it is fully testable.
- **`sw.ts`** (the SW entry, built by vite-plugin-pwa):
  - `install`/`activate` (`self.skipWaiting()`/`clients.claim()`).
  - a `metaStore: Map<fileId, Meta>` populated by `play`/`stop` messages.
  - `message` handler: `play` (store meta), `stop` (drop meta + evict that
    file's chunks), `token` (update the stored token).
  - `fetch` handler: if `GET` and URL matches `/api/stream/:id` and meta is
    present → `event.respondWith(handleStreamRequest(event.request, meta,
    cache, makeFetcher(meta)))`; otherwise `event.respondWith(fetch(event.request))`.
  - `makeFetcher(meta)` returns `(idx) => fetch(/api/files/:id/chunks/:idx,
    {headers:{Authorization:Bearer token}}).then(r=>r.arrayBuffer())`, with
    401 → post `needToken` → await one fresh token → retry once.
- **`register.ts`** — `register('/sw.js',{type:'module'})`; `ensureStreamSw()`
  resolves once `navigator.serviceWorker.controller` is non-null (polls across
  the `controllerchange` event); rejects on unsupported/registration failure
  so the store can fall back.

## 5. Page integration & config

**Store (`web/src/stores/files.ts`)**
- `openVideoPreview(meta)`: `ensureCryptoReady` → worker `unwrap(fileKey, mk)`
  + `decryptManifest` → `ensureStreamSw()` → `controller.postMessage({type:'play',…})`
  → `preview.value = { meta, url:'/api/stream/'+meta.id, kind:'video', name }`.
- `closePreview()`: additionally `controller.postMessage({type:'stop',fileId})`.
- `onmessage` from SW: `needToken` → `refreshAuthToken()` → `postMessage({type:'token',token})`.
- `openPreview` routing: `video/*` → `openVideoPreview`; others unchanged
  (P2a blob). `FilePreviewModal`'s `<video :src=url>` is unchanged — only the
  URL source differs.

**Fallback**: if SW unsupported / registration fails / no controller after
timeout, `video/*` with `size ≤ PREVIEW_CAPS.video` (256 MiB) uses P2a
whole-file blob; otherwise modal shows "streaming unavailable, use Download".

**Backend config**: `config.rs` `LimitSettings::default` `max_file_bytes =
100*1024*1024*1024`; `config.toml` `max_file_bytes = 107374182400`; update
`defaults_match_documented_values`. No other backend change (`create` already
validates `total_size <= max_file_bytes`).

## 6. Dev / build wiring

- Add devDependency `vite-plugin-pwa`.
- `vite.config.ts`: `VitePWA({ strategies:'injectManifest', srcDir:'src/sw',
  filename:'sw.ts', injectRegister:false, devOptions:{ enabled:true, type:'module' } })`.
  Keep `fixLibsodiumImport` first in the plugin list (SW doesn't import
  libsodium, so no conflict).
- `main.ts`: call `register()` from `@/sw/register` (best-effort, catches
  unsupported).
- Production: `sw.js` is emitted to `dist/`; rust-embed already serves `dist/`
  same-origin, so `/sw.js` resolves in prod exactly as in dev.

## 7. Security & threat model

- **Server zero-trust unchanged**: only opaque ciphertext chunks + encrypted
  manifest cross the wire.
- `fileKey` travels same-origin via `postMessage` into the SW (in-browser).
- Plaintext exists only in SW process memory: transient slice buffers + the
  256 MiB LRU. **Memory-only, never persisted to disk**; cleared on
  `stop`, page close, or SW restart. Consistent with P2a, which already holds
  plaintext in page memory for download/preview.
- SW intercepts **only** `GET /api/stream/:id`; all other requests pass
  through unmodified.

## 8. Risks & known limitations

- **SW cold start**: first play after install may need one reload until the
  controller is active; `ensureStreamSw()` polls `controllerchange`.
- **v1 range assembly** buffers the covering chunks before slicing (browser
  Range requests are typically a few MB, bounded). Streaming-pipe assembly
  for pathological huge Ranges is deferred.
- **Token expiry mid-stream** handled via the `needToken` round-trip.
- **iOS Safari** may restrict module SWs / certain Range behavior → fallback
  path applies.
- Abandoned playback without `closePreview` leaves SW meta + LRU entries
  until the next `stop` or SW restart (bounded by the 256 MiB budget).

## 9. Testing strategy

- `sw/logic.test.ts` (vitest, happy-dom): `chunksCovering` boundaries
  (within-chunk, cross-chunk, end-at-EOF); `sliceRange` byte-exactness;
  `LruCache` budget eviction; `chunkIv` matches `symmetric.chunkIv`.
- `sw/handleStreamRequest.test.ts`: inject a `chunkFetcher` returning real
  `encryptChunk`-produced ciphertext; assert `206` `Content-Range`/`Content-
  Length`, exact body bytes; second identical range does **not** call the
  fetcher (cache hit); missing `Range` header → `200`.
- `sw/register.ts` / store: mock `navigator.serviceWorker` via
  `vi.stubGlobal`; assert `openVideoPreview` posts `play` and sets the stream
  URL; assert fallback path when SW unsupported.
- Backend: update `defaults_match_documented_values` (100 GiB); keep the
  existing `max_file_bytes` override test green.
- Manual: real-browser playback of a >4 MiB encrypted MP4, drag the
  scrubber (byte-exact seek), scrub backward (cache hit, instant).
