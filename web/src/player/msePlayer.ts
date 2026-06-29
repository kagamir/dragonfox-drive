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
/** Backpressure: pause feeding/appending when more than this many seconds are
 *  buffered ahead of currentTime (bounds the SourceBuffer size). */
const AHEAD_SECONDS = 15;
/** Eviction: drop already-played buffered data older than this (seconds behind
 *  currentTime) before appending new data. This reclaims the disjoint buffered
 *  islands left by prior seek positions (the browser's MSE auto-eviction only
 *  fires on quota overflow and is unreliable for scattered ranges). Only removes
 *  behind data — never ahead, never re-fed — so it is invisible to mp4box's
 *  sample tracking and cannot corrupt emission. */
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

  // Per-SourceBuffer segment queue + drainer. Serializes appends per buffer
  // and paces each one against buffered-ahead, so a burst of segments from
  // mp4box (it emits synchronously per fed chunk) can't overflow the
  // SourceBuffer before backpressure re-engages.
  interface PendingSeg { buffer: ArrayBuffer; id: number; sampleNum: number; isLast: boolean }
  const segQueues = new Map<SourceBuffer, PendingSeg[]>();
  const draining = new Set<SourceBuffer>();

  mp4box.onSegment = (id: number, user: unknown, buffer: ArrayBuffer, sampleNum: number, isLast: boolean): void => {
    const sb = user as unknown as SourceBuffer;
    const q = segQueues.get(sb) ?? [];
    q.push({ buffer, id, sampleNum, isLast });
    segQueues.set(sb, q);
    void drain(sb);
  };

  async function drain(sb: SourceBuffer): Promise<void> {
    if (draining.has(sb)) return;
    draining.add(sb);
    try {
      while (!disposed) {
        const q = segQueues.get(sb);
        if (!q || q.length === 0) return;
        // Pace: don't append if this buffer already has AHEAD_SECONDS of
        // continuous data ahead of the playhead — wait for playback to consume.
        // This bounds each SourceBuffer; the browser's MSE auto-eviction
        // reclaims played-out data behind the playhead.
        while (!disposed && sbAhead(sb) >= AHEAD_SECONDS) await sleep(100);
        if (disposed) return;
        // Reclaim played-out data (and stale seek islands) behind the playhead
        // so the SourceBuffer can't fill up with disjoint ranges accumulated
        // across seeks. Safe: only removes behind data, never re-fed.
        await evictBehind(sb);
        if (disposed) return;
        // shift() can return undefined if a seek cleared segQueues (same array
        // reference) during the awaits above — re-evaluate rather than crash on
        // seg.buffer. The cleared segments belong to a stale seek target and are
        // intentionally discarded; the new feed's onSegment will restart drain.
        const seg = q.shift();
        if (!seg) continue;
        try {
          await appendAndWait(sb, seg.buffer);
        } catch (e) {
          if (!disposed) onError(e as Error);
          return;
        }
        try { mp4box.releaseUsedSamples(seg.id, seg.sampleNum); } catch { /* ignore */ }
        if (seg.isLast) { try { ms.endOfStream(); } catch { /* ignore */ } }
      }
    } finally {
      draining.delete(sb);
    }
  }

  /** Append `buffer` to `sb`, resolving on its updateend (waits for any
   *  in-flight op first). Rejects on append error. */
  function appendAndWait(sb: SourceBuffer, buffer: ArrayBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const doAppend = () => {
        if (disposed) return resolve();
        try {
          sb.appendBuffer(buffer);
          sb.addEventListener("updateend", () => resolve(), { once: true });
        } catch (e) { reject(e as Error); }
      };
      if (sb.updating) sb.addEventListener("updateend", doAppend, { once: true });
      else doAppend();
    });
  }

  /** Continuous buffered data ahead of the playhead in THIS SourceBuffer
   *  (0 if the playhead is in a gap). Bounds each buffer individually. */
  function sbAhead(sb: SourceBuffer): number {
    const t = video.currentTime;
    for (let i = 0; i < sb.buffered.length; i++) {
      if (t >= sb.buffered.start(i) && t <= sb.buffered.end(i)) {
        return sb.buffered.end(i) - t;
      }
    }
    return 0;
  }

  /** Continuous buffered data ahead of the playhead across ALL SourceBuffers
   *  (the minimum — what playback can actually consume). Used by the feed loop. */
  function continuousAhead(): number {
    let min = Infinity;
    for (const sb of Array.from(ms.sourceBuffers)) {
      min = Math.min(min, sbAhead(sb as SourceBuffer));
    }
    return Number.isFinite(min) ? min : 0;
  }

  /** Remove the portion of `sb`'s buffered data older than BEHIND_SECONDS behind
   *  currentTime (already played, including stale seek islands). One range call
   *  covers all behind ranges/gaps. Resolves immediately if nothing to remove. */
  function evictBehind(sb: SourceBuffer): Promise<void> {
    return new Promise(async (resolve) => {
      while (!disposed && sb.updating) await sleep(10);
      if (disposed || sb.buffered.length === 0) return resolve();
      const cut = video.currentTime - BEHIND_SECONDS;
      const earliest = sb.buffered.start(0);
      if (cut <= earliest) return resolve();
      try {
        sb.addEventListener("updateend", () => resolve(), { once: true });
        sb.remove(earliest, cut);
      } catch { resolve(); }
    });
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
    // Demo-pattern seek: let mp4box reposition and re-feed from the seek offset.
    // We do NOT clear SourceBuffers on seek (that corrupts mp4box: re-feeding
    // after a full clear makes it re-emit ahead data with erratic timestamps).
    // Buffer bounding is handled without touching mp4box state: feed backpressure
    // + per-SB drainer pacing bound ahead, evictBehind() reclaims played-out data
    // behind, and we drop stale queued segments (below) so cancelled feeds don't
    // leave junk islands.
    // Drop segments mp4box already emitted for the previous (now-stale) seek/feed
    // before repositioning — otherwise the drainer would append them as junk
    // buffered islands at the old position. Safe: mp4box has already emitted
    // them; we simply never append. Doesn't touch mp4box's sample tracking.
    for (const q of segQueues.values()) q.length = 0;
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

/** Everything Mp4Player.vue needs to build a ChunkBuffer and start the player.
 *  `fetchChunk` returns the ENCRYPTED bytes of chunk `idx`; the chunk buffer
 *  handles decryption. Injected so owners and share guests share one pipeline. */
export interface PlayerPayload {
  fileKey: Uint8Array;
  ivBase: Uint8Array;
  contentId: string;
  chunkSize: number;
  totalSize: number;
  fetchChunk: (idx: number) => Promise<Uint8Array>;
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
