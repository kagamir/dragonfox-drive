import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const {
  createMock,
  putManifestMock,
  putChunkMock,
  finalizeMock,
  removeMock,
  getChunkMock,
  getChunksMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  putManifestMock: vi.fn().mockResolvedValue({ ok: true }),
  putChunkMock: vi.fn().mockResolvedValue({ ok: true }),
  finalizeMock: vi.fn().mockResolvedValue({ ok: true }),
  removeMock: vi.fn().mockResolvedValue({ ok: true }),
  getChunkMock: vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))),
  getChunksMock: vi.fn().mockResolvedValue({ indices: [], chunk_count: 1, status: "pending" }),
}));

vi.mock("@/workers/crypto", () => ({
  cryptoApi: {
    newFileKeyMaterial: vi.fn(() => ({
      fileKey: new Uint8Array(32),
      ivBase: new Uint8Array(12),
    })),
    wrap: vi.fn().mockResolvedValue({
      ciphertext: new Uint8Array([9]),
      iv: new Uint8Array([8]),
    }),
    seal: vi.fn().mockResolvedValue({
      ciphertext: new Uint8Array([7]),
      iv: new Uint8Array([6]),
    }),
    encryptChunk: vi.fn().mockResolvedValue(new Uint8Array([5])),
    decryptManifest: vi.fn().mockResolvedValue({
      name: "dl.txt", mime: "text/plain", size: 2,
      iv_base: "iv==", chunk_size: 4 * 1024 * 1024,
    }),
    unwrap: vi.fn().mockResolvedValue(new Uint8Array(32)),
    decryptChunk: vi.fn().mockResolvedValue(new Uint8Array([9, 9])),
  },
  ensureCryptoReady: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/api/files", () => ({
  filesApi: {
    list: vi.fn().mockResolvedValue({ files: [] }),
    create: (b: unknown) => {
      createMock(b);
      return Promise.resolve({ id: "fid", upload_url: "/x" });
    },
    putManifest: putManifestMock,
    putChunk: putChunkMock,
    finalize: finalizeMock,
    remove: removeMock,
    getChunk: getChunkMock,
    getChunks: getChunksMock,
  },
}));

import { useFilesStore } from "./files";
import { useAuthStore } from "./auth";

describe("files store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    createMock.mockClear();
    putManifestMock.mockClear();
    putChunkMock.mockClear();
    finalizeMock.mockClear();
    removeMock.mockClear();
    getChunksMock.mockClear();
    getChunksMock.mockResolvedValue({ indices: [], chunk_count: 1, status: "pending" });
  });

  it("upload runs create → putManifest → putChunk → finalize", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", { type: "text/plain" });
    await files.upload(file);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ total_size: 2, chunk_count: 1 }),
    );
    expect(putManifestMock).toHaveBeenCalledWith("fid", expect.any(Object));
    expect(putChunkMock).toHaveBeenCalledWith(
      "fid", 0, expect.any(Uint8Array), expect.any(Function), expect.any(AbortSignal),
    );
    expect(finalizeMock).toHaveBeenCalledWith("fid");
  });

  it("upload skips chunks the server already has (resume)", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    getChunksMock.mockResolvedValue({ indices: [0], chunk_count: 1, status: "pending" });
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", { type: "text/plain" });
    await files.upload(file);
    expect(putChunkMock).not.toHaveBeenCalled();
    expect(finalizeMock).toHaveBeenCalledWith("fid");
  });

  it("upload retries a failing chunk then gives up", async () => {
    vi.useFakeTimers();
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    putChunkMock.mockReset();
    putChunkMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"));
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", { type: "text/plain" });
    const p = files.upload(file);
    // Attach the rejection handler BEFORE flushing the timers that trigger it,
    // otherwise the promise rejects unhandled and vitest fails the run.
    const assertion = expect(p).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(20000);
    await assertion;
    // initial attempt + 3 retries = 4 calls
    expect(putChunkMock).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("cancelUpload aborts and deletes the pending file", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    // stall putChunk on a promise the test resolves, so we can cancel mid-flight
    let resolvePut: (v: unknown) => void = () => {};
    putChunkMock.mockImplementation(
      () => new Promise((r) => { resolvePut = r; }),
    );
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", { type: "text/plain" });
    const p = files.upload(file);
    await new Promise((r) => setTimeout(r, 10));
    expect(files.activeUploads.length).toBe(1);
    const id = files.activeUploads[0].fileId;
    await files.cancelUpload(id);
    expect(removeMock).toHaveBeenCalledWith(id);
    expect(files.activeUploads.length).toBe(0);
    // release the stalled chunk so the upload coroutine can finish
    resolvePut({ ok: true });
    await p; // abort short-circuits before finalize; resolves cleanly
    putChunkMock.mockResolvedValue({ ok: true });
  });

  it("remove calls the api and refreshes", async () => {
    const files = useFilesStore();
    await files.remove("x");
    expect(removeMock).toHaveBeenCalledWith("x");
  });
});
