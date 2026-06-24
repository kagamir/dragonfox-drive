import { describe, it, expect } from "vitest";
import { probeStreamable } from "./videoprobe";

/** Build an ISO-BMFF top-level box: 8-byte header (uint32 size + 4-byte type)
 *  followed by `payloadLen` zero bytes. */
function box(type: string, payloadLen = 0): Uint8Array {
  const b = new Uint8Array(8 + payloadLen);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 8 + payloadLen);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe("videoprobe", () => {
  it("flags ftyp → mdat → moov as NON-streamable (moov at end)", () => {
    const header = concat(box("ftyp", 24), box("mdat", 1000), box("moov", 200));
    const r = probeStreamable(header);
    expect(r.streamable).toBe(false);
    expect(r.reason).toMatch(/moov/i);
  });

  it("flags ftyp → moov → mdat as streamable (faststart)", () => {
    const header = concat(box("ftyp", 24), box("moov", 200), box("mdat", 1000));
    expect(probeStreamable(header).streamable).toBe(true);
  });

  it("returns streamable when moov is the first box (no ftyp)", () => {
    expect(probeStreamable(box("moov", 200)).streamable).toBe(true);
  });

  it("returns non-streamable when mdat is the first box", () => {
    expect(probeStreamable(box("mdat", 1000)).streamable).toBe(false);
  });

  it("skips free/wide boxes before moov", () => {
    const header = concat(box("ftyp", 24), box("free", 16), box("wide", 0), box("moov", 200));
    expect(probeStreamable(header).streamable).toBe(true);
  });

  it("skips free boxes before mdat → still non-streamable", () => {
    const header = concat(box("ftyp", 24), box("free", 16), box("mdat", 1000));
    expect(probeStreamable(header).streamable).toBe(false);
  });

  it("does NOT false-positive on non-MP4 data (PNG header) → streamable (unknown)", () => {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A — first box "type" is not ftyp
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(probeStreamable(png).streamable).toBe(true);
  });

  it("does not false-positive on WebM/Matroska EBML header → streamable", () => {
    // WebM starts with 1A 45 DF A3 — not ftyp
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
    expect(probeStreamable(webm).streamable).toBe(true);
  });

  it("returns streamable on empty / truncated header (no false positive)", () => {
    expect(probeStreamable(new Uint8Array(0)).streamable).toBe(true);
    expect(probeStreamable(new Uint8Array(4)).streamable).toBe(true);
  });

  it("handles a 64-bit largesize box (size == 1) when skipping the lead box", () => {
    // ftyp with largesize, then mdat — should still reach mdat and flag non-streamable.
    // ftyp header: size=1 (largesize), type=ftyp, then 8-byte largesize = 40.
    const ftyp = new Uint8Array(16);
    const dv = new DataView(ftyp.buffer);
    dv.setUint32(0, 1); // size=1 → largesize follows
    ftyp[4] = "f".charCodeAt(0); ftyp[5] = "t".charCodeAt(0);
    ftyp[6] = "y".charCodeAt(0); ftyp[7] = "p".charCodeAt(0);
    dv.setUint32(8, 0); dv.setUint32(12, 40); // 64-bit largesize = 40
    // pad ftyp to 40 bytes total (24 bytes of payload after the 16-byte largesize header)
    const ftypFull = concat(ftyp, new Uint8Array(24));
    const header = concat(ftypFull, box("mdat", 1000));
    expect(probeStreamable(header).streamable).toBe(false);
  });
});
