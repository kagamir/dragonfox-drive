import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const { listMock, createMock, patchMock, removeMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  createMock: vi.fn(),
  patchMock: vi.fn().mockResolvedValue({ ok: true }),
  removeMock: vi.fn().mockResolvedValue({ ok: true, deleted_folders: 0, deleted_files: 0 }),
}));

vi.mock("@/api/folders", () => ({
  foldersApi: {
    list: listMock,
    create: (b: unknown) => {
      createMock(b);
      return Promise.resolve({ id: "new-id" });
    },
    patch: patchMock,
    remove: removeMock,
  },
}));

const {
  decryptParentIdMock,
  unwrapFolderKeyMock,
  decryptFolderNameMock,
  newFolderKeyMock,
  wrapFolderKeyMock,
  encryptFolderNameMock,
  encryptParentIdMock,
} = vi.hoisted(() => ({
  decryptParentIdMock: vi.fn(),
  unwrapFolderKeyMock: vi.fn(),
  decryptFolderNameMock: vi.fn(),
  newFolderKeyMock: vi.fn(() => new Uint8Array(32)),
  wrapFolderKeyMock: vi.fn().mockResolvedValue({ ciphertext: new Uint8Array([1]), iv: new Uint8Array([2]) }),
  encryptFolderNameMock: vi.fn().mockResolvedValue({ ciphertext: new Uint8Array([3]), iv: new Uint8Array([4]) }),
  encryptParentIdMock: vi.fn().mockResolvedValue({ ciphertext: new Uint8Array([5]), iv: new Uint8Array([6]) }),
}));

vi.mock("@/workers/crypto", () => ({
  cryptoApi: {
    decryptParentId: decryptParentIdMock,
    unwrapFolderKey: unwrapFolderKeyMock,
    decryptFolderName: decryptFolderNameMock,
    newFolderKey: newFolderKeyMock,
    wrapFolderKey: wrapFolderKeyMock,
    encryptFolderName: encryptFolderNameMock,
    encryptParentId: encryptParentIdMock,
  },
  ensureCryptoReady: vi.fn().mockResolvedValue(undefined),
}));

const { filesWithParentMock, filesRefreshMock } = vi.hoisted(() => ({
  filesWithParentMock: vi.fn<(_parent: string | null) => {id: string; status?: string}[]>(() => []),
  filesRefreshMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/files", () => ({ filesApi: {} }));
vi.mock("@/stores/files", () => ({
  useFilesStore: () => ({
    filesWithParent: filesWithParentMock, refresh: filesRefreshMock,
    displayMimes: { jpg: "image/jpeg", raw: "application/octet-stream", vid: "video/mp4", doc: "application/pdf" },
    displayNames: { raw: "camera.DNG", doc: "misleading.jpg" },
  }),
}));

import { useFoldersStore } from "./folders";
import { useAuthStore } from "./auth";

const ENC = "AA==";

function row(id: string, parentId: string | null) {
  return {
    id,
    encrypted_parent_id: parentId === null ? null : ENC,
    encrypted_parent_id_nonce: parentId === null ? null : ENC,
    encrypted_folder_key: ENC,
    encrypted_folder_key_nonce: ENC,
    encrypted_name: ENC,
    encrypted_name_nonce: ENC,
    created_at: "2026-06-24T00:00:00Z",
    updated_at: "2026-06-24T00:00:00Z",
  };
}

describe("folders store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    listMock.mockReset();
    createMock.mockClear();
    patchMock.mockClear();
    removeMock.mockClear();
    decryptParentIdMock.mockReset();
    unwrapFolderKeyMock.mockReset();
    decryptFolderNameMock.mockReset();
    filesWithParentMock.mockReset();
    filesWithParentMock.mockReturnValue([]);
    filesRefreshMock.mockClear();
  });

  it("loadTree decrypts shape, unwraps the key chain, and decrypts names", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const rootKey = new Uint8Array(32).fill(1);
    const childKey = new Uint8Array(32).fill(2);
    listMock.mockResolvedValue({ folders: [row("root", null), row("child", "root")] });
    decryptParentIdMock.mockResolvedValueOnce("root").mockResolvedValue("x");
    unwrapFolderKeyMock.mockResolvedValueOnce(rootKey).mockResolvedValueOnce(childKey);
    decryptFolderNameMock.mockResolvedValueOnce("Root").mockResolvedValueOnce("Child");

    const folders = useFoldersStore();
    await folders.loadTree();

    expect(folders.folders.length).toBe(2);
    const root = folders.folders.find((f) => f.id === "root")!;
    const child = folders.folders.find((f) => f.id === "child")!;
    expect(root.parentId).toBeNull();
    expect(root.name).toBe("Root");
    expect(child.parentId).toBe("root");
    expect(child.name).toBe("Child");
  });


  it("infers from every directly contained ready file rather than the current page", () => {
    const folders = useFoldersStore();
    expect(folders.effectiveMode).toBe("normal");
    const records = Array.from({ length: 52 }, (_, i) => ({ id: i < 26 ? "jpg" : "vid", status: "ready" }));
    filesWithParentMock.mockReturnValue([...records, { id: "raw", status: "ready" }, { id: "doc", status: "pending" }]);
    folders.navigateTo("album");
    expect(folders.currentMode).toBe("auto");
    expect(folders.effectiveMode).toBe("photos");
    expect(filesWithParentMock).toHaveBeenCalledWith("album");
    folders.navigateTo(null);
    filesWithParentMock.mockReturnValue(records);
    folders.navigateTo("other");
    expect(folders.effectiveMode).toBe("normal");
    folders.navigateTo("empty");
    filesWithParentMock.mockReturnValue([]);
    expect(folders.effectiveMode).toBe("normal");
  });

  it("reads the Android-compatible AES-GCM type vector and tolerates damaged optional metadata", async () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i);
    useAuthStore().masterKey = key;
    unwrapFolderKeyMock.mockResolvedValue(key);
    decryptFolderNameMock.mockResolvedValue("Album");
    listMock.mockResolvedValue({ folders: [
      { ...row("album", null), encrypted_type: "N2q5b6qWUC8paaRe/2ZzmDDTvu7nMg==", encrypted_type_nonce: "AAECAwQFBgcICQoL" },
      { ...row("broken", null), encrypted_type: "AA==", encrypted_type_nonce: "AA==" },
    ] });
    const folders = useFoldersStore();
    await folders.loadTree();
    folders.navigateTo("album");
    expect(folders.currentMode).toBe("photos");
    folders.navigateTo("broken");
    expect(folders.currentMode).toBe("auto");
    expect(folders.breadcrumbs[0].name).toBe("Album");
  });

  it("round-trips encrypted overrides across reloads and clears both fields on auto", async () => {
    const auth = useAuthStore();
    const key = new Uint8Array(32).fill(7);
    auth.masterKey = key;
    unwrapFolderKeyMock.mockResolvedValue(key);
    decryptFolderNameMock.mockResolvedValue("Album");
    listMock.mockResolvedValue({ folders: [row("album", null)] });
    patchMock.mockResolvedValue({ ok: true, folder_type_updated: true });
    const folders = useFoldersStore();
    await folders.loadTree();
    folders.navigateTo("album");
    expect(folders.currentMode).toBe("auto");
    await folders.setFolderMode("album", "photos");
    expect(folders.effectiveMode).toBe("photos");
    const [, metadata] = patchMock.mock.calls.at(-1)!;
    expect(Object.keys(metadata).sort()).toEqual(["encrypted_type", "encrypted_type_nonce"]);
    expect(atob(metadata.encrypted_type).length).toBe(6 + 16);
    expect(atob(metadata.encrypted_type_nonce).length).toBe(12);
    await folders.setFolderMode("album", "normal");
    expect(folders.currentMode).toBe("normal");
    listMock.mockResolvedValue({ folders: [{ ...row("album", null), ...metadata }] });
    await folders.loadTree();
    expect(folders.currentMode).toBe("photos");
    await folders.renameFolder("album", "Renamed");
    expect(patchMock.mock.calls.at(-1)![1]).not.toHaveProperty("encrypted_type");
    expect(folders.currentMode).toBe("photos");
    await folders.setFolderMode("album", "auto");
    expect(patchMock).toHaveBeenLastCalledWith("album", { encrypted_type: null, encrypted_type_nonce: null });
    expect(folders.currentMode).toBe("auto");

    patchMock.mockResolvedValueOnce({ ok: true });
    await expect(folders.setFolderMode("album", "normal")).rejects.toThrow();
    expect(folders.currentMode).toBe("auto");
  });

  it("orphans (parent not in set) are surfaced as root", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    listMock.mockResolvedValue({ folders: [row("orphan", "ghost")] });
    decryptParentIdMock.mockResolvedValueOnce("ghost");
    unwrapFolderKeyMock.mockResolvedValueOnce(new Uint8Array(32));
    decryptFolderNameMock.mockResolvedValueOnce("O");

    const folders = useFoldersStore();
    await folders.loadTree();
    expect(folders.folders[0].parentId).toBeNull();
  });

  it("moveFolder rejects moving a folder into its own descendant", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    listMock.mockResolvedValue({ folders: [row("a", null), row("b", "a")] });
    decryptParentIdMock.mockResolvedValueOnce("a").mockResolvedValue("x");
    unwrapFolderKeyMock.mockResolvedValue(new Uint8Array(32));
    decryptFolderNameMock.mockResolvedValue("n");
    const folders = useFoldersStore();
    await folders.loadTree();

    await expect(folders.moveFolder("a", "b")).rejects.toThrow(/descendant/i);
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("paginatedView returns the combined children list", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    listMock.mockResolvedValue({ folders: [row("a", null), row("b", null)] });
    decryptParentIdMock.mockResolvedValue("x");
    unwrapFolderKeyMock.mockResolvedValue(new Uint8Array(32));
    decryptFolderNameMock.mockResolvedValue("n");
    const folders = useFoldersStore();
    await folders.loadTree();

    expect(folders.paginatedView.length).toBe(2);
    expect(folders.totalPages).toBe(1);
  });

  it("createFolder posts wrapped key + encrypted name/parent and appends locally", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    listMock.mockResolvedValue({ folders: [] });
    const folders = useFoldersStore();
    await folders.loadTree();

    await folders.createFolder("New");
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ encrypted_name: expect.any(String) }),
    );
    expect(folders.folders.find((f) => f.id === "new-id")?.name).toBe("New");
  });

  it("deleteFolder sends the descendant set and removes locally", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    listMock.mockResolvedValue({ folders: [row("root", null), row("sub", "root")] });
    decryptParentIdMock.mockResolvedValueOnce("root").mockResolvedValue("x");
    unwrapFolderKeyMock.mockResolvedValue(new Uint8Array(32));
    decryptFolderNameMock.mockResolvedValue("n");
    filesWithParentMock.mockImplementation((pid: string | null) =>
      pid === "sub" ? [{ id: "file1" }] : [],
    );
    removeMock.mockResolvedValue({ ok: true, deleted_folders: 2, deleted_files: 1 });

    const folders = useFoldersStore();
    await folders.loadTree();
    await folders.deleteFolder("root");

    expect(removeMock).toHaveBeenCalledWith(
      "root",
      expect.objectContaining({
        folder_ids: expect.arrayContaining(["root", "sub"]),
        file_ids: ["file1"],
      }),
    );
    expect(folders.folders.length).toBe(0);
  });

  it("deleteFolder refreshes the files cache before computing the cascade", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    listMock.mockResolvedValue({ folders: [row("root", null), row("sub", "root")] });
    decryptParentIdMock.mockResolvedValueOnce("root").mockResolvedValue("x");
    unwrapFolderKeyMock.mockResolvedValue(new Uint8Array(32));
    decryptFolderNameMock.mockResolvedValue("n");
    filesWithParentMock.mockReturnValue([]);
    removeMock.mockResolvedValue({ ok: true, deleted_folders: 2, deleted_files: 0 });

    const folders = useFoldersStore();
    await folders.loadTree();

    filesRefreshMock.mockClear();
    removeMock.mockClear();
    await folders.deleteFolder("root");

    // refresh must run before the cascade DELETE is sent so the parent cache
    // (fileParents) is fresh when filesWithParent is read.
    expect(filesRefreshMock).toHaveBeenCalled();
    expect(filesRefreshMock.mock.invocationCallOrder[0]).toBeLessThan(
      removeMock.mock.invocationCallOrder[0],
    );
  });
});
