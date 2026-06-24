import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { toBase64 } from "@/crypto/file";

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

const { ensureStreamSwMock, postToSwMock, getTokenMock } = vi.hoisted(() => ({
  ensureStreamSwMock: vi.fn().mockResolvedValue(undefined),
  postToSwMock: vi.fn(),
  getTokenMock: vi.fn().mockReturnValue("tok"),
}));

const { currentFolderIdMock, folderKeyOfMock, filesMoveMock } = vi.hoisted(() => ({
  currentFolderIdMock: { value: null as string | null },
  folderKeyOfMock: vi.fn(() => undefined),
  filesMoveMock: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/sw/register", () => ({
  ensureStreamSw: ensureStreamSwMock,
  postToSw: postToSwMock,
}));

vi.mock("@/stores/folders", () => ({
  useFoldersStore: () => ({
    get currentFolderId() {
      return currentFolderIdMock.value;
    },
    folderKeyOf: folderKeyOfMock,
  }),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/api/client")>();
  return { ...mod, refreshAuthToken: refreshAuthTokenMock, getAuthToken: getTokenMock };
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
    encryptParentId: vi.fn().mockImplementation(async (_k: unknown, p: string | null) =>
      p === null ? null : { ciphertext: new Uint8Array([11]), iv: new Uint8Array([12]) },
    ),
    encryptChunk: vi.fn().mockResolvedValue(new Uint8Array([5])),
    decryptManifestWithKey: vi.fn().mockResolvedValue({
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
    move: filesMoveMock,
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
    // decryptManifestWithKey mock returns size: 2; force it over the text cap
    (cryptoApi.decryptManifestWithKey as any).mockResolvedValueOnce({
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
    (cryptoApi.decryptManifestWithKey as any).mockResolvedValueOnce({
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

  it("openPreview routes video to the streaming URL via the SW", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    ensureStreamSwMock.mockResolvedValue(undefined);
    (cryptoApi.decryptManifestWithKey as any).mockResolvedValue({
      name: "clip.mp4", mime: "video/mp4", size: 5 * 1024 * 1024 * 1024,
      iv_base: "iv==", chunk_size: 4 * 1024 * 1024,
    });
    const files = useFilesStore();
    const meta = {
      id: "vid1", owner_id: "u", status: "ready" as const,
      total_size: 0, chunk_count: 2,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    expect(ensureStreamSwMock).toHaveBeenCalled();
    expect(postToSwMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "play",
      meta: expect.objectContaining({ fileId: "vid1", chunkCount: 2, mime: "video/mp4" }),
    }));
    expect(files.preview).not.toBeNull();
    expect(files.preview!.url).toBe("/api/stream/vid1");
    expect(files.preview!.kind).toBe("video");
  });

  it("needToken SW message refreshes the token and posts it back", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    ensureStreamSwMock.mockResolvedValue(undefined);
    (cryptoApi.decryptManifestWithKey as any).mockResolvedValue({
      name: "clip.mp4", mime: "video/mp4", size: 5 * 1024 * 1024 * 1024,
      iv_base: "iv==", chunk_size: 4 * 1024 * 1024,
    });
    let captured: ((e: { data: unknown }) => void) | undefined;
    vi.stubGlobal("navigator", {
      ...(navigator as any),
      serviceWorker: {
        addEventListener: vi.fn((_: string, cb: (e: { data: unknown }) => void) => {
          captured = cb;
        }),
        controller: null,
      },
    });
    getTokenMock.mockReturnValue("fresh");
    const files = useFilesStore();
    const meta = {
      id: "vid1", owner_id: "u", status: "ready" as const,
      total_size: 0, chunk_count: 2,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    expect(captured).toBeDefined();
    postToSwMock.mockClear();
    refreshAuthTokenMock.mockClear();
    captured!({ data: { type: "needToken", fileId: "vid1" } });
    // the handler awaits refreshAuthToken (a resolved promise) before posting
    await new Promise((r) => setTimeout(r, 0));
    expect(refreshAuthTokenMock).toHaveBeenCalled();
    expect(postToSwMock).toHaveBeenCalledWith({ type: "token", fileId: "vid1", token: "fresh" });
    // restore so other tests are unaffected
    vi.unstubAllGlobals();
    getTokenMock.mockReturnValue("tok");
  });

  it("closePreview posts stop for a stream URL", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    ensureStreamSwMock.mockResolvedValue(undefined);
    (cryptoApi.decryptManifestWithKey as any).mockResolvedValue({
      name: "clip.mp4", mime: "video/mp4", size: 1000,
      iv_base: "iv==", chunk_size: 4 * 1024 * 1024,
    });
    const files = useFilesStore();
    const meta = {
      id: "vid2", owner_id: "u", status: "ready" as const,
      total_size: 0, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    postToSwMock.mockClear();
    files.closePreview();
    expect(postToSwMock).toHaveBeenCalledWith(expect.objectContaining({ type: "stop", fileId: "vid2" }));
  });

  it("falls back to blob when SW unavailable and the video is small", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    ensureStreamSwMock.mockRejectedValue(new Error("unsupported"));
    (cryptoApi.decryptManifestWithKey as any).mockResolvedValue({
      name: "small.mp4", mime: "video/mp4", size: 1000,
      iv_base: "iv==", chunk_size: 4 * 1024 * 1024,
    });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:small"),
      revokeObjectURL: vi.fn(),
    });
    const files = useFilesStore();
    const meta = {
      id: "vid3", owner_id: "u", status: "ready" as const,
      total_size: 0, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    expect(files.preview!.url).toBe("blob:small");
  });

  it("upload into a folder wraps fileKey with the folder key + sets parent", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    currentFolderIdMock.value = "fold";
    folderKeyOfMock.mockReturnValue(new Uint8Array(32).fill(7));
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", { type: "text/plain" });
    await files.upload(file);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ encrypted_parent_id: expect.any(String) }),
    );
    // fileKey was wrapped with the folder key, not masterKey: cryptoApi.wrap was
    // called with the folder key (32 bytes of 7) as the wrapper.
    expect((cryptoApi.wrap as any)).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      new Uint8Array(32).fill(7),
    );
    currentFolderIdMock.value = null;
    folderKeyOfMock.mockReturnValue(undefined);
  });

  it("upload to root wraps fileKey with masterKey and omits parent", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    currentFolderIdMock.value = null;
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", { type: "text/plain" });
    await files.upload(file);
    // create body should omit encrypted_parent_id (undefined → not in object)
    expect(createMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ encrypted_parent_id: expect.anything() }),
    );
  });

  it("moveFile re-wraps the file_key and PATCHes the new parent", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    // a file currently at root (no parent); move it into "dest"
    files.files = []; // ensure clean
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      encrypted_parent_id: null, encrypted_parent_id_nonce: null,
      created_at: "", updated_at: "",
    };
    files.files = [meta];
    folderKeyOfMock.mockReturnValue(new Uint8Array(32).fill(9)); // dest's folder key
    await files.moveFile("f1", "dest");
    expect(filesMoveMock).toHaveBeenCalledWith(
      "f1",
      expect.objectContaining({ encrypted_parent_id: expect.any(String) }),
    );
    // The local cache MUST be updated to the re-wrapped key + new parent, so the
    // file can be opened/downloaded WITHOUT a refresh (unlockFile reads
    // fileParents[id] for the unwrap key and meta.encrypted_file_key for the
    // ciphertext — both must point at the new parent's wrap together).
    const after = files.files.find((f) => f.id === "f1")!;
    expect(after.encrypted_file_key).toBe(toBase64(new Uint8Array([9])));
    expect(after.encrypted_file_key_nonce).toBe(toBase64(new Uint8Array([8])));
    expect(after.encrypted_parent_id).toBe(toBase64(new Uint8Array([11])));
    expect(after.encrypted_parent_id_nonce).toBe(toBase64(new Uint8Array([12])));
    folderKeyOfMock.mockReturnValue(undefined);
  });

  it("download of a folder-resident file unwraps with the folder key", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    });
    const folderKey = new Uint8Array(32).fill(7);
    folderKeyOfMock.mockReturnValue(folderKey);
    const files = useFilesStore();
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    files.fileParents = { f1: "fold" };
    (cryptoApi.unwrap as any).mockClear();
    await files.download(meta);
    expect(cryptoApi.unwrap).toHaveBeenCalledWith(
      expect.any(Object),
      folderKey,
    );
    folderKeyOfMock.mockReturnValue(undefined);
  });

  it("download of a root file unwraps with masterKey (unchanged behavior)", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const mk = auth.masterKey;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    });
    const files = useFilesStore();
    const meta = {
      id: "root1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    // no fileParents entry → null → masterKey is the wrap key
    (cryptoApi.unwrap as any).mockClear();
    await files.download(meta);
    expect(cryptoApi.unwrap).toHaveBeenCalledWith(expect.any(Object), mk);
  });
});
