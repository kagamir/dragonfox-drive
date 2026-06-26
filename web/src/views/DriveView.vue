<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "@/stores/auth";
import { useFilesStore } from "@/stores/files";
import { useFoldersStore } from "@/stores/folders";
import { useConfirm } from "@/composables/useConfirm";
import { usePrompt } from "@/composables/usePrompt";
import { useToast } from "@/composables/useToast";
import type { FileMeta } from "@/api/types";
import AppHeader from "@/components/AppHeader.vue";
import UploadDropzone from "@/components/UploadDropzone.vue";
import UploadQueueDrawer from "@/components/UploadQueueDrawer.vue";
import DownloadQueueDrawer from "@/components/DownloadQueueDrawer.vue";
import FileList from "@/components/FileList.vue";
import { menuFor, parseKey, type Entry, type MenuHandlers, type SortKey } from "@/components/fileMenu";
import DfBreadcrumbs from "@/components/ui/DfBreadcrumbs.vue";
import DfButton from "@/components/ui/DfButton.vue";
import DfSegmented from "@/components/ui/DfSegmented.vue";
import DfInput from "@/components/ui/DfInput.vue";
import DfContextMenu from "@/components/ui/DfContextMenu.vue";
import FilePreviewModal from "@/components/FilePreviewModal.vue";
import MovePickerModal from "@/components/MovePickerModal.vue";
import ShareDialog from "@/components/ShareDialog.vue";
import { List, LayoutGrid, FolderPlus, Search } from "lucide-vue-next";

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
const view = ref<"list" | "grid">("list");
const search = ref("");
const selection = ref<string[]>([]);
const sortKey = ref<SortKey>("name");
const sortDir = ref<"asc" | "desc">("asc");
const bulkMoving = ref(false);
const ctxMenu = ref<InstanceType<typeof DfContextMenu> | null>(null);
const ctxTarget = ref<Entry | null>(null);

onMounted(async () => { await folders.loadTree(); await files.refresh(); });

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

function openFile(f: FileMeta) { void files.openPreview(f).catch(() => {}); }
function download(f: FileMeta) { void files.download(f).catch(() => {}); }
function share(f: FileMeta) { shareTarget.value = f; }
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
const queueUploads = computed(() =>
  files.activeUploads.map((u) => ({ fileId: u.fileId, name: u.file.name, progress: u.progress, phase: u.phase })),
);
</script>

<template>
  <div class="min-h-screen bg-bg">
    <AppHeader :username="auth.username ?? t('common.me')" active="drive" :show-upload="true" @upload="pickFile" />
    <UploadDropzone class="mx-auto w-full max-w-7xl px-4 py-6 md:px-6" @files="onFilesChosen">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <DfBreadcrumbs :items="crumbs" @navigate="(id) => folders.navigateTo(id)" />
        <DfInput v-model="search" class="min-w-[14rem] flex-1 sm:max-w-xs" :placeholder="t('drive.searchHere')">
          <template #prefix><Search class="h-4 w-4 text-fg-muted" /></template>
        </DfInput>
        <div class="flex items-center gap-2">
          <DfButton variant="ghost" size="sm" data-testid="new-folder-btn" @click="newFolder">
            <template #icon><FolderPlus class="h-4 w-4" /></template>{{ t("drive.newFolder") }}
          </DfButton>
          <DfSegmented v-model="view" :options="[{ value: 'list', icon: List }, { value: 'grid', icon: LayoutGrid }]" />
        </div>
      </div>

      <p v-if="files.error || folders.error" class="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
        {{ files.error || folders.error }}
      </p>

      <div class="mt-4">
        <FileList
          :entries="folders.paginatedView"
          :display-names="files.displayNames"
          :search="search"
          :view="view"
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

      <nav v-if="folders.totalPages > 1" class="mt-6 flex items-center gap-3">
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
      :name="files.preview.name"
      :player="files.preview.player"
      @close="files.closePreview()"
      @error="(m: string) => (files.error = m)"
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
