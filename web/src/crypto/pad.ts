/**
 * Length-hiding padding for short encrypted fields (file/folder names, the
 * manifest). AES-GCM is length-preserving, so without padding the ciphertext
 * length leaks the plaintext length — e.g. the approximate length of a file
 * name. We bucket the plaintext to a multiple of `block` bytes so the server
 * only learns which bucket a name falls into, not its exact length.
 *
 * Format: `[4-byte big-endian length][plaintext][zero padding]`, total length
 * rounded up to a multiple of `block` (at least one block). The length prefix
 * is inside the encrypted blob, so it leaks nothing and lets `unpad` recover
 * the exact bytes regardless of how many zero bytes were appended (and is
 * robust even when the plaintext itself ends in zero bytes).
 */

const LEN_PREFIX = 4;

/** Pad `data` to a multiple of `block` bytes (default 32), length-prefixed. */
export function pad(data: Uint8Array, block = 32): Uint8Array {
  if (block <= 0) throw new Error("block must be > 0");
  if (data.length > 0xffffffff) throw new Error("data too large to pad");
  const total = Math.max(block, Math.ceil((LEN_PREFIX + data.length) / block) * block);
  const out = new Uint8Array(total); // zero-filled
  new DataView(out.buffer).setUint32(0, data.length); // big-endian length
  out.set(data, LEN_PREFIX);
  return out;
}

/** Reverse {@link pad}: read the length prefix and slice out the real bytes. */
export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < LEN_PREFIX) throw new Error("padded input too short");
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  if (LEN_PREFIX + len > padded.length) throw new Error("corrupt padding: length out of range");
  return padded.slice(LEN_PREFIX, LEN_PREFIX + len);
}
