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
  filesWithParentMock: vi.fn(() => []),
  filesRefreshMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/files", () => ({ filesApi: {} }));
vi.mock("@/stores/files", () => ({
  useFilesStore: () => ({ filesWithParent: filesWithParentMock, refresh: filesRefreshMock }),
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
});
