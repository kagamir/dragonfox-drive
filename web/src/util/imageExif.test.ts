import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { readCameraBlob, readCameraData } from "./imageExif";

// Synthetic one-pixel JPEG with an EXIF IFD and a rational exposure, aperture and focal length.
const photo = readFileSync("src/util/__fixtures__/camera.jpg");

describe("camera metadata", () => {
  it("decodes camera and exposure values without duplicating the make or converting capture time zones", async () => {
    expect(await readCameraData(photo)).toEqual({
      camera: "Nikon Z 8", lens: "NIKKOR Z 35mm", focalLength: "35 mm", aperture: "ƒ/2.8",
      shutter: "1/250 s", sensitivity: "200", captured: "2025-11-15 09:10:11",
    });
  });

  it("seeks past large WebP pixel chunks to read trailing EXIF", async () => {
    const pixels = new Uint8Array(5 * 1024 * 1024);
    const tiffAt = photo.indexOf("Exif\0\0") + 6;
    const tiff = photo.subarray(tiffAt, tiffAt + 202);
    function chunk(id: string, length: number) {
      const bytes = new Uint8Array(8);
      bytes.set(new TextEncoder().encode(id));
      new DataView(bytes.buffer).setUint32(4, length, true);
      return bytes;
    }
    const blob = new Blob([chunk("RIFF", 4 + 8 + pixels.length + 8 + tiff.length), "WEBP",
      chunk("VP8 ", pixels.length), pixels, chunk("EXIF", tiff.length), new Uint8Array(tiff)]);
    expect((await readCameraBlob(blob)).shutter).toBe("1/250 s");
  });

  it("handles unsupported images and incomplete RIFF chunks", async () => {
    expect(await readCameraData(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toEqual({});
    const incomplete = new Uint8Array(24);
    incomplete.set(new TextEncoder().encode("RIFF"), 0);
    incomplete.set(new TextEncoder().encode("WEBPEXIF"), 8);
    new DataView(incomplete.buffer).setUint32(16, 10000, true);
    await expect(readCameraBlob(new Blob([incomplete]))).rejects.toThrow("Truncated image chunk");
  });
});
