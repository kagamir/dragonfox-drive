# Video Streaming Design (MSE + mp4box.js)

Goal: play arbitrarily large encrypted videos with byte-exact random seek,
without exposing plaintext to the server and without holding the whole file
in memory.

> **History.** An earlier design used a Service Worker that synthesized
> `206` byte-range responses at `/api/stream/:id` for the native `<video>`
> element. That was browser-fragile: Chrome's media cache does not
> progressively read SW-synthesized streaming bodies, so large videos (and
> any file lacking usable duration/seek metadata — fragmented MP4, screen
> recordings) degraded to "load everything before play." The SW path has
> been **removed** in favor of the MSE pipeline below.

## Pipeline

```
<video>  ←  src = MediaSource objectURL
  │
MediaSource  →  SourceBuffer (codec from moov, via mp4box)
  ▲
  │ appendBuffer(init / media segments)
mp4box.js  (JS demuxer: parses moov/fragments, computes duration, slices
            segments, maps seek-time → byte offset)
  ▲
  │ requests byte range [start..end]
chunkbuf (web/src/player/chunkbuf.ts)
  │  chunksCovering → filesApi.getChunk(id,idx) → cryptoApi.decryptChunk
  │  (crypto worker) → 256 MiB LRU → chunkSlice → assembled range
  ▼
/api/files/:id/chunks/:idx   (existing backend, unchanged)
```

## Why this works where the SW didn't

- The failure was specifically `<video>` *directly consuming* an
  SW-synthesized streaming `206`. Here `<video>` reads from an in-page
  `MediaSource`; bytes reach it via JS (`fetch` + mp4box + MSE), which has no
  such limitation.
- mp4box.js parses **incrementally** (you feed byte ranges on demand) — the
  whole file is never loaded, so there is no large-file OOM.
- mp4box.js computes duration and handles seeking for progressive MP4,
  fragmented MP4, moov-at-end, and missing-`mvhd`-duration files (the actual
  root cause of the earlier Chrome issue).

## Routing & fallback

- MP4 family (`video/mp4`, `video/quicktime`, `video/x-m4v`) with MSE
  available → MSE player (`Mp4Player.vue`).
- Non-MP4 video, or MSE/codec unsupported, small enough (≤
  `PREVIEW_CAPS.video`, 256 MiB) → decrypt-all → in-memory `Blob` →
  `<video src=blob>`.
- Otherwise → "use Download" (no in-page playback).

No upload-time container probing; routing is by manifest MIME at playback.
MSE-unsupported browsers (older iOS Safari) get the blob fallback.

## Components

- `web/src/player/chunkbuf.ts` — pure chunk math + decrypted byte-range
  fetcher (the only unit-testable piece; the rest is MSE orchestration).
- `web/src/player/msePlayer.ts` — mp4box + MediaSource orchestration.
- `web/src/components/Mp4Player.vue` — `<video>` wrapper that mounts the
  player and disposes on unmount.
- `web/src/stores/files.ts` `openVideo` — routes MP4 → MSE payload, else
  blob/download.

## Limitations

- MP4 family only for streaming. WebM/AVI/MKV use the blob fallback (or
  "use Download" when too large); a WebM MSE demuxer is future work.
- MSE/codec support still varies by browser (e.g. HEVC). Unsupported codecs
  fall back to blob/download.
