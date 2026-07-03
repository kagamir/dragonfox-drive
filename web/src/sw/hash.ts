/**
 * Canonical build-hash algorithm shared by the build-time manifest plugin
 * (Node) and the Service Worker (browser). Both hash with the SAME function so
 * the SW can recompute the digest from the bytes it actually fetched and reject
 * an update whose bytes don't match the buildHash advertised in the manifest.
 * Uses WebCrypto (`crypto.subtle`) — present in browsers, Service Workers, and
 * Node >= 20 (CI uses Node 22).
 */
export interface HashEntry {
  path: string; // URL path, e.g. "/assets/index-abc.js"
  bytes: Uint8Array; // raw file contents
}

function u32(n: number): Uint8Array {
  const a = new Uint8Array(4);
  new DataView(a.buffer).setUint32(0, n, false); // big-endian for determinism
  return a;
}

function bytesToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function computeBuildHash(entries: HashEntry[]): Promise<string> {
  const sorted = [...entries].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    const p = enc.encode(e.path);
    parts.push(u32(p.length), p, u32(e.bytes.length), e.bytes);
  }
  const total = parts.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of parts) {
    buf.set(c, off);
    off += c.length;
  }
  return bytesToHex(await crypto.subtle.digest("SHA-256", buf));
}

/** Plain SHA-256 of raw bytes, hex — matches `sha256sum <file>`. Used to hash
 *  the served sw.js so users can compare it against the published release value. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
}
