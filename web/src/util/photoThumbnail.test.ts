import { describe, expect, it } from "vitest";
import { embeddedJpeg } from "./photoThumbnail";

describe("embedded JPEG thumbnails", () => {
  it("extracts the JPEG stored in Exif IFD1 without needing the original scan data", async () => {
    const bytes = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe1, 0, 56,
      69, 120, 105, 102, 0, 0, // Exif prefix
      77, 77, 0, 42, 0, 0, 0, 8,
      0, 0, 0, 0, 0, 14, // empty IFD0, next IFD starts at offset 14
      0, 2,
      2, 1, 0, 4, 0, 0, 0, 1, 0, 0, 0, 44, // JPEGInterchangeFormat
      2, 2, 0, 4, 0, 0, 0, 1, 0, 0, 0, 4, // JPEGInterchangeFormatLength
      0, 0, 0, 0,
      0xff, 0xd8, 0xff, 0xd9, 0xff, 0xd9,
    ]);
    const blob = await embeddedJpeg(bytes);
    expect(blob?.type).toBe("image/jpeg");
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(Uint8Array.of(255, 216, 255, 217));
    expect(await embeddedJpeg(bytes.subarray(0, 24))).toBeNull();
  });
});
