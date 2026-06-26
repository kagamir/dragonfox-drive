<script setup lang="ts">
import { computed } from "vue";
import type { FileMeta } from "@/api/types";
import FileTypeIcon from "@/components/FileTypeIcon.vue";
import DfBadge from "@/components/ui/DfBadge.vue";
import DfEmpty from "@/components/ui/DfEmpty.vue";
import DfDropdown, { type DropdownItem } from "@/components/ui/DfDropdown.vue";
import {
  MoreHorizontal, Download, Share2, Pencil, FolderInput, Trash2, FolderOpen,
} from "lucide-vue-next";

type Entry =
  | { kind: "folder"; folder: { id: string; name: string } }
  | { kind: "file"; file: FileMeta };

const props = defineProps<{
  entries: Entry[];
  displayNames: Record<string, string>;
  search: string;
}>();
const emit = defineEmits<{
  openFolder: [string];
  openFile: [FileMeta];
  download: [FileMeta];
  share: [FileMeta];
  renameFolder: [string, string];
  moveFolder: [string];
  moveFile: [string];
  deleteFolder: [string, string];
  deleteFile: [FileMeta];
}>();

function fname(f: FileMeta): string { return props.displayNames[f.id] ?? f.id; }
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
const filtered = computed(() => {
  const q = props.search.trim().toLowerCase();
  if (!q) return props.entries;
  return props.entries.filter((e) =>
    e.kind === "folder" ? e.folder.name.toLowerCase().includes(q) : fname(e.file).toLowerCase().includes(q),
  );
});
function statusVariant(s: string) {
  return s === "ready" ? "ok" : s === "uploading" || s === "pending" ? "proc" : "neutral";
}
function statusLabel(s: string) {
  return ({ ready: "就绪", uploading: "上传中", pending: "等待" } as Record<string, string>)[s] ?? s;
}
function menuFor(e: Entry): DropdownItem[] {
  if (e.kind === "folder") {
    return [
      { label: "重命名", icon: Pencil, onClick: () => emit("renameFolder", e.folder.id, e.folder.name) },
      { label: "移动", icon: FolderInput, onClick: () => emit("moveFolder", e.folder.id) },
      { label: "删除", icon: Trash2, danger: true, onClick: () => emit("deleteFolder", e.folder.id, e.folder.name) },
    ];
  }
  return [
    { label: "打开", icon: FolderOpen, onClick: () => emit("openFile", e.file), disabled: e.file.status !== "ready" },
    { label: "下载", icon: Download, onClick: () => emit("download", e.file), disabled: e.file.status !== "ready" },
    { label: "分享", icon: Share2, onClick: () => emit("share", e.file), disabled: e.file.status !== "ready" },
    { label: "移动", icon: FolderInput, onClick: () => emit("moveFile", e.file.id) },
    { label: "删除", icon: Trash2, danger: true, onClick: () => emit("deleteFile", e.file) },
  ];
}
</script>

<template>
  <DfEmpty v-if="!filtered.length" title="这里还很空" description="拖拽文件到此处，或点击上传按钮" />
  <ul v-else class="flex flex-col gap-1">
    <li
      v-for="e in filtered"
      :key="e.kind + (e.kind === 'folder' ? e.folder.id : e.file.id)"
      class="group grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border border-transparent px-3 py-2 transition-colors hover:border-border hover:bg-surface"
    >
      <FileTypeIcon :name="e.kind === 'folder' ? e.folder.name : fname(e.file)" :is-folder="e.kind === 'folder'" />
      <button
        class="min-w-0 truncate text-left text-sm font-medium text-fg hover:text-brand"
        @click="e.kind === 'folder' ? emit('openFolder', e.folder.id) : emit('openFile', e.file)"
      >{{ e.kind === "folder" ? e.folder.name : fname(e.file) }}</button>
      <div class="flex items-center gap-3">
        <template v-if="e.kind === 'file'">
          <span class="hidden text-xs text-fg-muted sm:inline">{{ fmtSize(e.file.total_size) }}</span>
          <DfBadge :variant="statusVariant(e.file.status)">{{ statusLabel(e.file.status) }}</DfBadge>
        </template>
        <span v-else class="text-xs text-fg-muted">文件夹</span>
        <DfDropdown :items="menuFor(e)" align="right">
          <template #trigger>
            <button class="rounded-md p-1 text-fg-muted opacity-0 transition-opacity hover:bg-bg hover:text-fg group-hover:opacity-100">
              <MoreHorizontal class="h-4 w-4" />
            </button>
          </template>
        </DfDropdown>
      </div>
    </li>
  </ul>
</template>
