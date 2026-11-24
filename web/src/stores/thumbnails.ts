import { defineStore } from "pinia";
import { watch } from "vue";
import { filesApi } from "@/api/files";
import type { FileMeta } from "@/api/types";
import { FILE_CHUNK_SIZE, fromBase64 } from "@/crypto/file";
import { PREVIEW_CAPS } from "@/crypto/preview";
import { cryptoApi } from "@/workers/crypto";
import { displayMime } from "@/util/media";
import { embeddedJpeg, resizePhoto } from "@/util/photoThumbnail";
import { useAuthStore } from "./auth";
import { useFilesStore } from "./files";

const LARGE_PHOTO = 16 * 1024 * 1024;
// Offer these formats to the browser's native image decoder. SVG uses the
// same image-only draw-to-canvas path; tiles receive only the raster output.
const thumbnailTypes = new Set([
  "image/apng", "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif",
  "image/jpeg", "image/jxl", "image/png", "image/svg+xml", "image/tiff",
  "image/vnd.microsoft.icon", "image/x-icon", "image/webp",
]);

export function thumbnailMime(mime: string | undefined, name: string): string | null {
  const type = displayMime(mime, name);
  if (type === "image/jpg" || type === "image/pjpeg") return "image/jpeg";
  return thumbnailTypes.has(type) ? type : null;
}

export const useThumbnailsStore = defineStore("thumbnails", () => {
  const auth = useAuthStore();
  const files = useFilesStore();
  const cache = new Map<string, Blob | null>();
  const small = { available: 2, waiting: new Set<() => void>() };
  const large = { available: 1, waiting: new Set<() => void>() };

  watch(() => [auth.userId, auth.masterKey, auth.isAuthenticated], () => cache.clear(), { flush: "sync" });

  // Keep only one large original in flight. A queued tile leaving the viewport
  // gives up its place immediately, without blocking unrelated small images.
  function acquire(pool: typeof small, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (pool.available > 0) { pool.available--; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      function abort() { pool.waiting.delete(start); reject(signal.reason); }
      function start() {
        pool.waiting.delete(start);
        signal.removeEventListener("abort", abort);
        pool.available--;
        resolve();
      }
      signal.addEventListener("abort", abort, { once: true });
      pool.waiting.add(start);
    });
  }

  async function build(meta: FileMeta, signal: AbortSignal): Promise<Blob | null> {
    const { fileKey, manifest } = await files.unlockFile(meta);
    const type = thumbnailMime(manifest.mime, manifest.name);
    const size = manifest.size;
    if (!type || !Number.isSafeInteger(size) || size <= 0 || size !== meta.total_size ||
        manifest.chunk_size !== FILE_CHUNK_SIZE || Math.ceil(size / FILE_CHUNK_SIZE) !== meta.chunk_count ||
        (size > PREVIEW_CAPS.image && type !== "image/jpeg")) return null;

    const iv = fromBase64(manifest.iv_base);
    const parts: Blob[] = [];
    for (let i = 0; i < meta.chunk_count; i++) {
      signal.throwIfAborted();
      const response = await filesApi.getChunk(meta.id, i, signal);
      const expected = Math.min(FILE_CHUNK_SIZE, size - i * FILE_CHUNK_SIZE) + 16;
      const declared = response.headers.get("Content-Length");
      if (declared !== null && Number(declared) !== expected) {
        await response.body?.cancel();
        return null;
      }
      const ciphertext = new Uint8Array(await response.arrayBuffer());
      if (ciphertext.byteLength !== expected) return null;
      signal.throwIfAborted();
      const plain = await cryptoApi.decryptChunk(fileKey, iv, i, ciphertext, manifest.content_id);
      if (i === 0 && type === "image/jpeg") {
        const thumb = await embeddedJpeg(plain);
        if (thumb) {
          try {
            const reduced = await resizePhoto(thumb, signal);
            if (reduced) return reduced;
          } catch {
            signal.throwIfAborted();
          }
        }
        if (size > PREVIEW_CAPS.image) return null;
      }
      // Allow the browser to back completed chunks with blob storage rather
      // than retaining an entire large camera original as JS typed arrays.
      parts.push(new Blob([plain as BlobPart]));
    }
    return resizePhoto(new Blob(parts, { type }), signal);
  }

  async function load(meta: FileMeta, signal: AbortSignal): Promise<Blob | null> {
    if (meta.status !== "ready" || !auth.isAuthenticated || !auth.masterKey || meta.owner_id !== auth.userId) return null;
    const key = meta.id + ":" + meta.encrypted_manifest_nonce;
    const sessionKey = auth.masterKey;
    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const pool = meta.total_size > LARGE_PHOTO ? large : small;
    await acquire(pool, signal);
    try {
      signal.throwIfAborted();
      if (sessionKey !== auth.masterKey) return null;
      const thumbnail = await build(meta, signal);
      signal.throwIfAborted();
      if (sessionKey !== auth.masterKey || meta.owner_id !== auth.userId || !auth.isAuthenticated) return null;
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(key, thumbnail);
      return thumbnail;
    } finally {
      pool.available++;
      pool.waiting.values().next().value?.();
    }
  }
  return { load };
});
