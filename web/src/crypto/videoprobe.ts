/**
 * Container-level streamability probe.
 *
 * The headline case: a non-faststart MP4 has its `moov` (the decode index)
 * AFTER its `mdat` (the media bytes). Browsers MUST read `moov` before they
 * can start decoding; for a byte-range source they normally seek to the end to
 * grab it, but Chrome's media stack served through a Service Worker does a
 * sequential scan instead, so the whole file has to be traversed before
 * playback — effectively "load everything to play." Firefox seeks and is fine.
 *
 * The robust fix (re-mux to faststart at upload) is deferred — it needs
 * client-side video parsing/repackaging. This probe instead DETECTS the
 * condition at upload so we can warn the user and block the streaming path
 * (offering Download), rather than silently thrashing.
 *
 * Scope: ISO-BMFF only (MP4 / QuickTime `ftyp`-first files). Other containers
 * (WebM/Matroska/…) are seek-via-Cues and not flagged here. The function is
 * pure and cheap — it reads only the top-level box headers present in the
 * first few hundred bytes; it never needs the whole file.
 */

export interface Streamability {
  streamable: boolean;
  reason?: string;
}

const STREAMABLE: Streamability = { streamable: true };

function typeAt(buf: Uint8Array, off: number): string {
  return String.fromCharCode(
    buf[off]!, buf[off + 1]!, buf[off + 2]!, buf[off + 3]!,
  );
}

/**
 * Decide streamability from the first bytes of a file. Walks top-level
 * ISO-BMFF boxes: the first `moov` ⇒ faststart (streamable); the first
 * `mdat` ⇒ non-faststart (moov must be later). Unknown / non-MP4 layouts ⇒
 * streamable (we never false-positive-block playback).
 */
export function probeStreamable(header: Uint8Array): Streamability {
  if (header.length < 8) return STREAMABLE;

  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  let off = 0;
  // A handful of top-level boxes is always enough to decide (typically ftyp
  // then either moov or mdat). Cap iterations to stay defensive against
  // malformed input. Non-MP4 data doesn't false-positive: its first "box size"
  // is a huge/garbage uint32 that skips past the header, exiting the loop.
  for (let i = 0; i < 32 && off + 8 <= header.length; i++) {
    const type = typeAt(header, off + 4);
    if (type === "moov") return STREAMABLE; // moov before any mdat
    if (type === "mdat") {
      return { streamable: false, reason: "non-faststart MP4 (moov after mdat)" };
    }
    let size = dv.getUint32(off);
    if (size === 1) {
      // largesize: real size is the next 8 bytes (64-bit). We only need it to
      // skip this box; if it overflows Number we've run past the header anyway.
      if (off + 16 > header.length) return STREAMABLE;
      size = Number(dv.getBigUint64(off + 8));
    } else if (size === 0) {
      size = header.length - off; // box runs to EOF
    }
    if (size < 8) return STREAMABLE; // malformed → unknown
    off += size;
  }
  return STREAMABLE; // exhausted the header without a moov/mdat verdict → unknown
}
