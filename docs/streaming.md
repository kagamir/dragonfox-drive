# Video Streaming Design (Range + MSE)

Goal: play arbitrarily large encrypted videos (up to ~500 GB) with random-seek
support without ever exposing plaintext to the server or blocking the UI.

## Pipeline overview

```
┌────────────────────────────────────────────────────────────────┐
│  Main thread                                                    │
│                                                                 │
│  <video>     ◄──── appendBuffer ────┐                          │
│      ▲                               │                          │
│      │ currentTime / 'seeking'       │                          │
│      ▼                               │                          │
│  VideoPlayer.vue  ──── need(range) ──┴──►  ChunkFetcher         │
│                                                  │              │
│                                                  │ fetch Range  │
└──────────────────────────────────────────────────┼──────────────┘
                                                   ▼
                            ┌──────────────────────────────────┐
                            │   Worker (stream-decrypt.worker) │
                            │                                                                  │
                            │   1. fetch encrypted chunk           │
                            │   2. AES-GCM decrypt (WebCrypto)    │
                            │   3. return plaintext Uint8Array    │
                            └─────────────────────────────────────┘
```

## Container index parsing

For precise seeking, the player parses the container's index so it can map
`currentTime → byte offset → chunk index`:

- **MP4 / MOV**: parse the `moov` atom, read the sample table (`stco`, `stsz`,
  `stts`, `stss`) to compute `(time, byte_offset)` pairs.
- **WebM / MKV**: parse the `Cues` element.
- **No index**: fall back to linear pre-fetch (seek is slower but works).

The index is parsed **client-side after decryption** - the server never sees
the structure.

## Chunk fetcher

- Knows `file_key`, `iv_base`, `chunk_size` (from the decrypted manifest).
- Resolves a `currentTime` request into `(chunk_index, byte_range)`.
- Issues `fetch(url, { headers: { Range: `bytes=${start}-${end}` } })`.
- Pipes the response through the decrypt worker (Comlink).
- Appends decrypted bytes to the `SourceBuffer` via `appendBuffer`.

## Buffer & pre-fetch strategy

| Event              | Action                                             |
|--------------------|----------------------------------------------------|
| Initial load       | Fetch first chunk immediately, start playback ASAP. |
| Steady playback    | Keep 3 chunks (~12 MiB) ahead of playhead.         |
| User seeks forward | Cancel current fetches, fetch target chunk + next. |
| User seeks back    | Fetch the target chunk; cached chunks reused.      |

HTTP/2 multiplexing allows 3-6 parallel chunk downloads.

## Codec handling

`MediaSource.isTypeSupported(mime)` is probed before opening a SourceBuffer.
Supported codecs depend on the browser (typically H.264, VP9, AV1, AAC, Opus).
Containers/codec combinations the browser cannot decode natively are reported
as unsupported in the UI - the encrypted blob is still downloadable.

## Cache layer

Decrypted chunks are cached in IndexedDB (keyed by `file_id:chunk_index`)
via `localforage`. Repeat playback or back-and-forth seeking hits the cache.

The cache is bounded (LRU, default 512 MiB per origin) and shared between
the owner and any active share session of the same file.

## Fallback path

If MSE is unavailable (older browsers, iOS Safari without MSE), the player
falls back to:

1. Fetch all chunks sequentially.
2. Decrypt them.
3. Build a single in-memory `Blob`.
4. Set `video.src = URL.createObjectURL(blob)`.

This works for small/medium files but is not suitable for very large videos.
The UI shows a warning in this case.

## Performance targets (1080p, 5 Mbps stream)

| Metric                     | Target |
|----------------------------|--------|
| Time to first frame        | < 1.5 s |
| Seek response (cached)     | < 100 ms |
| Seek response (uncached)   | < 800 ms |
| UI frame rate during seek  | 60 fps (worker offload) |

These are achieved by:
- 4 MiB chunks (≈ 6 s of 1080p content) - good granularity for seeking.
- Web Worker offload (no main-thread blocking during crypto).
- Parallel chunk fetches over HTTP/2.
- IndexedDB-backed cache.
