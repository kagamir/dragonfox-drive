# MSE + mp4box.js MP4 Playback (Design)

Status: approved 2026-06-24 · Scope: replace the P2b Service-Worker streaming
path for video with a Media-Source-Extensions player driven by mp4box.js.

## Background & root cause

P2b streams encrypted video by registering a Service Worker that synthesizes
`206` byte-range responses at a virtual `/api/stream/:id` URL, which the
native `<video>` element consumes. This is browser-fragile:

- Chrome's media cache does not progressively read SW-synthesized streaming
  `206` bodies — it reads ~320 KiB blocks then cancels and re-requests. For a
  large video this thrashes and degrades to "load everything before play."
- The degradation becomes pathological for files whose container lacks usable
  duration/seek metadata (fragmented MP4, or `mvhd` duration = 0 — common for
  screen recordings / OBS output): Chrome cannot pre-build a timeline, so the
  SW-mediated sequential read forces a full load.
- Firefox tolerates the SW stream and is unaffected.

Confirmed via direct diagnosis: the failing file is a clean faststart H.264
yuv420p MP4 whose only defect is missing duration metadata. Over plain HTTP
(no SW) Chrome plays it immediately but cannot get duration or seek to the
end. Over the SW it must fully load before playing. Two SW tweaks
(`ReadableStream` → materialized body; abort-on-cancel → cache) did not help.

## Goal

Reliable, browser-independent progressive playback + seeking for the common
case (MP4 family, including fragmented / moov-at-end / missing-duration
files), without loading the whole file and without large-file OOM. Remove the
SW from the playback path entirely (the source of the Chrome fragility).

## Key insight

The failure is specifically `<video>` *directly consuming* an SW-synthesized
streaming response. `fetch()` consuming an SW (or backend) response has no
such issue. Media Source Extensions (MSE) — what YouTube/Netflix use — is
rock-solid in Chrome and Firefox. So we insert a JS layer (mp4box.js +
`fetch`) between the encrypted chunks and `<video>`: JS fetches encrypted
chunks, decrypts in-page, feeds mp4box.js, which feeds MSE, which `<video>`
plays.

mp4box.js parses incrementally (you feed it byte ranges on demand), so it
never loads the whole file — no OOM. It also computes duration and handles
seeking for fragmented / moov-at-end / missing-duration files natively.

## Confirmed decisions

1. **Retire the SW for playback.** The player fetches encrypted chunks
   (`/api/files/:id/chunks/:idx`) and decrypts in-page via the existing crypto
   worker. The entire P2b SW streaming path (`/api/stream/:id`, `sw.ts`,
   `logic.ts`, SW registration, `vite-plugin-pwa` wiring) is deleted.
2. **MSE + mp4box.js for the MP4 family.** New in-page player module.
3. **No upload-time container probing or warnings.** Routing happens at
   playback, by manifest MIME. (The earlier moov-at-end detection / upload
   warning / `manifest.streamable` field are removed — MSE makes them moot.)
4. **Fallback for non-MP4 / unsupported**: small enough → decrypt-all → blob
   play; too large or unplayable (AVI/MKV/etc.) → "use Download" prompt.

## Non-goals

- WebM via MSE (would need a separate WebM demuxer). WebM uses the blob
  fallback for now.
- Re-muxing / transcoding at upload (ffmpeg.wasm) — ruled out for large-file
  OOM risk; MSE plays files as-is.
- Offline / PWA features (the SW was streaming-only; none exist to preserve).
- Server changes.

---

## 1. Architecture & data flow

```
<video>  ←  src = MediaSource.createObjectURL(ms)
  │
  ▼
MediaSource  →  SourceBuffer (codec extracted from moov by mp4box)
  ▲
  │ appendBuffer(init / media segments)
  │
mp4box.js  (JS demuxer: parses moov, computes duration, slices segments,
            on seek returns the target byte offset)
  ▲
  │ requests byte range [start..end]
  │
chunkbuf (new, in-page decrypted byte-range fetcher)
  │ 1. chunksCovering(start,end) → covering chunk indices (reused pure fn)
  │ 2. per chunk: filesApi.getChunk(id,idx) → cryptoApi.decryptChunk(key, ivBase, idx, cipher)
  │    (the crypto worker computes the per-chunk IV internally; reuse the
  │     existing chunk crypto model, off main thread)
  │ 3. LRU cache of decrypted chunks (reuse LruCache, 256 MiB)
  │ 4. chunkSlice → assemble [start..end] → return to mp4box
  ▼
/api/files/:id/chunks/:idx   (existing backend, unchanged)
```

**mp4box.js drive loop:**
1. Create `MediaSource`, set `<video>.src` to its object URL.
2. Feed mp4box the first bytes → `onReady(info)` yields codec, duration,
   tracks → set `SourceBuffer` codec (from `info`) and `mediaSource.duration`.
3. `setSegmentOptions` + `onSegment` callback → mp4box emits init/media
   segments → `sourceBuffer.appendBuffer(...)`.
4. Keep feeding byte ranges as mp4box requests them → segments flow → MSE
   buffers → playback starts as soon as enough is buffered.
5. **Seek**: `mp4box.seek(time)` returns the target byte offset → chunkbuf
   fetches that range → segments flow. Fragmented / missing-duration files:
   mp4box computes duration from sample tables / fragments; seeking works.

**Properties:**
- Never loads the whole file (incremental parse + on-demand chunk fetch +
  256 MiB LRU) → no large-file OOM.
- Handles fragmented / moov-at-end / missing-duration (the actual root cause)
  in mp4box.
- Reuses: chunk crypto model, crypto worker, `/api/files/:id/chunks/:idx`,
  and the pure math from `logic.ts` (chunksCovering / chunkSlice / chunkIv /
  LruCache) — moved, not rewritten.
- Backend: zero changes.

## 2. SW retirement (delete / move / keep)

**Delete (whole P2b SW streaming path):**
- `web/src/sw/sw.ts`, `web/src/sw/register.ts`, and their tests.
- From `web/src/sw/logic.ts`: the SW-specific `handleStreamRequest`,
  `matchStreamId`, `applySwMessage`, `StreamMeta`, `SwMessage`, `ChunkFetcher`
  + their tests. (`logic.ts` is deleted entirely after the pure fns move.)
- `web/vite.config.ts`: remove the `VitePWA` plugin block (`strategies:
  injectManifest`, `srcDir: src/sw`, `filename: sw.ts`, `injectManifest`).
- `web/src/main.ts`: remove the `ensureStreamSw` import and its startup call.
- `web/src/stores/files.ts`: remove `ensureStreamSw` / `postToSw` imports,
  `bindSwListener`, the `needToken` SW-message handler, the `/api/stream/`
  URL, and `closePreview`'s `postToSw({type:"stop"})`.

**Move (pure fns reused by the new player) → `web/src/player/`:**
- `chunksCovering`, `chunkSlice`, `LruCache` → new `player/chunkbuf.ts`.
  (`chunkbuf` calls the crypto worker's `decryptChunk(key, ivBase, idx,
  cipher)`, which computes the per-chunk IV internally — so `chunkIv` and the
  `decryptChunkSubtle` copy from `logic.ts` are NOT carried over.)

**Keep / dedupe:**
- `chunkIv` in `crypto/symmetric.ts` remains the single source (used by the
  crypto worker). The `logic.ts` copy is deleted with the file.

## 3. Player module structure

New directory `web/src/player/`, one responsibility per file:

| File | Responsibility | Depends on |
|------|----------------|------------|
| `chunkbuf.ts` | Decrypted byte-range fetcher. Exports `createChunkBuffer({fileId, fileKey, ivBase, chunkSize, totalSize})` → `{ fetchRange(start,end): Promise<Uint8Array> }`. Internally: chunksCovering → per-chunk getChunk+decrypt+LRU → chunkSlice → assembled range. | `filesApi.getChunk`, `cryptoApi.decryptChunk`, `LruCache`, `chunksCovering`, `chunkSlice` |
| `msePlayer.ts` | MSE + mp4box orchestration. Exports `playMp4(videoEl, chunkBuffer, mime): Promise<void>` and `dispose()`. Creates MediaSource, wires onReady (codec/duration) + onSegment (appendBuffer) + seek (fetchRange → feed mp4box). | `mp4box.js`, `chunkbuf.ts` |
| `Mp4Player.vue` | `<video>` wrapper component. Mounts → start `msePlayer`; unmount/swap → `dispose`; surfaces errors to the store. | `msePlayer.ts` |

**Routing** in `stores/files.ts` `openVideo`:
- MP4 family (`video/mp4`, `video/quicktime`, `video/x-m4v`) → render
  `Mp4Player.vue` (preview carries `kind: "mp4"` + fileKey/ivBase/etc.; the
  component drives playback; no `/api/stream/` URL is set).
- Other video → fallback (§5).

**Isolation:** `chunkbuf.ts` is a pure fetcher (unit-testable: mock
getChunk/decrypt, assert range assembly + cache hits); `msePlayer.ts` is
orchestration (MSE/mp4box hard to unit-test — component-level + manual browser
verification); UI lives in the component. They decouple through the
`fetchRange` and `playMp4`/`dispose` interfaces.

## 4. Container detection & playback routing

**No upload-time probing.** Remove `web/src/crypto/videoprobe.ts` (+tests),
the `manifest.streamable` field, the `upload()` probe + warning, and the
`openVideo` `streamable===false` block. MSE does not care about moov position,
so all of that is obsolete.

**Playback routing by `manifest.mime`** (in `openVideo`):
- MP4 family → MSE player.
- Other video (WebM, `application/octet-stream`, …) → blob-or-download (§5).
- **Graceful fallback:** if the MSE player fails to parse (the file is not
  actually MP4), `openVideo` catches and falls back to blob-or-download.
- Future (out of scope v1): sniff chunk 0 to detect ISO-BMFF for ambiguous
  `application/octet-stream` videos and route them to MSE.

## 5. Fallback policy

- **MSE unsupported** (older iOS Safari) or **codec unsupported by MSE** →
  blob path: decrypt all chunks → `Blob` → `<video src=blob>`, gated by
  `PREVIEW_CAPS.video` (256 MiB).
- **Non-MP4 video** (WebM, etc.) → same blob path (plays if small enough).
- **Over `PREVIEW_CAPS` or unplayable** (AVI/MKV/FLV, large WebM) →
  `error = "无法在此浏览器播放，请下载"` (no playback).
- Reuses `openVideo`'s existing blob block + `canPreview` / `PREVIEW_CAPS`;
  no rewrite.

## 6. Testing

- **`chunkbuf.ts` (highest value, fully unit-testable):** mock
  `filesApi.getChunk` + `cryptoApi.decryptChunk`; assert `fetchRange(start,end)`
  returns correct bytes, chunk cache hits on repeat, cross-chunk-boundary
  ranges, and short tail-chunk slicing.
- **`msePlayer.ts`:** hard to unit-test (MSE + mp4box); mock the key callbacks
  to test orchestration (onReady → codec set; seek → fetchRange called).
  Component-level + manual browser verification for end-to-end.
- **Delete** all `web/src/sw/` tests (code is removed).
- **`files` store tests:** drop SW-related mocks; add a simple openVideo
  MIME-routing test (MP4 → MSE path; other → blob/download).

## 7. Migration & scope

- Delete P2b SW streaming (§2) + moov detection (§4).
- Add `web/src/player/` (`chunkbuf.ts`, `msePlayer.ts`, `Mp4Player.vue`).
- Modify `openVideo` + the preview model: video no longer sets a
  `/api/stream/` URL; MP4 renders through `Mp4Player.vue`.
- Backend: zero changes.
- The two unmerged commits on this branch (`materialize`, `detection`) are
  superseded — merged to master as one clean "MSE player replaces SW
  streaming" implementation.

## Dependencies

- Add **mp4box.js** (~150 KB gzipped) to `web/package.json`. It is the
  canonical ISO-BMFF demuxer for MSE; MP4/QuickTime/fragmented-MP4 only (which
  is the scope). No other new deps.

## Open question for the plan phase

Whether to land the MSE player + SW removal as one big task or as a
vertical-slice sequence (chunkbuf → msePlayer → component → route-in-openVideo
→ delete SW) is a plan-phase decision, intentionally left open here.
