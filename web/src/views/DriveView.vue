<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useFilesStore } from "@/stores/files";
import type { FileMeta } from "@/api/types";

const auth = useAuthStore();
const files = useFilesStore();
const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);

onMounted(() => {
  void files.refresh();
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
  } catch {
    /* error surfaced in store */
  } finally {
    target.value = "";
  }
}

function onDrop(e: DragEvent) {
  dragOver.value = false;
  const f = e.dataTransfer?.files[0];
  if (f) void files.upload(f).catch(() => {});
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
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function nameOf(f: FileMeta): string {
  return files.displayNames[f.id] ?? f.id;
}

function download(f: FileMeta) {
  void files.download(f).catch(() => {});
}

function remove(f: FileMeta) {
  if (confirm(`Delete "${nameOf(f)}"?`)) void files.remove(f.id);
}
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
      <h1>Your encrypted files</h1>

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
        <input
          ref="fileInput"
          type="file"
          class="hidden"
          @change="onFileChosen"
        />
      </div>

      <p v-if="files.error" class="error">{{ files.error }}</p>

      <p class="muted" v-if="!files.files.length && !files.loading">
        No files yet.
      </p>

      <ul class="list" v-if="files.files.length">
        <li v-for="f in files.files" :key="f.id">
          <span class="name">{{ nameOf(f) }}</span>
          <span class="meta">{{ fmtSize(f.total_size) }} · {{ f.status }}</span>
          <span class="actions">
            <button class="link" :disabled="f.status !== 'ready'" @click="download(f)">Download</button>
            <button class="link" @click="remove(f)">Delete</button>
          </span>
        </li>
      </ul>
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
h1 { margin: 0 0 1rem; font-size: 1.4rem; }
.muted { color: var(--df-color-fg-muted); }
.error { color: #c0392b; }
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
</style>
