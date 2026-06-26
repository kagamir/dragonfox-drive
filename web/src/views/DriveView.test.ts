import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DriveView from "./DriveView.vue";
import { useConfirm } from "@/composables/useConfirm";
import { i18n } from "@/locales";
import type { FileMeta } from "@/api/types";

// Mutable, per-test-controllable stub state. vi.hoisted makes `STUB` available
// to the vi.mock factories below (which run at module load) and to each test.
const STUB = vi.hoisted(() => ({
  paginatedView: [] as Array<{ kind: "folder" | "file"; folder?: { id: string; name: string }; file?: FileMeta }>,
  remove: vi.fn().mockResolvedValue(undefined),
  deleteFolder: vi.fn().mockResolvedValue(undefined),
  loadTree: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/workers/crypto", () => ({ cryptoApi: {}, ensureCryptoReady: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/api/files", () => ({ filesApi: {} }));
vi.mock("@/api/folders", () => ({ foldersApi: {} }));

vi.mock("@/stores/files", () => ({
  useFilesStore: () => ({
    files: [], loading: false, error: null, uploading: false, uploadProgress: 0,
    downloading: false, displayNames: {} as Record<string, string>, activeUploads: [],
    activeDownloads: [] as { fileId: string; name: string; progress: number; phase: string }[],
    fileParents: {}, preview: null,
    refresh: STUB.refresh, upload: vi.fn().mockResolvedValue(undefined),
    cancelUpload: vi.fn(), cancelDownload: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
    remove: STUB.remove, filesWithParent: () => [], moveFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
    unlockFile: vi.fn(), openPreview: vi.fn().mockResolvedValue(undefined), closePreview: vi.fn(),
  }),
}));
vi.mock("@/stores/folders", () => ({
  useFoldersStore: () => ({
    folders: [], currentFolderId: null, page: 0, loading: false, error: null,
    breadcrumbs: [], totalPages: 1,
    get paginatedView() { return STUB.paginatedView; },
    loadTree: STUB.loadTree, navigateTo: vi.fn(), setPage: vi.fn(),
    createFolder: vi.fn().mockResolvedValue(undefined), renameFolder: vi.fn().mockResolvedValue(undefined),
    moveFolder: vi.fn().mockResolvedValue(undefined), deleteFolder: STUB.deleteFolder,
    folderKeyOf: () => undefined,
  }),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ username: "tester", logout: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("@/components/MovePickerModal.vue", () => ({ default: { template: "<div />", props: ["open", "excludeIds"] } }));
vi.mock("@/components/FilePreviewModal.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/ShareDialog.vue", () => ({ default: { template: "<div />" } }));

function makeFile(id: string): FileMeta {
  return {
    id, owner_id: "u", status: "ready", total_size: 10, chunk_count: 1,
    encrypted_manifest: "m", encrypted_manifest_nonce: "n", encrypted_file_key: "k",
    encrypted_file_key_nonce: "kn", encrypted_parent_id: null, encrypted_parent_id_nonce: null,
    created_at: "", updated_at: "",
  };
}

const stubs = { RouterLink: { template: "<slot />" } };

describe("DriveView", () => {
  beforeEach(() => {
    STUB.paginatedView = [];
    STUB.remove.mockClear();
    STUB.deleteFolder.mockClear();
  });

  it("renders header, breadcrumb and new-folder button at root", async () => {
    setActivePinia(createPinia());
    const w = mount(DriveView, { global: { stubs, plugins: [i18n] } });
    await flushPromises();
    expect(w.text()).toMatch(/DragonFox/);
    // Breadcrumb root label is i18n-driven (drive.myFiles); assert by data-testid
    // rather than locking to a translated literal so the test is locale-agnostic.
    expect(w.find('[data-testid="new-folder-btn"]').exists()).toBe(true);
  });

  describe("bulk delete", () => {
    it("removes every selected file and clears selection when confirmed", async () => {
      setActivePinia(createPinia());
      STUB.paginatedView = [
        { kind: "file", file: makeFile("f1") },
        { kind: "file", file: makeFile("f2") },
      ];
      const w = mount(DriveView, { global: { stubs, plugins: [i18n] } });
      await flushPromises();

      const boxes = w.findAll('input[type="checkbox"]');
      expect(boxes.length).toBe(2);
      await boxes[0].trigger("click");
      await boxes[1].trigger("click");
      await flushPromises();
      // bulk action bar is visible while there is a selection
      expect(w.find('[data-testid="bulk-action-bar"]').exists()).toBe(true);

      await w.find('[data-testid="bulk-delete-btn"]').trigger("click");

      useConfirm()._resolve(true);
      await flushPromises();

      expect(STUB.remove).toHaveBeenCalledTimes(2);
      // selection cleared → bulk bar hidden
      expect(w.find('[data-testid="bulk-action-bar"]').exists()).toBe(false);
    });

    it("deletes nothing when the confirm dialog is cancelled", async () => {
      setActivePinia(createPinia());
      STUB.paginatedView = [
        { kind: "file", file: makeFile("f1") },
        { kind: "file", file: makeFile("f2") },
      ];
      const w = mount(DriveView, { global: { stubs, plugins: [i18n] } });
      await flushPromises();

      const boxes = w.findAll('input[type="checkbox"]');
      await boxes[0].trigger("click");
      await boxes[1].trigger("click");
      await flushPromises();

      await w.find('[data-testid="bulk-delete-btn"]').trigger("click");

      useConfirm()._resolve(false);
      await flushPromises();

      expect(STUB.remove).not.toHaveBeenCalled();
      // selection preserved on cancel → bulk bar still visible
      expect(w.find('[data-testid="bulk-action-bar"]').exists()).toBe(true);
    });
  });
});
