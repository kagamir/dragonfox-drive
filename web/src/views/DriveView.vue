<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useFilesStore } from "@/stores/files";
import { useFoldersStore } from "@/stores/folders";
import type { FileMeta } from "@/api/types";
import FilePreviewModal from "@/components/FilePreviewModal.vue";
import MovePickerModal from "@/components/MovePickerModal.vue";

const auth = useAuthStore();
const files = useFilesStore();
const folders = useFoldersStore();
const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);

// Move-picker state: kind + id of the item being moved.
const moveTarget = ref<{ kind: "folder" | "file"; id: string } | null>(null);

onMounted(async () => {
  await folders.loadTree();
  await files.refresh();
});

function signOut() {
  void auth.logout().then(() => router.push({ name: "login" }));
}

function pickFile() {
  fileInput.value?.click();
}

async function onFileChosen(e: Event) {
  const target = e.target as HTMLInputElement;
  const f = target.files?.[0];
  if (!f) return;
  try {
    await files.upload(f);
    await folders.loadTree();
  } catch {
    /* error surfaced in store */
  } finally {
    target.value = "";
  }
}

function onDrop(e: DragEvent) {
  dragOver.value = false;
  const f = e.dataTransfer?.files[0];
  if (f) void files.upload(f).then(() => folders.loadTree()).catch(() => {});
}
function onDragOver() {
  dragOver.value = true;
}
function onDragLeave() {
  dragOver.value = false;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function fileName(f: FileMeta): string {
  return files.displayNames[f.id] ?? f.id;
}

function previewable(f: FileMeta): boolean {
  return f.status === "ready";
}

function open(f: FileMeta) {
  void files.openPreview(f).catch(() => {});
}
function download(f: FileMeta) {
  void files.download(f).catch(() => {});
}
function remove(f: FileMeta) {
  if (confirm(`Delete "${fileName(f)}"?`)) void files.remove(f.id).then(() => folders.loadTree());
}

// --- folder actions ------------------------------------------------------

function newFolder() {
  const name = prompt("Folder name");
  if (name) void folders.createFolder(name);
}

function openFolder(id: string) {
  folders.navigateTo(id);
}

function crumbTo(id: string | null) {
  folders.navigateTo(id);
}

function renameFolder(id: string, current: string) {
  const name = prompt("Rename folder", current);
  if (name) void folders.renameFolder(id, name);
}

function moveFolder(id: string) {
  moveTarget.value = { kind: "folder", id };
}

function moveFile(id: string) {
  moveTarget.value = { kind: "file", id };
}

function removeFolder(id: string, name: string) {
  if (confirm(`Delete "${name}" and everything inside it? This cannot be undone.`)) {
    void folders.deleteFolder(id);
  }
}

async function onMovePicked(dest: string | null) {
  const t = moveTarget.value;
  moveTarget.value = null;
  if (!t) return;
  try {
    if (t.kind === "folder") await folders.moveFolder(t.id, dest);
    else await files.moveFile(t.id, dest);
  } catch {
    /* error surfaced in store */
  }
}

const showPrevPage = computed(() => folders.page > 0);
const showNextPage = computed(() => folders.page < folders.totalPages - 1);
</script>

<template>
  <main class="page">
    <header class="bar">
      <div class="brand"><span class="logo">DragonFox Drive</span></div>
      <nav>
        <RouterLink :to="{ name: 'drive' }">My files</RouterLink>
        <RouterLink :to="{ name: 'settings' }">Settings</RouterLink>
        <button class="link" @click="signOut">Sign out</button>
      </nav>
    </header>

    <section class="content">
      <nav class="breadcrumbs">
        <a class="link crumb" @click="crumbTo(null)">Drive</a>
        <template v-for="b in folders.breadcrumbs" :key="b.id">
          <span class="sep">/</span>
          <a class="link crumb" @click="crumbTo(b.id)">{{ b.name }}</a>
        </template>
      </nav>

      <div class="toolbar">
        <button class="link" @click="newFolder">New folder</button>
      </div>

      <div
        class="dropzone"
        :class="{ over: dragOver }"
        @click="pickFile"
        @dragover.prevent="onDragOver"
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
      >
        <p v-if="!files.uploading">Drop a file here or click to choose</p>
        <p v-else>Encrypting &amp; uploading… {{ Math.round(files.uploadProgress * 100) }}%</p>
        <progress v-if="files.uploading" :value="files.uploadProgress" max="1" />
        <input ref="fileInput" type="file" class="hidden" @change="onFileChosen" />
      </div>

      <p v-if="files.error || folders.error" class="error">{{ files.error || folders.error }}</p>

      <p v-if="files.warning" class="warn">{{ files.warning }}</p>

      <p class="muted" v-if="!folders.paginatedView.length && !files.loading">
        Nothing here.
      </p>

      <ul class="list">
        <li v-for="entry in folders.paginatedView" :key="entry.kind + (entry.kind === 'folder' ? entry.folder.id : entry.file.id)">
          <template v-if="entry.kind === 'folder'">
            <span class="name">📁 {{ entry.folder.name }}</span>
            <span class="actions">
              <button class="link" @click="openFolder(entry.folder.id)">Open</button>
              <button class="link" @click="renameFolder(entry.folder.id, entry.folder.name)">Rename</button>
              <button class="link" @click="moveFolder(entry.folder.id)">Move</button>
              <button class="link" @click="removeFolder(entry.folder.id, entry.folder.name)">Delete</button>
            </span>
          </template>
          <template v-else>
            <span class="name">{{ fileName(entry.file) }}</span>
            <span class="meta">{{ fmtSize(entry.file.total_size) }} · {{ entry.file.status }}</span>
            <span class="actions">
              <button class="link" :disabled="!previewable(entry.file)" @click="open(entry.file)">Open</button>
              <button class="link" :disabled="entry.file.status !== 'ready'" @click="download(entry.file)">Download</button>
              <button class="link" @click="moveFile(entry.file.id)">Move</button>
              <button class="link" @click="remove(entry.file)">Delete</button>
            </span>
          </template>
        </li>
      </ul>

      <nav class="pager" v-if="folders.totalPages > 1">
        <button class="link" :disabled="!showPrevPage" @click="folders.setPage(folders.page - 1)">Prev</button>
        <span class="muted">Page {{ folders.page + 1 }} / {{ folders.totalPages }}</span>
        <button class="link" :disabled="!showNextPage" @click="folders.setPage(folders.page + 1)">Next</button>
      </nav>

      <section v-if="files.activeUploads.length" class="uploads">
        <h2>Incomplete uploads</h2>
        <ul class="list">
          <li v-for="u in files.activeUploads" :key="u.fileId">
            <span class="name">{{ u.file.name }}</span>
            <span class="meta">{{ Math.round(u.progress * 100) }}% · {{ u.phase }}</span>
            <progress :value="u.progress" max="1" />
            <button class="link" @click="files.cancelUpload(u.fileId)">Cancel</button>
          </li>
        </ul>
      </section>

      <FilePreviewModal
        v-if="files.preview"
        :kind="files.preview.kind"
        :url="files.preview.url"
        :name="files.preview.name"
        @close="files.closePreview()"
      />

      <MovePickerModal
        :open="moveTarget !== null"
        :exclude-id="moveTarget?.kind === 'folder' ? moveTarget.id : undefined"
        @pick="onMovePicked"
        @cancel="moveTarget = null"
      />
    </section>
  </main>
</template>

<style scoped>
.page { display: flex; flex-direction: column; min-height: 100vh; }
.bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.8rem 1.5rem; border-bottom: 1px solid var(--df-color-border);
  background: var(--df-color-bg-elevated);
}
.brand .logo { font-weight: 700; letter-spacing: 0.02em; }
nav { display: flex; gap: 1rem; align-items: center; }
nav a { color: var(--df-color-fg-muted); }
nav a.router-link-active { color: var(--df-color-fg); }
.link { background: transparent; color: var(--df-color-fg-muted); border: 0; cursor: pointer; padding: 0; }
.link:disabled { opacity: 0.4; cursor: default; }
.content { padding: 2rem 1.5rem; max-width: 1100px; width: 100%; margin: 0 auto; }
.breadcrumbs { margin-bottom: 1rem; display: flex; gap: 0.4rem; align-items: center; }
.crumb { color: var(--df-color-fg-muted); cursor: pointer; }
.sep { color: var(--df-color-fg-muted); }
.toolbar { margin-bottom: 1rem; }
h1, h2 { margin: 0 0 1rem; font-size: 1.4rem; }
.muted { color: var(--df-color-fg-muted); }
.error { color: #c0392b; }
.warn { color: #b8860b; }
.dropzone {
  border: 2px dashed var(--df-color-border); border-radius: var(--df-radius-sm);
  padding: 2rem; text-align: center; cursor: pointer; color: var(--df-color-fg-muted);
  margin-bottom: 1.5rem;
}
.dropzone.over { border-color: var(--df-color-fg); }
.hidden { display: none; }
progress { width: 60%; }
.list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.list li {
  background: var(--df-color-bg-elevated); border: 1px solid var(--df-color-border);
  border-radius: var(--df-radius-sm); padding: 0.7rem 0.9rem;
  display: flex; flex-direction: column; gap: 0.15rem;
}
.name { font-weight: 600; }
.meta { color: var(--df-color-fg-muted); font-size: 0.8rem; }
.actions { display: flex; gap: 1rem; margin-top: 0.3rem; }
.pager { display: flex; gap: 1rem; align-items: center; margin-top: 1rem; }
.uploads { margin-top: 2rem; }
</style>
