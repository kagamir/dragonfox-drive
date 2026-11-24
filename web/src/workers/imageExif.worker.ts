import { readCameraBlob } from "@/util/imageExif";

// Structured cloning shares the immutable decrypted Blob with the worker;
// EXIF extraction needs no fetch and works under connect-src 'self'.
self.onmessage = async ({ data }: MessageEvent<Blob>) => {
  try {
    self.postMessage({ fields: await readCameraBlob(data) });
  } catch {
    self.postMessage({ failed: true });
  }
};
