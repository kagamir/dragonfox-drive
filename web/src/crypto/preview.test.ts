import { describe, it, expect } from "vitest";
import { kindOf, canPreview, PREVIEW_CAPS } from "./preview";

describe("preview helpers", () => {
  it("classifies common mime types", () => {
    expect(kindOf("image/png")).toBe("image");
    expect(kindOf("image/jpeg")).toBe("image");
    expect(kindOf("text/plain")).toBe("text");
    expect(kindOf("text/csv")).toBe("text");
    expect(kindOf("application/json")).toBe("text");
    expect(kindOf("application/xml")).toBe("text");
    expect(kindOf("application/javascript")).toBe("text");
    expect(kindOf("audio/mpeg")).toBe("audio");
    expect(kindOf("audio/ogg")).toBe("audio");
    expect(kindOf("video/mp4")).toBe("video");
    expect(kindOf("video/webm")).toBe("video");
    expect(kindOf("application/octet-stream")).toBe("other");
    expect(kindOf("application/pdf")).toBe("other");
    expect(kindOf("")).toBe("other");
  });

  it("canPreview respects per-kind caps", () => {
    expect(canPreview("text", 1)).toBe(true);
    expect(canPreview("text", PREVIEW_CAPS.text)).toBe(true);
    expect(canPreview("text", PREVIEW_CAPS.text + 1)).toBe(false);
    expect(canPreview("video", PREVIEW_CAPS.video)).toBe(true);
    expect(canPreview("video", PREVIEW_CAPS.video + 1)).toBe(false);
  });

  it("canPreview is always false for 'other'", () => {
    expect(canPreview("other", 1)).toBe(false);
  });
});
