/** Preview category for a decrypted file. */
export type FileKind = "image" | "text" | "audio" | "video" | "other";

/** Max in-memory plaintext size (bytes) we are willing to decode per kind. */
export const PREVIEW_CAPS = {
  text: 2 * 1024 * 1024,
  image: 256 * 1024 * 1024,
  audio: 256 * 1024 * 1024,
  video: 256 * 1024 * 1024,
} as const;

/** Map a MIME type to a preview category. */
export function kindOf(mime: string): FileKind {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/javascript"
  ) {
    return "text";
  }
  return "other";
}

/** Whether a file of `kind` and plaintext `size` bytes may be previewed. */
export function canPreview(kind: FileKind, size: number): boolean {
  if (kind === "other") return false;
  const cap = PREVIEW_CAPS[kind];
  return size > 0 && size <= cap;
}
