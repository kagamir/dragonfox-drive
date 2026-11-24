import { describe, expect, it } from "vitest";
import { mediaKind } from "./media";

describe("mediaKind", () => {
  it("uses explicit MIME even if the extension disagrees", () => {
    expect(mediaKind(" IMAGE/JPEG ; xx=1", "archive.txt")).toBe("image");
    expect(mediaKind("video/quicktime", "still.jpeg")).toBe("video");
    expect(mediaKind("text/plain", "not-a-photo.jpg")).toBeNull();
  });

  it("checks a case-insensitive extension for absent and binary types", () => {
    expect(mediaKind("application/octet-stream", "寒空.DNG")).toBe("image");
    expect(mediaKind("", "phone.MOV")).toBe("video");
    expect(mediaKind(undefined, "jpg")).toBeNull();
    expect(mediaKind(undefined, "photo.jpeg.txt")).toBeNull();
  });
});
