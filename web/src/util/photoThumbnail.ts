import { thumbnail } from "exifr";

/** JPEG APP1 is at most 64 KiB. Use the existing EXIF decoder on the first
 * authenticated chunk so large camera JPEGs need not be downloaded in full. */
export async function embeddedJpeg(prefix: Uint8Array): Promise<Blob | null> {
  try {
    const bytes = await thumbnail(prefix);
    if (!bytes || bytes.length > 65_535 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    return new Blob([bytes as BlobPart], { type: "image/jpeg" });
  } catch {
    return null;
  }
}

/** Resize in memory. Keep original aspect ratio and honour the browser's
 * orientation handling. Drop the source URL on every exit path. */
export async function resizePhoto(source: Blob, signal: AbortSignal): Promise<Blob | null> {
  signal.throwIfAborted();
  const image = new Image();
  const url = URL.createObjectURL(source);
  let cancelLoad: (reason: unknown) => void;
  const loaded = new Promise<void>((resolve, reject) => {
    cancelLoad = reject;
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Image unavailable"));
  });
  const abort = () => {
    image.removeAttribute("src");
    cancelLoad(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    image.src = url;
    await loaded;
    signal.throwIfAborted();
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height) return null;
    const scale = Math.min(1, 480 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.78));
  } finally {
    signal.removeEventListener("abort", abort);
    URL.revokeObjectURL(url);
    image.removeAttribute("src");
  }
}
