<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { FileMeta } from "@/api/types";
import FileTypeIcon from "@/components/FileTypeIcon.vue";
import DfBadge from "@/components/ui/DfBadge.vue";
import DfEmpty from "@/components/ui/DfEmpty.vue";
import DfDropdown from "@/components/ui/DfDropdown.vue";
import { MoreHorizontal } from "lucide-vue-next";
import { keyOf, menuFor, type Entry, type MenuHandlers, type SortKey } from "@/components/fileMenu";

const props = withDefaults(defineProps<{
  entries: Entry[];
  displayNames: Record<string, string>;
  search: string;
  view?: "list" | "grid";
  selection?: string[];
  sortKey?: SortKey;
  sortDir?: "asc" | "desc";
}>(), {
  view: "list",
  selection: () => [],
  sortKey: "name",
  sortDir: "asc",
});

const emit = defineEmits<{
  openFolder: [string];
  openFile: [FileMeta];
  download: [FileMeta];
  share: [FileMeta];
  renameFolder: [string, string];
  renameFile: [FileMeta];
  moveFolder: [string];
  moveFile: [string];
  deleteFolder: [string, string];
  deleteFile: [FileMeta];
  "update:selection": [string[]];
  "update:sortKey": [SortKey];
  "update:sortDir": ["asc" | "desc"];
  contextmenu: [MouseEvent, Entry];
}>();

const { t } = useI18n();

const lastSelected = ref<string | null>(null);

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

const sorted = computed(() => {
  const dir = props.sortDir === "asc" ? 1 : -1;
  const arr = [...filtered.value];
  arr.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    if (props.sortKey === "size") {
      const as = a.kind === "folder" ? 0 : a.file.total_size;
      const bs = b.kind === "folder" ? 0 : b.file.total_size;
      return (as - bs) * dir;
    }
    if (props.sortKey === "status") {
      const ra = a.kind === "folder" ? -1 : STATUS_RANK[a.file.status] ?? 9;
      const rb = b.kind === "folder" ? -1 : STATUS_RANK[b.file.status] ?? 9;
      return (ra - rb) * dir;
    }
    const an = a.kind === "folder" ? a.folder.name : fname(a.file);
    const bn = b.kind === "folder" ? b.folder.name : fname(b.file);
    return an.localeCompare(bn) * dir;
  });
  return arr;
});

function statusVariant(s: string) {
  return s === "ready" ? "ok" : s === "uploading" || s === "pending" ? "proc" : "neutral";
}
const STATUS_KEY: Record<string, string> = { ready: "ready", uploading: "uploading", pending: "pending" };
const STATUS_RANK: Record<string, number> = { ready: 0, uploading: 1, pending: 2, deleted: 3 };
function statusLabel(s: string) {
  return t("status." + (STATUS_KEY[s] ?? "pending"));
}

const handlers: MenuHandlers = {
  openFolder: (id) => emit("openFolder", id),
  openFile: (f) => emit("openFile", f),
  download: (f) => emit("download", f),
  share: (f) => emit("share", f),
  renameFolder: (id, name) => emit("renameFolder", id, name),
  renameFile: (f) => emit("renameFile", f),
  moveFolder: (id) => emit("moveFolder", id),
  moveFile: (id) => emit("moveFile", id),
  deleteFolder: (id, name) => emit("deleteFolder", id, name),
  deleteFile: (f) => emit("deleteFile", f),
};
function itemsFor(e: Entry) { return menuFor(e, handlers); }

function toggle(e: Entry, shift: boolean) {
  const k = keyOf(e);
  const next = new Set(props.selection);
  if (shift && lastSelected.value && lastSelected.value !== k) {
    const keys = sorted.value.map(keyOf);
    const a = keys.indexOf(lastSelected.value);
    const b = keys.indexOf(k);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) next.add(keys[i]);
    }
  } else {
    if (next.has(k)) next.delete(k); else next.add(k);
  }
  lastSelected.value = k;
  emit("update:selection", [...next]);
}

function onSort(k: SortKey) {
  if (props.sortKey === k) {
    emit("update:sortDir", props.sortDir === "asc" ? "desc" : "asc");
  } else {
    emit("update:sortKey", k);
  }
}

function onContextmenu(ev: MouseEvent, e: Entry) {
  emit("contextmenu", ev, e);
}
</script>

<template>
  <DfEmpty v-if="!sorted.length" :title="t('drive.empty')" :description="t('drive.emptyDesc')" />
  <template v-else>
    <div v-if="view === 'grid'" class="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      <button
        v-for="e in sorted"
        :key="keyOf(e)"
        class="flex flex-col items-center gap-2 rounded-xl border border-border bg-surface p-4 text-center transition-colors hover:border-brand"
        @click="e.kind === 'folder' ? emit('openFolder', e.folder.id) : emit('openFile', e.file)"
        @contextmenu="onContextmenu($event, e)"
      >
        <FileTypeIcon :name="e.kind === 'folder' ? e.folder.name : fname(e.file)" :is-folder="e.kind === 'folder'" />
        <span class="w-full truncate text-xs font-medium text-fg">{{ e.kind === "folder" ? e.folder.name : fname(e.file) }}</span>
        <span v-if="e.kind === 'file'" class="text-[10px] text-fg-muted">{{ fmtSize(e.file.total_size) }}</span>
      </button>
    </div>

    <template v-else>
      <div class="grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 border-b border-border px-3 pb-2 text-xs font-medium text-fg-muted">
        <span class="w-4" />
        <button class="flex items-center gap-1 hover:text-fg" @click="onSort('name')">
          {{ t("drive.name") }}
          <span v-if="sortKey === 'name'">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
        </button>
        <button class="hidden items-center gap-1 hover:text-fg sm:flex" @click="onSort('size')">
          {{ t("drive.size") }}
          <span v-if="sortKey === 'size'">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
        </button>
        <button class="flex items-center gap-1 justify-self-end hover:text-fg" @click="onSort('status')">
          {{ t("drive.status") }}
          <span v-if="sortKey === 'status'">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
        </button>
        <span class="w-8" />
      </div>

      <ul class="flex flex-col gap-1">
        <li
          v-for="e in sorted"
          :key="keyOf(e)"
          class="group grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-3 rounded-lg border border-transparent px-3 py-2 transition-colors hover:border-border hover:bg-surface"
          @contextmenu="onContextmenu($event, e)"
        >
          <input type="checkbox" class="accent-brand"
            :checked="selection.includes(keyOf(e))"
            @click.stop="toggle(e, $event.shiftKey)" />
          <div class="flex min-w-0 items-center gap-3">
            <FileTypeIcon :name="e.kind === 'folder' ? e.folder.name : fname(e.file)" :is-folder="e.kind === 'folder'" />
            <button
              class="min-w-0 truncate text-left text-sm font-medium text-fg hover:text-brand"
              @click="e.kind === 'folder' ? emit('openFolder', e.folder.id) : emit('openFile', e.file)"
            >{{ e.kind === "folder" ? e.folder.name : fname(e.file) }}</button>
          </div>
          <span v-if="e.kind === 'file'" class="hidden text-xs text-fg-muted sm:block">{{ fmtSize(e.file.total_size) }}</span>
          <span v-else class="hidden text-xs text-fg-muted sm:block"></span>
          <div class="flex items-center justify-end">
            <DfBadge v-if="e.kind === 'file'" :variant="statusVariant(e.file.status)">{{ statusLabel(e.file.status) }}</DfBadge>
            <span v-else class="text-xs text-fg-muted">{{ t("drive.folder") }}</span>
          </div>
          <DfDropdown :items="itemsFor(e)" align="right">
            <template #trigger>
              <button class="rounded-md p-1 text-fg-muted opacity-0 transition-opacity hover:bg-bg hover:text-fg group-hover:opacity-100">
                <MoreHorizontal class="h-4 w-4" />
              </button>
            </template>
          </DfDropdown>
        </li>
      </ul>
    </template>
  </template>
</template>
