import { describe, expect, it } from "vitest";
import { relativeTime } from "../util/time";

describe("relativeTime", () => {
  const now = new Date("2026-06-25T12:00:00Z").getTime();

  it("returns 'just now' for < 1 minute", () => {
    expect(relativeTime(new Date(now - 30_000).toISOString(), now)).toBe("just now");
  });

  it("returns minutes for < 1 hour", () => {
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5 minutes ago");
  });

  it("returns hours for < 1 day", () => {
    expect(relativeTime(new Date(now - 2 * 3_600_000).toISOString(), now)).toBe("2 hours ago");
  });

  it("returns days for older timestamps", () => {
    expect(relativeTime(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe("3 days ago");
  });

  it("returns fallback for null", () => {
    expect(relativeTime(null, now)).toBe("never");
  });
});
