import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { playMp4 } from "./msePlayer";
import type { ChunkBuffer } from "./chunkbuf";

// MP4Box module mock — just needs createFile() to return a stub.
vi.mock("mp4box", () => ({
  default: { createFile: () => ({ onReady: null, onSegment: null, onError: null }) },
}));

class FakeSourceBuffer {
  updating = false;
  buffered = { length: 0 } as unknown as TimeRanges;
  appendBuffer = vi.fn(() => { this.updating = false; });
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

class FakeMediaSource {
  readyState = "closed";
  duration = NaN;
  sourceBuffers: FakeSourceBuffer[] = [];
  static isTypeSupported = () => true;
  addSourceBuffer = () => {
    const sb = new FakeSourceBuffer();
    this.sourceBuffers.push(sb);
    return sb;
  };
  endOfStream = vi.fn();
  addEventListener = vi.fn((_: string, cb: () => void) => {
    // Immediately fire sourceopen so the player proceeds.
    this.readyState = "open";
    setTimeout(cb, 0);
  });
  removeEventListener = vi.fn();
}

describe("msePlayer", () => {
  beforeEach(() => {
    (globalThis as unknown as { MediaSource: unknown }).MediaSource = FakeMediaSource;
    (globalThis as unknown as { URL: unknown }).URL = {
      ...URL,
      createObjectURL: vi.fn(() => "blob:ms"),
      revokeObjectURL: vi.fn(),
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { MediaSource?: unknown }).MediaSource;
  });

  it("creates a MediaSource, points the video at it, and returns a dispose handle", async () => {
    const buf: ChunkBuffer = { fetchRange: vi.fn().mockResolvedValue(new Uint8Array(0)) };
    const video = { src: "", addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLVideoElement;
    const handle = playMp4(video, buf, 100, () => {});
    expect(handle).toBeDefined();
    expect(typeof handle.dispose).toBe("function");
    expect(video.src).toBe("blob:ms");
    expect(() => handle.dispose()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("calls onError if MediaSource is unavailable", () => {
    delete (globalThis as unknown as { MediaSource?: unknown }).MediaSource;
    const buf: ChunkBuffer = { fetchRange: vi.fn() };
    const video = { src: "", addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLVideoElement;
    const onError = vi.fn();
    playMp4(video, buf, 100, onError);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
