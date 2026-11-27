import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { flushPromises } from "@vue/test-utils";
import { toBase64, type Manifest } from "@/crypto/file";
import type { FileMeta } from "@/api/types";

const {
  createMock,
  putManifestMock,
  putChunkMock,
  finalizeMock,
  removeMock,
  getChunkMock,
  getChunksMock,
  replaceContentMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  putManifestMock: vi.fn().mockResolvedValue({ ok: true }),
  putChunkMock: vi.fn().mockResolvedValue({ ok: true }),
  finalizeMock: vi.fn().mockResolvedValue({ ok: true }),
  removeMock: vi.fn().mockResolvedValue({ ok: true }),
  getChunkMock: vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3])))),
  getChunksMock: vi.fn().mockResolvedValue({ indices: [], chunk_count: 1, status: "pending" }),
  replaceContentMock: vi.fn().mockResolvedValue({ ok: true, updated_at: "2026-07-02T01:00:00+00:00" }),
}));

const { refreshAuthTokenMock } = vi.hoisted(() => ({
  refreshAuthTokenMock: vi.fn().mockResolvedValue(true),
}));

const { currentFolderIdMock, folderKeyOfMock, filesMoveMock } = vi.hoisted(() => ({
  currentFolderIdMock: { value: null as string | null },
  folderKeyOfMock: vi.fn<() => Uint8Array | undefined>(() => undefined),
  filesMoveMock: vi.fn().mockResolvedValue({ ok: true }),
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
    encryptParentId: vi.fn().mockImplementation(async (_k: unknown, p: string | null) =>
      p === null ? null : { ciphertext: new Uint8Array([11]), iv: new Uint8Array([12]) },
    ),
    decryptParentId: vi.fn(),
    encryptChunk: vi.fn().mockResolvedValue(new Uint8Array([5])),
    decryptManifestWithKey: vi.fn().mockResolvedValue({
      name: "dl.txt", mime: "text/plain", size: 2,
      iv_base: "iv==", content_id: "ab".repeat(16), chunk_size: 4 * 1024 * 1024,
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
    replaceContent: replaceContentMock,
  },
}));

import { useFilesStore } from "./files";
import { useAuthStore } from "./auth";
import { cryptoApi } from "@/workers/crypto";
import { filesApi } from "@/api/files";
import { ApiError } from "@/api/client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function listingFile(id: string): FileMeta {
  return {
    id, owner_id: "u", status: "ready", total_size: 2, chunk_count: 1,
    encrypted_manifest: "YQ==", encrypted_manifest_nonce: "YQ==",
    encrypted_file_key: "YQ==", encrypted_file_key_nonce: "YQ==",
    encrypted_parent_id: null, encrypted_parent_id_nonce: null, created_at: "", updated_at: "",
  };
}

describe("files store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    createMock.mockClear();
    putManifestMock.mockClear();
    putChunkMock.mockClear();
    finalizeMock.mockClear();
    removeMock.mockClear();
    replaceContentMock.mockClear();
    getChunksMock.mockClear();
    getChunksMock.mockResolvedValue({ indices: [], chunk_count: 1, status: "pending" });
    refreshAuthTokenMock.mockClear();
    refreshAuthTokenMock.mockResolvedValue(true);
    (globalThis as unknown as { MediaSource: unknown }).MediaSource =
      class { static isTypeSupported = () => true; };
  });

  it("updates cached names and media types when a remote manifest changes or disappears", async () => {
    useAuthStore().masterKey = new Uint8Array(32);
    const files = useFilesStore();
    const row = {
      id: "f1", owner_id: "u", status: "ready" as const, total_size: 2, chunk_count: 1,
      encrypted_manifest: "YQ==", encrypted_manifest_nonce: "YQ==",
      encrypted_file_key: "YQ==", encrypted_file_key_nonce: "YQ==",
      encrypted_parent_id: null, encrypted_parent_id_nonce: null, created_at: "", updated_at: "",
    };
    vi.mocked(filesApi.list).mockResolvedValueOnce({ files: [row] });
    await files.refresh();
    expect(files.displayMimes.f1).toBe("text/plain");
    const manifest = {
      version: 1, name: "photo", mime: "image/jpeg", size: 2, created_at: "",
      iv_base: "", content_id: "", chunk_size: 4 * 1024 * 1024,
    };
    vi.mocked(cryptoApi.decryptManifestWithKey).mockResolvedValueOnce(manifest);
    vi.mocked(filesApi.list).mockResolvedValueOnce({ files: [{ ...row, encrypted_manifest: "Yg==" }] });
    await files.refresh();
    expect(files.displayNames.f1).toBe("photo");
    expect(files.displayMimes.f1).toBe("image/jpeg");
    vi.mocked(filesApi.list).mockResolvedValueOnce({ files: [] });
    await files.refresh();
    expect(files.displayMimes.f1).toBeUndefined();
    expect(files.displayNames.f1).toBeUndefined();
  });

  it.each(["cold load", "refresh"])("keeps unresolved rows out of the root during a %s", async (phase) => {
    useAuthStore().masterKey = new Uint8Array(32);
    const files = useFilesStore();
    const rootFile = listingFile("00000000-0000-4000-8000-000000000001");
    const child = {
      ...rootFile, id: "00000000-0000-4000-8000-000000000002", encrypted_manifest: "Yg==",
      encrypted_parent_id: "Yw==", encrypted_parent_id_nonce: "YQ==",
    };
    const rootName = "00000000-0000-4000-8000-000000000003"; // A real UUID-shaped filename.
    const manifest = (name: string): Manifest => ({
      version: 1, name, mime: "text/plain", size: 2, chunk_size: 4 * 1024 * 1024,
      iv_base: "", content_id: "", created_at: "",
    });
    const listing = (parent: string | null) =>
      files.filesWithParent(parent).map((f) => files.displayNames[f.id] ?? f.id);
    const previous = phase === "refresh" ? ["old.txt"] : [];
    if (phase === "refresh") {
      vi.mocked(filesApi.list).mockResolvedValueOnce({ files: [{ ...rootFile, encrypted_manifest: "ZA==" }] });
      vi.mocked(cryptoApi.decryptManifestWithKey).mockResolvedValueOnce(manifest("old.txt"));
      await files.refresh();
    }

    const parent = deferred<string>();
    const names = deferred<void>();
    vi.mocked(cryptoApi.decryptParentId).mockReturnValueOnce(parent.promise);
    folderKeyOfMock.mockReturnValueOnce(new Uint8Array(32));
    vi.mocked(filesApi.list).mockResolvedValueOnce({ files: [child, rootFile] });
    const decryptName = async (_key: Uint8Array, ciphertext: string) => {
      await names.promise;
      return manifest(ciphertext === rootFile.encrypted_manifest ? rootName : "trip.jpg");
    };
    vi.mocked(cryptoApi.decryptManifestWithKey).mockImplementationOnce(decryptName).mockImplementationOnce(decryptName);

    const refresh = files.refresh();
    await flushPromises();
    const beforeParent = listing(null);
    parent.resolve("album");
    await flushPromises();
    const beforeNames = { root: listing(null), album: listing("album") };
    names.resolve();
    await refresh;

    expect(beforeParent).toEqual(previous);
    expect(beforeNames).toEqual({ root: previous, album: [] });
    expect(listing(null)).toEqual([rootName]);
    expect(listing("album")).toEqual(["trip.jpg"]);
  });

  it("retries an unreadable parent on refresh without assigning its file to the root", async () => {
    useAuthStore().masterKey = new Uint8Array(32);
    const files = useFilesStore();
    const child = { ...listingFile("child"), encrypted_parent_id: "YQ==", encrypted_parent_id_nonce: "YQ==" };
    vi.mocked(filesApi.list).mockResolvedValueOnce({ files: [child] });
    vi.mocked(cryptoApi.decryptParentId).mockRejectedValueOnce(new Error("parent unavailable"));
    await files.refresh();
    expect(files.filesWithParent(null)).toEqual([]);
    expect(files.filesWithParent("album")).toEqual([]);
    expect(files.unplacedFileCount).toBe(1);

    vi.mocked(filesApi.list).mockResolvedValueOnce({ files: [child] });
    vi.mocked(cryptoApi.decryptParentId).mockResolvedValueOnce("album");
    folderKeyOfMock.mockReturnValueOnce(new Uint8Array(32));
    await files.refresh();
    expect(files.filesWithParent(null)).toEqual([]);
    expect(files.filesWithParent("album")).toEqual([child]);
    expect(files.unplacedFileCount).toBe(0);
  });

  it("keeps the newer listing when an older parent lookup finishes last", async () => {
    useAuthStore().masterKey = new Uint8Array(32);
    const files = useFilesStore();
    const current = listingFile("moved");
    const old = { ...current, encrypted_parent_id: "YQ==", encrypted_parent_id_nonce: "YQ==" };
    const parent = deferred<string>();
    vi.mocked(cryptoApi.decryptParentId).mockReturnValueOnce(parent.promise);
    vi.mocked(filesApi.list).mockResolvedValueOnce({ files: [old] }).mockResolvedValueOnce({ files: [current] });
    const olderRefresh = files.refresh();
    await flushPromises();
    await files.refresh();
    expect(files.filesWithParent(null)).toEqual([current]);

    parent.resolve("old-folder");
    await olderRefresh;
    expect(files.filesWithParent(null)).toEqual([current]);
    expect(files.filesWithParent("old-folder")).toEqual([]);
    expect(files.displayNames.moved).toBe("dl.txt");
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
    expect(getChunkMock).toHaveBeenCalledWith("f1", 0, expect.any(AbortSignal));
    expect(getChunkMock).toHaveBeenCalledWith("f1", 1, expect.any(AbortSignal));
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

  it.each([
    ["application/octet-stream", "image", "image/jpeg"],
    ["", "image", "image/jpeg"],
    ["text/plain", "text", "text/plain"],
  ])("opens .JPG with declared MIME %j as %s", async (mime, kind, blobType) => {
    useAuthStore().masterKey = new Uint8Array(32);
    const makeUrl = vi.fn((_blob: Blob) => "blob:preview");
    vi.stubGlobal("URL", { createObjectURL: makeUrl, revokeObjectURL: vi.fn() });
    try {
      vi.mocked(cryptoApi.decryptManifestWithKey).mockResolvedValueOnce({
        version: 1, name: "photo.JPG", mime, size: 2, created_at: "",
        iv_base: "AAAA", content_id: "ab".repeat(16), chunk_size: 4 * 1024 * 1024,
      });
      const store = useFilesStore();
      await store.openPreview({
        id: "f1", owner_id: "u", status: "ready", total_size: 2, chunk_count: 1,
        encrypted_manifest: "YQ==", encrypted_manifest_nonce: "YQ==",
        encrypted_file_key: "YQ==", encrypted_file_key_nonce: "YQ==", created_at: "", updated_at: "",
      });
      expect(store.preview?.kind).toBe(kind);
      expect(makeUrl.mock.calls[0][0].type).toBe(blobType);
      expect(store.preview?.previewBlob).toBe(makeUrl.mock.calls[0][0]);
    } finally { vi.unstubAllGlobals(); }
  });

  it("openPreview rejects files that are too large to preview", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    const files = useFilesStore();
    // decryptManifestWithKey mock returns size: 2; force it over the text cap
    (cryptoApi.decryptManifestWithKey as any).mockResolvedValueOnce({
      name: "big.txt", mime: "text/plain", size: 3 * 1024 * 1024,
      iv_base: "iv==", content_id: "ab".repeat(16), chunk_size: 4 * 1024 * 1024,
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
      iv_base: "iv==", content_id: "ab".repeat(16), chunk_size: 4 * 1024 * 1024,
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

  it("retains the current photo on failure and discards superseded or closed preview requests", async () => {
    useAuthStore().masterKey = new Uint8Array(32);
    const store = useFilesStore();
    const original = {
      id: "first", owner_id: "u", status: "ready" as const, total_size: 3, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn", encrypted_file_key: "fk",
      encrypted_file_key_nonce: "fkn", encrypted_parent_id: null, encrypted_parent_id_nonce: null,
      created_at: "", updated_at: "",
    };
    const manifest = { version: 1, name: "image.jpg", mime: "image/jpeg", size: 3, created_at: "",
      iv_base: "AAAA", content_id: "ab".repeat(16), chunk_size: 4 * 1024 * 1024 };
    for (let i = 0; i < 5; i++) vi.mocked(cryptoApi.decryptManifestWithKey).mockResolvedValueOnce(manifest);
    const create = vi.fn().mockReturnValueOnce("blob:a").mockReturnValueOnce("blob:b");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    try {
      await store.openPreview(original);
      getChunkMock.mockRejectedValueOnce(new Error("file unavailable"));
      await store.openPreview({ ...original, id: "unavailable" });
      expect(store.preview?.url).toBe("blob:a");
      expect(store.error).toBe("file unavailable");
      expect(revoke).not.toHaveBeenCalled();

      async function pending(id: string) {
        let resolve!: (v: Response) => void;
        const started = new Promise<void>((ready) => {
          getChunkMock.mockImplementationOnce(() => new Promise<Response>((r) => { resolve = r; ready(); }));
        });
        const done = store.openPreview({ ...original, id });
        await started;
        const signal = getChunkMock.mock.lastCall?.[2] as AbortSignal;
        expect(store.previewLoading).toBe(true);
        return { done, finish: () => resolve(new Response(new Uint8Array([1]))), signal };
      }
      const slow = await pending("old");
      await store.openPreview({ ...original, id: "new" });
      expect(slow.signal.aborted).toBe(true);
      slow.finish();
      await slow.done;
      expect(store.preview?.meta.id).toBe("new");
      expect(revoke).toHaveBeenCalledWith("blob:a");
      const closed = await pending("closed");
      store.closePreview();
      expect(closed.signal.aborted).toBe(true);
      closed.finish();
      await closed.done;
      expect(store.preview).toBeNull();
      expect(store.error).toBeNull();
      expect(store.previewLoading).toBe(false);
      expect(create).toHaveBeenCalledTimes(2);
      expect(revoke).toHaveBeenCalledWith("blob:b");
    } finally { vi.unstubAllGlobals(); }
  });

  it("openPreview routes an MP4 to the MSE player payload", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    (cryptoApi.decryptManifestWithKey as any).mockResolvedValue({
      name: "clip.mp4", mime: "video/mp4", size: 5 * 1024 * 1024 * 1024,
      iv_base: "iv==", content_id: "ab".repeat(16), chunk_size: 4 * 1024 * 1024,
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
    expect(files.preview).not.toBeNull();
    expect(files.preview!.player).not.toBeNull();
    // The player payload now carries an injected fetchChunk bound to the file
    // id, instead of a raw fileId field. Verify it wraps filesApi.getChunk and
    // returns the encrypted chunk bytes.
    const bytes = await files.preview!.player!.fetchChunk(0);
    expect(getChunkMock).toHaveBeenCalledWith("vid1", 0);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(files.preview!.url).toBe("");
  });

  it("openPreview falls back to blob for a non-MP4 small video", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:webm"),
      revokeObjectURL: vi.fn(),
    });
    (cryptoApi.decryptManifestWithKey as any).mockResolvedValue({
      name: "clip.webm", mime: "video/webm", size: 1000,
      iv_base: "iv==", content_id: "ab".repeat(16), chunk_size: 4 * 1024 * 1024,
    });
    const files = useFilesStore();
    const meta = {
      id: "v2", owner_id: "u", status: "ready" as const,
      total_size: 0, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    expect(files.preview).not.toBeNull();
    expect(files.preview!.player).toBeNull();
    expect(files.preview!.url).toBe("blob:webm");
    vi.unstubAllGlobals();
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

  it("renameFile re-encrypts the manifest with the new name and PUTs it", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    files.files = [];
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    files.files = [meta];
    putManifestMock.mockClear();
    (cryptoApi.seal as any).mockClear();
    await files.renameFile("f1", "new-name.txt");
    // The manifest was re-sealed with the file key and PUT back.
    expect(cryptoApi.seal).toHaveBeenCalledTimes(1);
    expect(putManifestMock).toHaveBeenCalledWith("f1", expect.objectContaining({
      encrypted_manifest: expect.any(String),
      encrypted_manifest_nonce: expect.any(String),
    }));
    // Display name cache is updated so the UI re-renders immediately.
    expect(files.displayNames["f1"]).toBe("new-name.txt");
    // Local manifest blob cache is updated so preview/download don't use stale data.
    const after = files.files.find((f) => f.id === "f1")!;
    expect(after.encrypted_manifest).toBe(toBase64(new Uint8Array([7])));
    expect(after.encrypted_manifest_nonce).toBe(toBase64(new Uint8Array([6])));
  });

  it("renameFile sets store.error and rethrows when the PUT fails", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    files.files = [meta];
    putManifestMock.mockClear();
    putManifestMock.mockRejectedValueOnce(new Error("server boom"));
    await expect(files.renameFile("f1", "whatever.txt")).rejects.toThrow("server boom");
    // On failure the display name must NOT be updated (cache stays consistent).
    expect(files.displayNames["f1"]).toBeUndefined();
    expect(files.error).toBe("server boom");
    // restore default for any later tests
    putManifestMock.mockResolvedValue({ ok: true });
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

  it("download pushes a session, tracks progress, and clears it on success", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    });
    const files = useFilesStore();
    const meta = {
      id: "p1", owner_id: "u", status: "ready" as const,
      total_size: 4, chunk_count: 3,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    // Record the session's phase as seen by each in-flight chunk: proves the
    // session was observable (pushed to activeDownloads) during the run.
    let seenDuring = 0;
    (cryptoApi.decryptChunk as any).mockImplementation(async () => {
      const s = files.activeDownloads.find((x) => x.fileId === "p1");
      if (s && s.phase === "downloading") seenDuring++;
      return new Uint8Array([9, 9]);
    });
    await files.download(meta);
    expect(seenDuring).toBe(3); // all 3 chunks saw the live "downloading" session
    // Final state: phase advanced to "done" and progress reached 1 (the
    // increment hook in the pool ran for every chunk). The session is still
    // in the list — the 1500ms cleanup timer hasn't fired yet.
    expect(files.activeDownloads.length).toBe(1);
    expect(files.activeDownloads[0].fileId).toBe("p1");
    expect(files.activeDownloads[0].phase).toBe("done");
    expect(files.activeDownloads[0].progress).toBe(1);
    // restore the default decryptChunk mock for any later tests
    (cryptoApi.decryptChunk as any).mockResolvedValue(new Uint8Array([9, 9]));
  });

  it("cancelDownload aborts and removes the session mid-flight", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    });
    // Stall getChunk so we can cancel before it resolves.
    let resolveGet: (v: Response) => void = () => {};
    getChunkMock.mockImplementation(
      () => new Promise<Response>((r) => { resolveGet = r; }),
    );
    const files = useFilesStore();
    const meta = {
      id: "c1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    const p = files.download(meta);
    // Let the pool reach the stalled getChunk.
    await new Promise((r) => setTimeout(r, 10));
    expect(files.activeDownloads.length).toBe(1);
    const abort = files.activeDownloads[0].abort;
    await files.cancelDownload("c1");
    expect(abort.signal.aborted).toBe(true);
    expect(files.activeDownloads.length).toBe(0);
    // Release the stalled request; download() resolves cleanly via the abort
    // short-circuit (no throw, no saveBlob).
    resolveGet(new Response(new Uint8Array([1, 2, 3])));
    await p;
  });

  it("cancelDownload is a no-op when no session matches", async () => {
    const files = useFilesStore();
    await expect(files.cancelDownload("nope")).resolves.toBeUndefined();
    expect(files.activeDownloads.length).toBe(0);
  });

  it("download marks the session as error when a chunk fails", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    });
    getChunkMock.mockReset();
    getChunkMock.mockRejectedValue(new Error("net fail"));
    const files = useFilesStore();
    const meta = {
      id: "e1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await expect(files.download(meta)).rejects.toThrow("net fail");
    // The session stays in the list, flagged as error (so the UI can show it).
    expect(files.activeDownloads.length).toBe(1);
    expect(files.activeDownloads[0].phase).toBe("error");
    // restore default getChunk mock for subsequent tests
    getChunkMock.mockImplementation(() =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3]))),
    );
  });

  function seedTextFile() {
    const files = useFilesStore();
    files.files = [{
      id: "fid", owner_id: "u", status: "ready", total_size: 2, chunk_count: 1,
      encrypted_manifest: toBase64(new Uint8Array([1])),
      encrypted_manifest_nonce: toBase64(new Uint8Array([2])),
      encrypted_file_key: toBase64(new Uint8Array([3])),
      encrypted_file_key_nonce: toBase64(new Uint8Array([4])),
      encrypted_parent_id: null, encrypted_parent_id_nonce: null,
      created_at: "c", updated_at: "2026-07-02T00:00:00+00:00",
    }];
    return files;
  }

  it("saveTextFile keeps the file's existing file_key so share links survive", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = seedTextFile();
    (cryptoApi.wrap as any).mockClear();
    await files.saveTextFile("fid", "hello");
    expect(replaceContentMock).toHaveBeenCalledTimes(1);
    const [id, body] = replaceContentMock.mock.calls[0]!;
    expect(id).toBe("fid");
    expect(body.total_size).toBe(5); // "hello" is 5 utf-8 bytes
    expect(body.expected_updated_at).toBe("2026-07-02T00:00:00+00:00");
    // chunk is the (mocked) encryptChunk output [5]
    expect(body.chunk).toBe(toBase64(new Uint8Array([5])));
    // The file's ORIGINAL wrapped key is sent back unchanged — never rewrapped
    // — which is what keeps any existing share links (holding the same
    // file_key wrapped with a share-derived key) working after the edit.
    expect(body.encrypted_file_key).toBe(toBase64(new Uint8Array([3])));
    expect(body.encrypted_file_key_nonce).toBe(toBase64(new Uint8Array([4])));
    expect(cryptoApi.wrap).not.toHaveBeenCalled();
    // manifest sealed with seal mock ct [7] / iv [6]
    expect(body.encrypted_manifest).toBe(toBase64(new Uint8Array([7])));
    expect(body.encrypted_manifest_nonce).toBe(toBase64(new Uint8Array([6])));
    // a fresh content_id was passed to encryptChunk (differs from the old
    // manifest's "ab…ab")
    const encryptChunk = vi.mocked(cryptoApi.encryptChunk);
    const contentId = encryptChunk.mock.calls[0]![4] as string;
    expect(contentId).toMatch(/^[0-9a-f]{32}$/);
    expect(contentId).not.toBe("ab".repeat(16));
  });

  it("saveTextFile syncs the local row on success, keeping the same file_key", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = seedTextFile();
    await files.saveTextFile("fid", "hello");
    const row = files.files[0]!;
    expect(row.total_size).toBe(5);
    expect(row.updated_at).toBe("2026-07-02T01:00:00+00:00");
    // file_key/nonce are untouched — same as the seeded meta's original values.
    expect(row.encrypted_file_key).toBe(toBase64(new Uint8Array([3])));
    expect(row.encrypted_file_key_nonce).toBe(toBase64(new Uint8Array([4])));
    expect(row.encrypted_manifest).toBe(toBase64(new Uint8Array([7])));
  });

  it("saveTextFile rejects empty content without calling the API", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = seedTextFile();
    await expect(files.saveTextFile("fid", "")).rejects.toThrow();
    expect(replaceContentMock).not.toHaveBeenCalled();
  });

  it("saveTextFile rejects content over 2 MiB without calling the API", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = seedTextFile();
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    await expect(files.saveTextFile("fid", big)).rejects.toThrow();
    expect(replaceContentMock).not.toHaveBeenCalled();
  });

  it("saveTextFile surfaces a 409 conflict", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = seedTextFile();
    replaceContentMock.mockRejectedValueOnce(new ApiError("conflict", 409));
    await expect(files.saveTextFile("fid", "hello")).rejects.toMatchObject({ status: 409 });
    expect(files.error).toBeTruthy();
    // Note: the local row is no longer asserted to stay byte-for-byte the
    // same here — a 409 now fires a best-effort refresh() (see the next
    // test), which legitimately replaces the cache with the server's view.
  });

  it("saveTextFile refreshes local state after a 409 so reopen-and-retry works", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = seedTextFile();
    replaceContentMock.mockRejectedValueOnce(new ApiError("conflict", 409));
    const listMock = vi.mocked(filesApi.list);
    listMock.mockClear();
    await expect(files.saveTextFile("fid", "hello")).rejects.toMatchObject({ status: 409 });
    // best-effort refresh() was fired so the local key material / manifest
    // catch up with the server before the user retries.
    expect(listMock).toHaveBeenCalled();
  });

  it("upload returns the created file id", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    const file = new File([new Uint8Array([7])], "u.txt", { type: "text/plain" });
    await expect(files.upload(file)).resolves.toBe("fid");
  });

  it("createTextFile uploads a text/plain File and returns its id", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    const id = await files.createTextFile("notes.txt", "hi");
    expect(id).toBe("fid");
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ total_size: 2, chunk_count: 1 }),
    );
  });

  it("createTextFile rejects empty content without calling create", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    createMock.mockClear();
    await expect(files.createTextFile("notes.txt", "")).rejects.toThrow();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("createTextFile rejects content over 2 MiB without calling create", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    createMock.mockClear();
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    await expect(files.createTextFile("notes.txt", big)).rejects.toThrow();
    expect(createMock).not.toHaveBeenCalled();
  });
});
