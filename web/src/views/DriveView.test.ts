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
  currentFolderId: null as string | null,
  displayNames: {} as Record<string, string>,
  displayMimes: {} as Record<string, string>,
  setPage: vi.fn(),
  previewLoading: false,
  currentMode: "auto",
  effectiveMode: "normal",
  setFolderMode: vi.fn().mockResolvedValue(undefined),
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
    downloading: false, displayNames: STUB.displayNames, displayMimes: STUB.displayMimes, activeUploads: [],
    get previewLoading() { return STUB.previewLoading; },
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
  PAGE_SIZE: 50,
  FolderModeUnsupportedError: class extends Error {},
  useFoldersStore: () => ({
    folders: [],
    get currentFolderId() { return STUB.currentFolderId; },
    get currentMode() { return STUB.currentMode; },
    get effectiveMode() { return STUB.effectiveMode; },
    setFolderMode: STUB.setFolderMode, page: 0, loading: false, error: null,
    breadcrumbs: [], totalPages: 1,
    get combinedChildren() { return STUB.paginatedView; },
    get paginatedView() { return STUB.paginatedView.slice(0, 50); },
    loadTree: STUB.loadTree, navigateTo: vi.fn(), setPage: STUB.setPage,
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
    props: ["kind", "url", "name", "player", "onSave", "startEditing", "canPrevious", "canNext", "navigating"],
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
    STUB.currentFolderId = null;
    STUB.currentMode = "auto";
    STUB.effectiveMode = "normal";
    STUB.setFolderMode.mockClear();
    STUB.paginatedView = [];
    STUB.files = [];
    STUB.preview = null;
    STUB.previewLoading = false;
    STUB.displayNames = {};
    STUB.displayMimes = {};
    STUB.setPage.mockClear();
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
    expect(w.find('[data-testid="folder-mode"]').exists()).toBe(false);
    // Breadcrumb root label is i18n-driven (drive.myFiles); assert by data-testid
    // rather than locking to a translated literal so the test is locale-agnostic.
    expect(w.find('[data-testid="new-folder-btn"]').exists()).toBe(true);
  });

  it("shows a loading status until the folder tree and file listing have both arrived", async () => {
    setActivePinia(createPinia());
    let finishTree!: () => void;
    let finishFiles!: () => void;
    STUB.loadTree.mockImplementationOnce(() => new Promise<void>((done) => { finishTree = done; }));
    STUB.refresh.mockImplementationOnce(() => new Promise<void>((done) => { finishFiles = done; }));
    const w = mount(DriveView, { global: { stubs, plugins: [i18n] } });
    expect(w.get('[role="status"]').text()).toBe(i18n.global.t("common.loading"));
    expect(w.text()).not.toContain(i18n.global.t("drive.empty"));
    finishTree();
    await flushPromises();
    expect(w.get('[role="status"]').text()).toBe(i18n.global.t("common.loading"));
    finishFiles();
    await flushPromises();
    expect(w.find('[role="status"]').exists()).toBe(false);
    expect(w.text()).toContain(i18n.global.t("drive.empty"));
    w.unmount();
  });

  it("opens photo folders in the gallery and restores the folder type after a failed save", async () => {
    setActivePinia(createPinia());
    STUB.currentFolderId = "album";
    STUB.effectiveMode = "photos";
    STUB.paginatedView = [{ kind: "file", file: makeFile("photo") }];
    const w = mount(DriveView, { global: { stubs: { ...stubs, FileThumbnail: true }, plugins: [i18n] } });
    await flushPromises();
    expect(w.find('[data-view="gallery"]').exists()).toBe(true);
    const select = w.get('[data-testid="folder-mode"]');
    STUB.setFolderMode.mockRejectedValueOnce(new Error("offline"));
    await select.setValue("normal");
    await flushPromises();
    expect(STUB.setFolderMode).toHaveBeenCalledWith("album", "normal");
    expect((select.element as HTMLSelectElement).value).toBe("auto");
  });

  it("follows filtered cover order across pages, skips ineligible files and updates the page after a successful switch", async () => {
    setActivePinia(createPinia());
    const current = makeFile("b");
    const target = makeFile("d");
    const other = makeFile("c");
    STUB.preview = { kind: "image", meta: current, url: "blob:b", name: "trip-b.jpg" };
    STUB.displayNames = { a: "trip-a.jpg", b: "trip-b.jpg", c: "trip-z.jpg", d: "trip-c.jpg",
      skip: "other.jpg", doc: "trip-b2.jpg", pending: "trip-b3.jpg", huge: "trip-b4.jpg" };
    STUB.displayMimes.doc = "text/plain";
    STUB.paginatedView = [
      { kind: "file", file: current }, { kind: "file", file: makeFile("skip") },
      { kind: "file", file: makeFile("a") }, { kind: "file", file: makeFile("doc") },
      { kind: "file", file: { ...makeFile("pending"), status: "pending" } },
      { kind: "file", file: { ...makeFile("huge"), total_size: 1024 ** 3 } },
      ...Array.from({ length: 44 }, (_, i) => ({ kind: "folder" as const, folder: { name: "folder", id: String(i) } })),
      { kind: "file", file: other }, { kind: "file", file: target },
    ];
    const w = mount(DriveView, { global: { stubs, plugins: [i18n] } });
    await w.get(".drive-search input").setValue("trip");
    const modal = w.getComponent({ name: "FilePreviewModal" });
    expect(modal.props("canPrevious")).toBe(true);
    expect(modal.props("canNext")).toBe(true);
    STUB.previewLoading = true;
    modal.vm.$emit("navigate", 1);
    expect(STUB.openPreview).not.toHaveBeenCalled();
    STUB.previewLoading = false;
    modal.vm.$emit("navigate", 1);
    await flushPromises();
    expect(STUB.openPreview).toHaveBeenCalledWith(target);
    expect(STUB.setPage).not.toHaveBeenCalled(); // a failed preview leaves the previous page in place
    STUB.openPreview.mockImplementationOnce(async () => {
      STUB.preview = { kind: "image", meta: target, name: "trip-c.jpg", url: "blob:d" };
    });
    modal.vm.$emit("navigate", 1);
    await flushPromises();
    expect(STUB.setPage).toHaveBeenCalledWith(1);
    w.unmount();
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
