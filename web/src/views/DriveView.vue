<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
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
  const t = e.target as HTMLInputElement;
  if (t.files?.length) await onFilesChosen(Array.from(t.files));
  t.value = "";
}

function openFile(f: FileMeta) { void files.openPreview(f).catch(() => {}); }
function download(f: FileMeta) { void files.download(f).catch(() => {}); }
function share(f: FileMeta) { shareTarget.value = f; }
async function removeFile(f: FileMeta) {
  if (await confirm.confirm({ message: `删除 “${files.displayNames[f.id] ?? f.id}”？`, danger: true, confirmText: "删除" })) {
    await files.remove(f.id); await folders.loadTree(); toast.success("已删除");
  }
}
async function newFolder() {
  const name = await prompt.prompt({ message: "文件夹名称", title: "新建文件夹", placeholder: "新建文件夹", confirmText: "创建" });
  if (name) { await folders.createFolder(name); toast.success("已创建"); }
}
async function renameFolder(id: string, current: string) {
  const name = await prompt.prompt({ message: "文件夹名称", title: "重命名", initial: current, confirmText: "保存" });
  if (name && name !== current) { await folders.renameFolder(id, name); toast.success("已重命名"); }
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
  if (await confirm.confirm({ message: `删除选中的 ${selection.value.length} 项？此操作无法撤销。`, danger: true, confirmText: "删除" })) {
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
    if (fail === 0) toast.success("已删除");
    else if (ok === 0) toast.error("删除失败，请重试");
    else toast.error(`已删除 ${ok} 项，${fail} 项失败`);
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
    if (fail === 0) toast.success("已移动");
    else if (ok === 0) toast.error("移动失败，请重试");
    else toast.error(`已移动 ${ok} 项，${fail} 项失败`);
    return;
  }
  const t = moveTarget.value; moveTarget.value = null;
  if (!t) return;
  try {
    if (t.kind === "folder") await folders.moveFolder(t.id, dest);
    else await files.moveFile(t.id, dest);
    toast.success("已移动");
  } catch { toast.error("移动失败，请重试"); }
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
  if (await confirm.confirm({ message: `删除 “${name}” 及其所有内容？此操作无法撤销。`, danger: true, confirmText: "删除" })) {
    await folders.deleteFolder(id); toast.success("已删除");
  }
}
const menuHandlers: MenuHandlers = {
  openFolder: (id) => folders.navigateTo(id),
  openFile,
  download,
  share,
  renameFolder,
  moveFolder,
  moveFile,
  deleteFolder,
  deleteFile: removeFile,
};
const ctxItems = computed(() => (ctxTarget.value ? menuFor(ctxTarget.value, menuHandlers) : []));

const crumbs = computed(() => [
  { id: null as string | null, label: "Drive" },
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
    <AppHeader :username="auth.username ?? '我'" active="drive" :show-upload="true" @upload="pickFile" />
    <UploadDropzone class="mx-auto w-full max-w-7xl px-4 py-6 md:px-6" @files="onFilesChosen">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <DfBreadcrumbs :items="crumbs" @navigate="(id) => folders.navigateTo(id)" />
        <DfInput v-model="search" class="min-w-[14rem] flex-1 sm:max-w-xs" placeholder="搜索当前文件夹…">
          <template #prefix><Search class="h-4 w-4 text-fg-muted" /></template>
        </DfInput>
        <div class="flex items-center gap-2">
          <DfButton variant="ghost" size="sm" @click="newFolder">
            <template #icon><FolderPlus class="h-4 w-4" /></template>新建文件夹
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

      <div v-if="selection.length" class="sticky bottom-4 z-10 mx-auto mt-4 flex w-fit items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 shadow-lg">
        <span class="text-sm text-fg-muted">已选 {{ selection.length }} 项</span>
        <DfButton variant="ghost" size="sm" @click="bulkMove">移动</DfButton>
        <DfButton variant="danger" size="sm" @click="bulkDelete">删除</DfButton>
      </div>

      <nav v-if="folders.totalPages > 1" class="mt-6 flex items-center gap-3">
        <DfButton variant="ghost" size="sm" :disabled="!showPrev" @click="folders.setPage(folders.page - 1)">上一页</DfButton>
        <span class="text-sm text-fg-muted">第 {{ folders.page + 1 }} / {{ folders.totalPages }} 页</span>
        <DfButton variant="ghost" size="sm" :disabled="!showNext" @click="folders.setPage(folders.page + 1)">下一页</DfButton>
      </nav>

      <input ref="fileInput" type="file" multiple class="hidden" @change="onFileChosen" />
    </UploadDropzone>

    <UploadQueueDrawer :uploads="queueUploads" @cancel="(id) => files.cancelUpload(id)" />

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
