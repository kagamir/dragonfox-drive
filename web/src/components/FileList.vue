<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { FileMeta } from "@/api/types";
import FileThumbnail from "@/components/FileThumbnail.vue";
import FileTypeIcon from "@/components/FileTypeIcon.vue";
import DfBadge from "@/components/ui/DfBadge.vue";
import DfEmpty from "@/components/ui/DfEmpty.vue";
import DfDropdown from "@/components/ui/DfDropdown.vue";
import { MoreHorizontal } from "lucide-vue-next";
import { keyOf, menuFor, visibleEntries, type Entry, type MenuHandlers, type SortKey } from "@/components/fileMenu";

const props = withDefaults(defineProps<{
  entries: Entry[];
  displayNames: Record<string, string>;
  search: string;
  view?: "list" | "grid" | "gallery";
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
function entryName(e: Entry) { return e.kind === "folder" ? e.folder.name : fname(e.file); }
function openEntry(e: Entry) {
  if (e.kind === "folder") emit("openFolder", e.folder.id);
  else emit("openFile", e.file);
}
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const sorted = computed(() => visibleEntries(props.entries, props.displayNames, props.search, props.sortKey, props.sortDir));

function statusVariant(s: string) {
  return s === "ready" ? "ok" : s === "uploading" || s === "pending" ? "proc" : "neutral";
}
const STATUS_KEY: Record<string, string> = { ready: "ready", uploading: "uploading", pending: "pending" };
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
    <div
      v-if="view !== 'list'"
      :class="view === 'gallery'
        ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5'
        : 'grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'"
      :data-view="view"
    >
      <div
        v-for="e in sorted"
        :key="keyOf(e)"
        class="relative min-w-0 rounded-xl border bg-surface transition-colors hover:border-brand"
        :class="[selection.includes(keyOf(e)) ? 'border-brand ring-1 ring-brand' : 'border-border',
          { 'gallery-tile': view === 'gallery' }]"
        @contextmenu="onContextmenu($event, e)"
      >
        <button
          type="button"
          class="flex w-full flex-col items-center rounded-xl text-fg"
          :class="view === 'grid' ? 'gap-2 p-4 pt-9' : 'text-left'"
          :disabled="e.kind === 'file' && e.file.status !== 'ready'"
          :id="e.kind === 'file' ? 'drive-file-' + e.file.id : undefined"
          :aria-label="entryName(e)"
          :title="entryName(e)"
          @click="openEntry(e)"
        >
          <template v-if="view === 'gallery'">
            <FileThumbnail v-if="e.kind === 'file'" :file="e.file" :name="fname(e.file)"
              class="gallery-cover aspect-[4/3] w-full rounded-t-xl bg-bg" />
            <span v-else class="gallery-cover flex aspect-[4/3] w-full items-center justify-center rounded-t-xl bg-brand-soft">
              <FileTypeIcon :name="e.folder.name" is-folder />
            </span>
          </template>
          <FileTypeIcon v-else :name="entryName(e)" :is-folder="e.kind === 'folder'" />
          <span class="block w-full min-w-0" :class="view === 'gallery' ? 'px-3 py-2' : 'text-center'">
            <span class="block truncate text-sm font-medium">{{ entryName(e) }}</span>
            <span class="block truncate text-xs text-fg-muted">
              {{ e.kind === 'folder' ? t('drive.folder') : e.file.status === 'ready' ? fmtSize(e.file.total_size) : statusLabel(e.file.status) }}
            </span>
          </span>
        </button>
        <label class="cover-control absolute start-1.5 top-1.5 grid size-7 cursor-pointer place-items-center rounded-md bg-surface/95">
          <input type="checkbox" class="accent-brand"
            :aria-label="t('gallery.selectItem', { name: entryName(e) })"
            :checked="selection.includes(keyOf(e))"
            @click.stop="toggle(e, $event.shiftKey)" />
        </label>
        <div class="cover-control absolute end-1.5 top-1.5">
          <DfDropdown :items="itemsFor(e)" align="right">
            <template #trigger>
              <button class="grid size-7 place-items-center rounded-md bg-surface/95 text-fg hover:bg-bg"
                :aria-label="t('gallery.actions', { name: entryName(e) })">
                <MoreHorizontal class="h-4 w-4" />
              </button>
            </template>
          </DfDropdown>
        </div>
      </div>
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
              :id="e.kind === 'file' ? 'drive-file-' + e.file.id : undefined"
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

<style scoped>
@media (hover: hover) and (pointer: fine) {
  .gallery-tile:not(:has(.gallery-cover:hover, .cover-control:hover, :focus-visible, [aria-expanded="true"])) .cover-control {
    opacity: 0;
    pointer-events: none;
  }
}
</style>
