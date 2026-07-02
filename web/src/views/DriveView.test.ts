import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DriveView from "./DriveView.vue";
import { useConfirm } from "@/composables/useConfirm";
import { usePrompt } from "@/composables/usePrompt";
import { i18n } from "@/locales";
import type { FileMeta } from "@/api/types";
import { ApiError } from "@/api/client";

// Mutable, per-test-controllable stub state. vi.hoisted makes `STUB` available
// to the vi.mock factories below (which run at module load) and to each test.
const STUB = vi.hoisted(() => ({
  paginatedView: [] as Array<{ kind: "folder" | "file"; folder?: { id: string; name: string }; file?: FileMeta }>,
  files: [] as FileMeta[],
  preview: null as { meta: FileMeta; url: string; kind: string; name: string; player?: unknown } | null,
  remove: vi.fn().mockResolvedValue(undefined),
  deleteFolder: vi.fn().mockResolvedValue(undefined),
  loadTree: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn().mockResolvedValue(undefined),
  saveTextFile: vi.fn().mockResolvedValue(undefined),
  createTextFile: vi.fn().mockResolvedValue("new-id"),
  openPreview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/workers/crypto", () => ({ cryptoApi: {}, ensureCryptoReady: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/api/files", () => ({ filesApi: {} }));
vi.mock("@/api/folders", () => ({ foldersApi: {} }));

vi.mock("@/stores/files", () => ({
  useFilesStore: () => ({
    get files() { return STUB.files; },
    loading: false, error: null, uploading: false, uploadProgress: 0,
    downloading: false, displayNames: {} as Record<string, string>, activeUploads: [],
    activeDownloads: [] as { fileId: string; name: string; progress: number; phase: string }[],
    fileParents: {},
    get preview() { return STUB.preview; },
    refresh: STUB.refresh, upload: vi.fn().mockResolvedValue(undefined),
    cancelUpload: vi.fn(), cancelDownload: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
    remove: STUB.remove, filesWithParent: () => [], moveFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
    saveTextFile: STUB.saveTextFile, createTextFile: STUB.createTextFile,
    unlockFile: vi.fn(), openPreview: STUB.openPreview, closePreview: vi.fn(),
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
vi.mock("@/components/FilePreviewModal.vue", () => ({
  default: {
    name: "FilePreviewModal", // findComponent({ name }) 依赖它
    template: "<div data-testid='preview-modal-stub' />",
    props: ["kind", "url", "name", "player", "onSave", "startEditing"],
  },
}));
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
    STUB.files = [];
    STUB.preview = null;
    STUB.remove.mockClear();
    STUB.deleteFolder.mockClear();
    STUB.saveTextFile.mockClear();
    STUB.saveTextFile.mockResolvedValue(undefined);
    STUB.createTextFile.mockClear();
    STUB.createTextFile.mockResolvedValue("new-id");
    STUB.openPreview.mockClear();
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

  it("new-text-file button prompts for a name and opens the editor modal", async () => {
    setActivePinia(createPinia());
    const w = mount(DriveView, { global: { stubs, plugins: [i18n] } });
    await flushPromises();
    await w.find('[data-testid="new-text-file-btn"]').trigger("click");
    await flushPromises();
    // usePrompt renders through global state; resolve it by driving the
    // composable directly (same pattern as the rename tests).
    const prompt = usePrompt();
    expect(prompt.state.value.open).toBe(true);
    prompt._submit("notes.txt");
    await flushPromises();
    const modal = w.findComponent({ name: "FilePreviewModal" });
    expect(modal.exists()).toBe(true);
    expect(modal.props("startEditing")).toBe(true);
    expect(modal.props("name")).toBe("notes.txt");
  });

  it("the new-file editor's onSave creates the file", async () => {
    setActivePinia(createPinia());
    const w = mount(DriveView, { global: { stubs, plugins: [i18n] } });
    await flushPromises();
    await w.find('[data-testid="new-text-file-btn"]').trigger("click");
    const prompt = usePrompt();
    prompt._submit("notes.txt");
    await flushPromises();
    const modal = w.findComponent({ name: "FilePreviewModal" });
    const onSave = modal.props("onSave") as (t: string) => Promise<void>;
    await onSave("hello");
    expect(STUB.createTextFile).toHaveBeenCalledWith("notes.txt", "hello");
  });

  it("a successful new-file save opens the created file in preview mode", async () => {
    setActivePinia(createPinia());
    // The store's `files` list must already contain the row saveNewText looks
    // up by the id createTextFile resolved with ("new-id" per the stub).
    STUB.files = [makeFile("new-id")];
    const w = mount(DriveView, { global: { stubs, plugins: [i18n] } });
    await flushPromises();
    await w.find('[data-testid="new-text-file-btn"]').trigger("click");
    const prompt = usePrompt();
    prompt._submit("notes.txt");
    await flushPromises();
    const modal = w.findComponent({ name: "FilePreviewModal" });
    const onSave = modal.props("onSave") as (t: string) => Promise<void>;
    await onSave("hello");
    expect(STUB.createTextFile).toHaveBeenCalledWith("notes.txt", "hello");
    expect(STUB.openPreview).toHaveBeenCalledWith(
      expect.objectContaining({ id: "new-id" }),
    );
  });

  describe("existing-file save via the preview editor", () => {
    function openPreviewFor(id: string) {
      STUB.preview = { meta: makeFile(id), url: "", kind: "text", name: id };
    }

    it("rethrows a 409 conflict from saveTextFile (onSave rejects)", async () => {
      setActivePinia(createPinia());
      openPreviewFor("f1");
      STUB.saveTextFile.mockRejectedValueOnce(new ApiError("conflict", 409));
      const w = mount(DriveView, { global: { stubs, plugins: [i18n] } });
      await flushPromises();
      const modal = w.findComponent({ name: "FilePreviewModal" });
      const onSave = modal.props("onSave") as (t: string) => Promise<void>;
      await expect(onSave("hello")).rejects.toMatchObject({ status: 409 });
      expect(STUB.saveTextFile).toHaveBeenCalledWith("f1", "hello");
    });

    it("rethrows a generic failure from saveTextFile (onSave rejects)", async () => {
      setActivePinia(createPinia());
      openPreviewFor("f1");
      STUB.saveTextFile.mockRejectedValueOnce(new Error("network boom"));
      const w = mount(DriveView, { global: { stubs, plugins: [i18n] } });
      await flushPromises();
      const modal = w.findComponent({ name: "FilePreviewModal" });
      const onSave = modal.props("onSave") as (t: string) => Promise<void>;
      await expect(onSave("hello")).rejects.toThrow("network boom");
    });
  });
});
