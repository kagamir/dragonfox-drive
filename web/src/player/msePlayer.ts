/**
 * MSE + mp4box.js player.
 *
 * mp4box.js demuxes the MP4 (parsing moov/fragments, computing duration,
 * slicing init/media segments); we feed it decrypted byte ranges from a
 * ChunkBuffer and append the segments it emits into a MediaSource that the
 * <video> element reads. Handles progressive MP4, fragmented MP4, moov-at-end,
 * and missing-duration files (mp4box computes duration from sample tables).
 *
 * The flow follows the gpac/mp4box.js demo:
 *   sourceopen → feed(0) → onReady (addSourceBuffer+setSegmentOptions+
 *   initializeSegmentation→append init) → on init updateend → mp4box.start()+
 *   feed(seek(0)) → onSegment (append media) → seeking → feed(seek(t)).
 */

import type { ChunkBuffer } from "./chunkbuf";

// mp4box 0.5.4 ships no type declarations; the orchestration below relies on
// the local type shims (MP4Info / MP4BoxSegmentUser / MP4InitSeg) + casts.
// @ts-expect-error mp4box 0.5.4 has no .d.ts — typed as `any` intentionally.
import MP4Box from "mp4box";

export interface MseHandle {
  dispose(): void;
}

const FETCH_BYTES = 1 * 1024 * 1024; // bytes fetched per round into mp4box
/** Backpressure: pause feeding when more than this many seconds are buffered
 *  ahead of currentTime (bounds the SourceBuffer size). */
const AHEAD_SECONDS = 30;
/** Eviction: drop already-played buffered data older than this (seconds behind
 *  currentTime) before appending new data. */
const BEHIND_SECONDS = 10;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function playMp4(
  video: HTMLVideoElement,
  buf: ChunkBuffer,
  totalSize: number,
  onError: (e: Error) => void,
): MseHandle {
  if (typeof MediaSource === "undefined") {
    onError(new Error("MediaSource not supported in this browser"));
    return { dispose() {} };
  }

  const ms = new MediaSource();
  video.src = URL.createObjectURL(ms);
  const mp4box = MP4Box.createFile();

  let disposed = false;
  let initsPending = 0;
  let started = false;
  let feedToken = 0;

  mp4box.onError = (e: unknown) => { if (!disposed) onError(new Error(String(e))); };

  mp4box.onReady = (info: MP4Info) => {
    try {
      ms.duration = info.isFragmented
        ? info.fragment_duration.num / info.fragment_duration.den
        : info.duration / info.timescale;
    } catch { /* leave default */ }
    let added = 0;
    for (const t of info.tracks) {
      const mime = `video/mp4; codecs="${t.codec}"`;
      if (!(MediaSource as unknown as { isTypeSupported(m: string): boolean }).isTypeSupported(mime)) {
        continue;
      }
      const sb = ms.addSourceBuffer(mime);
      (sb as unknown as { id: number }).id = t.id;
      mp4box.setSegmentOptions(t.id, sb as unknown as MP4BoxSegmentUser, { nbSamples: 1000 });
      added++;
    }
    if (added === 0) {
      onError(new Error("No MSE-playable tracks (codec unsupported)"));
      return;
    }
    const initSegs = mp4box.initializeSegmentation() as MP4InitSeg[];
    initsPending = initSegs.length;
    for (const s of initSegs) {
      const sb = s.user as unknown as SourceBuffer;
      sb.addEventListener("updateend", () => onInitAppended(), { once: true });
      sb.appendBuffer(s.buffer);
    }
  };

  function onInitAppended(): void {
    initsPending--;
    if (initsPending > 0 || started || disposed) return;
    started = true;
    mp4box.start();
    const seekInfo = mp4box.seek(0, true) as { offset: number };
    void feed(seekInfo.offset);
  }

  mp4box.onSegment = (id: number, user: unknown, buffer: ArrayBuffer, sampleNum: number, isLast: boolean): void => {
    const sb = user as unknown as SourceBuffer;
    queueAppend(sb, buffer, () => {
      try { mp4box.releaseUsedSamples(id, sampleNum); } catch { /* ignore */ }
      if (isLast) { try { ms.endOfStream(); } catch { /* ignore */ } }
    });
  };

  function queueAppend(sb: SourceBuffer, buffer: ArrayBuffer, after: () => void): void {
    const tryAppend = async () => {
      while (!disposed) {
        if (!sb.updating) {
          // Drop already-played data so the SourceBuffer doesn't fill up.
          await evictBehind(sb);
        }
        if (disposed) return;
        if (!sb.updating) {
          try {
            sb.appendBuffer(buffer);
            sb.addEventListener("updateend", after, { once: true });
            return;
          } catch (e) {
            const name = (e as { name?: string })?.name;
            if (name === "QuotaExceededError") {
              // Proactive eviction wasn't enough (in-flight segments, edit-list
              // timeline gaps, video/audio divergence). Aggressively drop
              // everything behind the playhead and retry once.
              await evictAggressive(sb);
              if (disposed) return;
              try {
                sb.appendBuffer(buffer);
                sb.addEventListener("updateend", after, { once: true });
                return;
              } catch (e2) {
                if (!disposed) onError(e2 as Error);
                return;
              }
            }
            if (!disposed) onError(e as Error);
            return;
          }
        }
        await sleep(10);
      }
    };
    void tryAppend();
  }

  /** Remove the portion of `sb`'s buffered range that is BEHIND_SECONDS behind
   *  currentTime (already played). Returns once the remove completes (or nothing
   *  to remove). Keeps the SourceBuffer from filling past its quota. */
  function evictBehind(sb: SourceBuffer): Promise<void> {
    return new Promise((resolve) => {
      if (sb.buffered.length === 0) return resolve();
      const earliest = sb.buffered.start(0);
      const until = video.currentTime - BEHIND_SECONDS;
      if (until <= earliest) return resolve();
      try {
        sb.addEventListener("updateend", () => resolve(), { once: true });
        sb.remove(earliest, until);
      } catch {
        resolve();
      }
    });
  }

  /** Emergency eviction: drop EVERYTHING behind the playhead (keep only the
   *  frame at currentTime). Used to recover from a QuotaExceededError. */
  function evictAggressive(sb: SourceBuffer): Promise<void> {
    return new Promise((resolve) => {
      if (sb.buffered.length === 0) return resolve();
      const earliest = sb.buffered.start(0);
      const until = video.currentTime;
      if (until <= earliest) return resolve();
      try {
        sb.addEventListener("updateend", () => resolve(), { once: true });
        sb.remove(earliest, until);
      } catch {
        resolve();
      }
    });
  }

  /** Seconds of continuous buffered data ahead of the playhead. Returns 0 if
   *  currentTime is not inside any buffered range (a gap — must feed). */
  function continuousAhead(): number {
    const t = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (t >= video.buffered.start(i) && t <= video.buffered.end(i)) {
        return video.buffered.end(i) - t;
      }
    }
    return 0;
  }

  async function feed(start: number): Promise<void> {
    const myToken = ++feedToken;
    let cursor = start;
    while (!disposed && myToken === feedToken) {
      // Backpressure: don't feed (and thus don't append) more than AHEAD_SECONDS
      // of CONTINUOUS buffered data ahead of the playhead. mp4box only emits
      // segments for the bytes it has, so throttling the byte feed bounds the
      // SourceBuffer size. Critically, this measures the continuous range from
      // currentTime — if the playhead sits in a gap (e.g. after a backward seek
      // into evicted territory), continuousAhead() is 0 and we feed immediately,
      // avoiding a deadlock where buffered-end is far ahead but the playhead has
      // no data to advance into.
      while (!disposed && myToken === feedToken) {
        if (continuousAhead() < AHEAD_SECONDS) break;
        await sleep(200);
      }
      if (disposed || myToken !== feedToken) return;
      if (cursor >= totalSize) break;
      const end = Math.min(cursor + FETCH_BYTES - 1, totalSize - 1);
      let chunk: Uint8Array;
      try {
        chunk = await buf.fetchRange(cursor, end);
      } catch (e) {
        if (!disposed) onError(e as Error);
        return;
      }
      if (disposed || myToken !== feedToken) return;
      // mp4box.appendBuffer needs an ArrayBuffer (it constructs a DataView from
      // the arg). fetchRange returns a fresh full-buffer Uint8Array, so hand
      // over its underlying .buffer with fileStart set on it.
      const ab = chunk.buffer as ArrayBuffer;
      (ab as unknown as { fileStart: number }).fileStart = cursor;
      let next: number;
      try {
        next = mp4box.appendBuffer(ab) as number;
      } catch (e) {
        if (!disposed) onError(e as Error);
        return;
      }
      // mp4box's appendBuffer returns the next file offset it wants (it skips
      // large mdat to find moov, etc.). Use the hint when it advances,
      // otherwise fall back to sequential advance.
      cursor = typeof next === "number" && next > cursor ? next : end + 1;
    }
    if (!disposed && myToken === feedToken) {
      try { mp4box.flush(); } catch { /* ignore */ }
    }
  }

  function onSeeking(): void {
    if (disposed || !started) return;
    const t = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (t >= video.buffered.start(i) && t <= video.buffered.end(i)) return; // already buffered
    }
    const seekInfo = mp4box.seek(t, true) as { offset: number };
    void feed(seekInfo.offset);
  }

  video.addEventListener("seeking", onSeeking);

  ms.addEventListener("sourceopen", () => { void feed(0); });

  return {
    dispose(): void {
      disposed = true;
      video.removeEventListener("seeking", onSeeking);
      try { URL.revokeObjectURL(video.src); } catch { /* ignore */ }
      try { if (ms.readyState === "open") ms.endOfStream(); } catch { /* ignore */ }
    },
  };
}

/** Everything Mp4Player.vue needs to build a ChunkBuffer and start the player. */
export interface PlayerPayload {
  fileId: string;
  fileKey: Uint8Array;
  ivBase: Uint8Array;
  chunkSize: number;
  totalSize: number;
}

// --- minimal mp4box.js type shims (the library ships loose types) ----------
interface MP4Info {
  isFragmented: boolean;
  duration: number;
  timescale: number;
  fragment_duration: { num: number; den: number };
  tracks: { id: number; codec: string }[];
}
type MP4BoxSegmentUser = unknown;
interface MP4InitSeg { id: number; buffer: ArrayBuffer; user: unknown; }
