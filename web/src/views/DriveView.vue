<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "@/stores/auth";
import { useFilesStore } from "@/stores/files";
import { useFoldersStore, FolderModeUnsupportedError, PAGE_SIZE, type FolderMode } from "@/stores/folders";
import { useConfirm } from "@/composables/useConfirm";
import { usePrompt } from "@/composables/usePrompt";
import { useToast } from "@/composables/useToast";
import type { FileMeta } from "@/api/types";
import { ApiError } from "@/api/client";
import { mediaKind } from "@/util/media";
import { canPreview } from "@/crypto/preview";
import AppHeader from "@/components/AppHeader.vue";
import UploadDropzone from "@/components/UploadDropzone.vue";
import UploadQueueDrawer from "@/components/UploadQueueDrawer.vue";
import DownloadQueueDrawer from "@/components/DownloadQueueDrawer.vue";
import FileList from "@/components/FileList.vue";
import { menuFor, parseKey, visibleEntries, type Entry, type MenuHandlers, type SortKey } from "@/components/fileMenu";
import DfBreadcrumbs from "@/components/ui/DfBreadcrumbs.vue";
import DfButton from "@/components/ui/DfButton.vue";
import DfSegmented from "@/components/ui/DfSegmented.vue";
import DfInput from "@/components/ui/DfInput.vue";
import DfSpinner from "@/components/ui/DfSpinner.vue";
import DfContextMenu from "@/components/ui/DfContextMenu.vue";
import FilePreviewModal from "@/components/FilePreviewModal.vue";
import MovePickerModal from "@/components/MovePickerModal.vue";
import ShareDialog from "@/components/ShareDialog.vue";
import { Images, Folder, List, LayoutGrid, FolderPlus, FilePlus, Search } from "lucide-vue-next";

const { t } = useI18n();
const auth = useAuthStore();
const files = useFilesStore();
const folders = useFoldersStore();
const confirm = useConfirm();
const prompt = usePrompt();
const toast = useToast();

const fileInput = ref<HTMLInputElement | null>(null);
const moveTarget = ref<{ kind: "folder" | "file"; id: string } | null>(null);
const bulkMoveSelection = ref<string[]>([]);
const shareTarget = ref<FileMeta | null>(null);
const newTextFileName = ref<string | null>(null);
const view = ref<"list" | "grid">("list");
const search = ref("");
const selection = ref<string[]>([]);
const sortKey = ref<SortKey>("name");
const sortDir = ref<"asc" | "desc">("asc");
const bulkMoving = ref(false);
const ctxMenu = ref<InstanceType<typeof DfContextMenu> | null>(null);
const ctxTarget = ref<Entry | null>(null);

const openingDrive = ref(true);
onMounted(async () => {
  try {
    await folders.loadTree();
    await files.refresh();
  } finally {
    openingDrive.value = false;
  }
});

onBeforeUnmount(() => files.closePreview());

function pickFile() { fileInput.value?.click(); }
async function onFilesChosen(list: File[]) {
  for (const f of list) {
    try { await files.upload(f); } catch { /* store surfaces */ }
  }
  await folders.loadTree();
}
async function onFileChosen(e: Event) {
  const target = e.target as HTMLInputElement;
  if (target.files?.length) await onFilesChosen(Array.from(target.files));
  target.value = "";
}

const photoError = ref("");
function openFile(f: FileMeta) {
  photoError.value = "";
  void files.openPreview(f).catch(() => {});
}
async function closePreview() {
  const photoId = files.preview?.kind === "image" ? files.preview.meta.id : null;
  photoError.value = "";
  files.closePreview();
  if (photoId) {
    await nextTick();
    document.getElementById("drive-file-" + photoId)?.focus();
  }
}
// The list sorts and filters within each page. Traverse the same pages in order
// so the next photo always matches the next eligible cover in the browser.
const photos = computed(() => {
  const items: { file: FileMeta; page: number }[] = [];
  const entries = folders.combinedChildren;
  for (let start = 0; start < entries.length; start += PAGE_SIZE) {
    const page = visibleEntries(entries.slice(start, start + PAGE_SIZE), files.displayNames, search.value, sortKey.value, sortDir.value);
    for (const entry of page) {
      if (entry.kind !== "file") continue;
      const f = entry.file;
      if (f.status === "ready" && canPreview("image", f.total_size) && mediaKind(files.displayMimes[f.id], files.displayNames[f.id]) === "image") {
        items.push({ file: f, page: start / PAGE_SIZE });
      }
    }
  }
  return items;
});
const photoIndex = computed(() => files.preview?.kind === "image"
  ? photos.value.findIndex(({ file }) => file.id === files.preview?.meta.id) : -1);

async function navigatePhoto(direction: -1 | 1) {
  if (photoIndex.value < 0 || files.previewLoading) return;
  const target = photos.value[photoIndex.value + direction];
  if (!target) return;
  const previous = files.preview;
  photoError.value = "";
  await files.openPreview(target.file);
  if (files.preview?.meta.id === target.file.id) {
    if (target.page !== folders.page) folders.setPage(target.page);
  } else if (files.preview === previous && files.error) {
    photoError.value = files.error;
  }
}
function download(f: FileMeta) { void files.download(f).catch(() => {}); }
function share(f: FileMeta) { shareTarget.value = f; }
async function newTextFile() {
  const name = await prompt.prompt({
    message: t("drive.fileName"),
    title: t("drive.newTextFile"),
    confirmText: t("drive.create"),
  });
  if (name) newTextFileName.value = name;
}
async function saveExistingText(text: string): Promise<void> {
  const meta = files.preview?.meta;
  if (!meta) throw new Error("no file is open for preview");
  try {
    await files.saveTextFile(meta.id, text);
    toast.success(t("toast.saved"));
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 409
        ? t("toast.saveConflict")
        : t("toast.saveFailed"),
    );
    throw e; // keep the editor open with the draft
  }
}
async function saveNewText(text: string): Promise<void> {
  const name = newTextFileName.value;
  if (!name) return;
  try {
    const id = await files.createTextFile(name, text);
    newTextFileName.value = null;
    toast.success(t("toast.saved"));
    // Reopen the created file in view mode so the flow continues seamlessly.
    const meta = files.files.find((f) => f.id === id);
    if (meta) void files.openPreview(meta).catch(() => {});
  } catch (e) {
    toast.error(t("toast.saveFailed"));
    throw e;
  }
}
async function removeFile(f: FileMeta) {
  if (await confirm.confirm({ message: t("drive.deleteFile", { name: files.displayNames[f.id] ?? f.id }), danger: true, confirmText: t("common.delete") })) {
    await files.remove(f.id); await folders.loadTree(); toast.success(t("toast.deleted"));
  }
}
async function newFolder() {
  const name = await prompt.prompt({ message: t("drive.folderName"), title: t("drive.createFolderTitle"), placeholder: t("drive.newFolder"), confirmText: t("drive.create") });
  if (name) { await folders.createFolder(name); toast.success(t("toast.created")); }
}
async function renameFolder(id: string, current: string) {
  const name = await prompt.prompt({ message: t("drive.folderName"), title: t("drive.renameTitle"), initial: current, confirmText: t("common.save") });
  if (name && name !== current) { await folders.renameFolder(id, name); toast.success(t("toast.renamed")); }
}
async function renameFile(f: FileMeta) {
  const current = files.displayNames[f.id] ?? f.id;
  const name = await prompt.prompt({
    message: t("drive.fileName"),
    title: t("drive.renameTitle"),
    initial: current,
    confirmText: t("common.save"),
  });
  if (name && name !== current) {
    await files.renameFile(f.id, name);
    toast.success(t("toast.renamed"));
  }
}
function moveFolder(id: string) { moveTarget.value = { kind: "folder", id }; }
function moveFile(id: string) { moveTarget.value = { kind: "file", id }; }
function bulkMove() {
  if (!selection.value.length) return;
  bulkMoveSelection.value = selection.value
    .filter((k) => k.startsWith("folder"))
    .map((k) => k.slice("folder".length));
  bulkMoving.value = true;
}
const moveExcludeIds = computed<string[]>(() => {
  if (bulkMoving.value) return bulkMoveSelection.value;
  if (moveTarget.value && moveTarget.value.kind === "folder") return [moveTarget.value.id];
  return [];
});
async function bulkDelete() {
  if (!selection.value.length) return;
  if (await confirm.confirm({ message: t("drive.deleteBulk", { n: selection.value.length }), danger: true, confirmText: t("common.delete") })) {
    let ok = 0, fail = 0;
    for (const key of [...selection.value]) {
      try {
        const { kind, id } = parseKey(key);
        if (kind === "folder") await folders.deleteFolder(id);
        else await files.remove(id);
        ok++;
      } catch { fail++; }
    }
    selection.value = [];
    if (fail === 0) toast.success(t("toast.deleted"));
    else if (ok === 0) toast.error(t("toast.deleteFailed"));
    else toast.error(t("toast.deletedSome", { ok, fail }));
    await folders.loadTree();
  }
}
async function onMovePicked(dest: string | null) {
  if (bulkMoving.value) {
    bulkMoving.value = false;
    bulkMoveSelection.value = [];
    if (dest === null) return;
    let ok = 0, fail = 0;
    for (const key of [...selection.value]) {
      try {
        const { kind, id } = parseKey(key);
        if (kind === "folder") await folders.moveFolder(id, dest);
        else await files.moveFile(id, dest);
        ok++;
      } catch { fail++; }
    }
    selection.value = [];
    if (fail === 0) toast.success(t("toast.moved"));
    else if (ok === 0) toast.error(t("toast.moveFailed"));
    else toast.error(t("toast.movedSome", { ok, fail }));
    return;
  }
  const tgt = moveTarget.value; moveTarget.value = null;
  if (!tgt) return;
  try {
    if (tgt.kind === "folder") await folders.moveFolder(tgt.id, dest);
    else await files.moveFile(tgt.id, dest);
    toast.success(t("toast.moved"));
  } catch { toast.error(t("toast.moveFailed")); }
}
function cancelMove() {
  moveTarget.value = null;
  bulkMoving.value = false;
  bulkMoveSelection.value = [];
}
function onCtx(e: MouseEvent, entry: Entry) {
  ctxTarget.value = entry;
  ctxMenu.value?.show(e);
}
async function deleteFolder(id: string, name: string) {
  if (await confirm.confirm({ message: t("drive.deleteFolder", { name }), danger: true, confirmText: t("common.delete") })) {
    await folders.deleteFolder(id); toast.success(t("toast.deleted"));
  }
}
const menuHandlers: MenuHandlers = {
  openFolder: (id) => folders.navigateTo(id),
  openFile,
  download,
  share,
  renameFolder,
  renameFile,
  moveFolder,
  moveFile,
  deleteFolder,
  deleteFile: removeFile,
};
const ctxItems = computed(() => (ctxTarget.value ? menuFor(ctxTarget.value, menuHandlers) : []));

const crumbs = computed(() => [
  { id: null as string | null, label: t("drive.myFiles") },
  ...folders.breadcrumbs.map((b: { id: string; name: string }) => ({ id: b.id as string | null, label: b.name })),
]);
const showPrev = computed(() => folders.page > 0);
const showNext = computed(() => folders.page < folders.totalPages - 1);
const gallery = computed(() => folders.effectiveMode === "photos");
const title = computed(() => folders.breadcrumbs.at(-1)?.name ?? t("drive.myFiles"));
const savingMode = ref(false);

watch(() => folders.currentFolderId, () => {
  files.closePreview();
  search.value = "";
  selection.value = [];
});

async function changeFolderMode(event: Event) {
  const id = folders.currentFolderId;
  if (!id || savingMode.value) return;
  const select = event.target as HTMLSelectElement;
  const next = select.value as FolderMode;
  savingMode.value = true;
  try {
    await folders.setFolderMode(id, next);
  } catch (error) {
    toast.error(t(error instanceof FolderModeUnsupportedError ? "gallery.upgradeServer" : "gallery.saveFailed"));
  } finally {
    // A failed save or navigation must leave the control showing the stored value.
    select.value = folders.currentMode;
    savingMode.value = false;
  }
}

const queueUploads = computed(() =>
  files.activeUploads.map((u) => ({ fileId: u.fileId, name: u.file.name, progress: u.progress, phase: u.phase })),
);
</script>

<template>
  <div class="min-h-screen bg-bg">
    <AppHeader :username="auth.username ?? t('common.me')" active="drive" :show-upload="true" @upload="pickFile" />
    <UploadDropzone class="mx-auto w-full max-w-7xl px-4 py-6 md:px-6" @files="onFilesChosen">
      <div class="drive-heading flex-wrap">
        <span class="folder-emblem shrink-0" aria-hidden="true">
          <component :is="gallery ? Images : Folder" class="h-6 w-6" />
        </span>
        <h1 class="min-w-0 flex-1 truncate" :title="title">{{ title }}</h1>
        <label v-if="folders.currentFolderId" class="flex items-center gap-2 text-sm font-medium tracking-normal text-fg-muted">
          {{ t("gallery.folderType") }}
          <select
            data-testid="folder-mode"
            class="rounded-lg border border-border bg-surface px-2 py-1.5 text-fg"
            :value="folders.currentMode"
            :disabled="savingMode"
            @change="changeFolderMode"
          >
            <option value="auto">{{ t("gallery.auto") }}</option>
            <option value="normal">{{ t("gallery.normal") }}</option>
            <option value="photos">{{ t("gallery.photos") }}</option>
          </select>
        </label>
      </div>
      <div class="drive-tools">
        <DfBreadcrumbs :items="crumbs" @navigate="(id) => folders.navigateTo(id)" />
        <DfInput v-model="search" class="drive-search" :aria-label="t('drive.searchHere')" :placeholder="t('drive.searchHere')">
          <template #prefix><Search class="h-4 w-4 text-fg-muted" /></template>
        </DfInput>
        <div class="drive-actions">
          <DfButton variant="ghost" size="sm" data-testid="new-folder-btn" @click="newFolder">
            <template #icon><FolderPlus class="h-4 w-4" /></template>{{ t("drive.newFolder") }}
          </DfButton>
          <DfButton variant="ghost" size="sm" data-testid="new-text-file-btn" @click="newTextFile">
            <template #icon><FilePlus class="h-4 w-4" /></template>{{ t("drive.newTextFile") }}
          </DfButton>
          <DfSegmented v-if="!gallery" v-model="view" :options="[
            { value: 'list', icon: List, ariaLabel: t('gallery.listView') },
            { value: 'grid', icon: LayoutGrid, ariaLabel: t('gallery.gridView') },
          ]" />
        </div>
      </div>

      <p v-if="files.error || folders.error" class="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
        {{ files.error || folders.error }}
      </p>

      <p v-if="!openingDrive && files.unplacedFileCount" role="status" class="mt-4 text-sm text-fg-muted">
        {{ t("drive.unreadableLocations", { n: files.unplacedFileCount }) }}
      </p>

      <div class="mt-4">
        <div v-if="openingDrive || (files.loading && !folders.paginatedView.length)"
          role="status" class="flex items-center justify-center gap-2 py-14 text-sm text-fg-muted">
          <DfSpinner class="size-4 text-brand" />
          {{ t("common.loading") }}
        </div>
        <FileList v-else
          :entries="folders.paginatedView"
          :display-names="files.displayNames"
          :search="search"
          :view="gallery ? 'gallery' : view"
          :selection="selection"
          :sort-key="sortKey"
          :sort-dir="sortDir"
          @open-folder="(id) => folders.navigateTo(id)"
          @open-file="openFile"
          @download="download"
          @share="share"
          @rename-folder="renameFolder"
          @rename-file="renameFile"
          @move-folder="moveFolder"
          @move-file="moveFile"
          @delete-folder="deleteFolder"
          @delete-file="removeFile"
          @update:selection="(s: string[]) => (selection = s)"
          @update:sort-key="(k: SortKey) => (sortKey = k)"
          @update:sort-dir="(d: 'asc' | 'desc') => (sortDir = d)"
          @contextmenu="onCtx"
        />
      </div>

      <div v-if="selection.length" data-testid="bulk-action-bar" class="sticky bottom-4 z-10 mx-auto mt-4 flex w-fit items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 shadow-lg">
        <span class="text-sm text-fg-muted">{{ t("drive.selected", { n: selection.length }) }}</span>
        <DfButton variant="ghost" size="sm" data-testid="bulk-move-btn" @click="bulkMove">{{ t("drive.move") }}</DfButton>
        <DfButton variant="danger" size="sm" data-testid="bulk-delete-btn" @click="bulkDelete">{{ t("common.delete") }}</DfButton>
      </div>

      <nav v-if="!openingDrive && folders.totalPages > 1" class="mt-6 flex items-center gap-3">
        <DfButton variant="ghost" size="sm" data-testid="page-prev" :disabled="!showPrev" @click="folders.setPage(folders.page - 1)">{{ t("drive.prev") }}</DfButton>
        <span class="text-sm text-fg-muted">{{ t("drive.page", { cur: folders.page + 1, total: folders.totalPages }) }}</span>
        <DfButton variant="ghost" size="sm" data-testid="page-next" :disabled="!showNext" @click="folders.setPage(folders.page + 1)">{{ t("drive.next") }}</DfButton>
      </nav>

      <input ref="fileInput" type="file" multiple class="hidden" @change="onFileChosen" />
    </UploadDropzone>

    <UploadQueueDrawer :uploads="queueUploads" @cancel="(id) => files.cancelUpload(id)" />
    <DownloadQueueDrawer :downloads="files.activeDownloads" @cancel="(id) => files.cancelDownload(id)" />

    <FilePreviewModal
      v-if="files.preview"
      :kind="files.preview.kind"
      :url="files.preview.url"
      :preview-blob="files.preview.previewBlob"
      :name="files.preview.name"
      :player="files.preview.player"
      :can-previous="photoIndex > 0"
      :can-next="photoIndex >= 0 && photoIndex < photos.length - 1"
      :navigating="files.previewLoading"
      :navigation-error="photoError"
      @navigate="navigatePhoto"
      :on-save="files.preview.kind === 'text' ? saveExistingText : null"
      @close="closePreview"
      @error="(m: string) => (files.error = m)"
    />
    <FilePreviewModal
      v-if="newTextFileName !== null"
      kind="text"
      url=""
      :name="newTextFileName"
      :start-editing="true"
      :on-save="saveNewText"
      @close="newTextFileName = null"
    />
    <MovePickerModal
      :open="moveTarget !== null || bulkMoving"
      :exclude-ids="moveExcludeIds"
      @pick="onMovePicked"
      @cancel="cancelMove"
    />
    <ShareDialog v-if="shareTarget" :file="shareTarget" @close="shareTarget = null" />
    <DfContextMenu ref="ctxMenu" :items="ctxItems" />
  </div>
</template>
