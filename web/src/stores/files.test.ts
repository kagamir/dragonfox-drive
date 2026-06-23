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
  getChunkMock: vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3])))),
  getChunksMock: vi.fn().mockResolvedValue({ indices: [], chunk_count: 1, status: "pending" }),
}));

const { refreshAuthTokenMock } = vi.hoisted(() => ({
  refreshAuthTokenMock: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/api/client")>();
  return { ...mod, refreshAuthToken: refreshAuthTokenMock };
});

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
import { cryptoApi } from "@/workers/crypto";
import { ApiError } from "@/api/client";

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
    refreshAuthTokenMock.mockClear();
    refreshAuthTokenMock.mockResolvedValue(true);
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
      "fid", 0, expect.any(Uint8Array), undefined, expect.any(AbortSignal),
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

  it("upload refreshes the access token once on a 401 and retries the chunk", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    putChunkMock.mockReset();
    putChunkMock
      .mockRejectedValueOnce(new ApiError("unauthorized", 401))
      .mockResolvedValue({ ok: true });
    refreshAuthTokenMock.mockClear();
    refreshAuthTokenMock.mockResolvedValue(true);
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", { type: "text/plain" });
    await files.upload(file);
    expect(refreshAuthTokenMock).toHaveBeenCalledTimes(1);
    expect(finalizeMock).toHaveBeenCalledWith("fid");
    expect(putChunkMock).toHaveBeenCalledTimes(2);
    // restore default so other tests are unaffected
    putChunkMock.mockReset();
    putChunkMock.mockResolvedValue({ ok: true });
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

  it("download fetches every chunk and decrypts it", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    });
    const files = useFilesStore();
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 2,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.download(meta);
    expect(getChunkMock).toHaveBeenCalledWith("f1", 0);
    expect(getChunkMock).toHaveBeenCalledWith("f1", 1);
    expect((cryptoApi.decryptChunk as any)).toHaveBeenCalledTimes(2);
  });

  it("openPreview decrypts and opens a modal payload for a small text file", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const createObjectURL = vi.fn(() => "blob:p");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const files = useFilesStore();
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    expect(files.preview).not.toBeNull();
    expect(files.preview!.kind).toBe("text");
    expect(files.preview!.url).toBe("blob:p");
  });

  it("openPreview rejects files that are too large to preview", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    const files = useFilesStore();
    // decryptManifest mock returns size: 2; force it over the text cap
    (cryptoApi.decryptManifest as any).mockResolvedValueOnce({
      name: "big.txt", mime: "text/plain", size: 3 * 1024 * 1024,
      iv_base: "iv==", chunk_size: 4 * 1024 * 1024,
    });
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 0, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    expect(files.preview).toBeNull();
    expect(files.error).toMatch(/too large/i);
  });

  it("openPreview rejects unsupported file kinds with a distinct message", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    (cryptoApi.decryptManifest as any).mockResolvedValueOnce({
      name: "doc.pdf", mime: "application/pdf", size: 100,
      iv_base: "iv==", chunk_size: 4 * 1024 * 1024,
    });
    const files = useFilesStore();
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 0, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    expect(files.preview).toBeNull();
    expect(files.error).toMatch(/not supported/i);
    expect(files.error).not.toMatch(/too large/i);
  });

  it("openPreview revokes the prior blob URL on consecutive opens", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const createObjectURL = vi.fn()
      .mockReturnValueOnce("blob:A")
      .mockReturnValueOnce("blob:B");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const files = useFilesStore();
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    await files.openPreview(meta);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:A");
    expect(files.preview!.url).toBe("blob:B");
  });

  it("closePreview revokes the url and clears state", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:p"), revokeObjectURL: revoke });
    const files = useFilesStore();
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    files.closePreview();
    expect(revoke).toHaveBeenCalledWith("blob:p");
    expect(files.preview).toBeNull();
  });
});
