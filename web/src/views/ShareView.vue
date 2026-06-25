<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { sharesApi } from "@/api/shares";
import { ApiError } from "@/api/client";
import { cryptoApi, ensureCryptoReady } from "@/workers/crypto";
import { fromBase64, FILE_CHUNK_SIZE, type Manifest } from "@/crypto/file";
import { kindOf, canPreview, type FileKind } from "@/crypto/preview";
import FilePreviewModal from "@/components/FilePreviewModal.vue";
import type { ShareInfo } from "@/api/types";

const route = useRoute();
const shareId = route.params.shareId as string;

const phase = ref<"loading" | "password" | "ready" | "error">("loading");
const message = ref<string | null>(null);
const passwordInput = ref("");
const manifest = ref<Manifest | null>(null);
const fileKey = ref<Uint8Array | null>(null);
const preview = ref<{
  kind: FileKind;
  url: string;
  name: string;
  player?: { fileKey: Uint8Array; ivBase: Uint8Array; chunkSize: number; totalSize: number; fetchChunk: (i: number) => Promise<Uint8Array> } | null;
} | null>(null);
const downloading = ref(false);

let info: ShareInfo | null = null;
let encKey = "";
let encKeyNonce = "";

async function fetchChunk(idx: number): Promise<Uint8Array> {
  const r = await sharesApi.getChunk(shareId, idx);
  return new Uint8Array(await r.arrayBuffer());
}

async function unlockWithShareKey(shareKey: Uint8Array) {
  message.value = null;
  const fk = await cryptoApi.unwrapFileKeyForShare(
    { ciphertext: fromBase64(encKey), iv: fromBase64(encKeyNonce) },
    shareKey,
  );
  fileKey.value = fk;
  manifest.value = await cryptoApi.decryptManifestWithKey(
    fk,
    info!.encrypted_manifest!,
    info!.encrypted_manifest_nonce!,
  );
  phase.value = "ready";
}

async function load() {
  await ensureCryptoReady();
  try {
    info = await sharesApi.get(shareId);
  } catch (e) {
    phase.value = "error";
    message.value = (e as Error).message;
    return;
  }
  if (info.state && info.state !== "active") {
    phase.value = "error";
    message.value = { expired: "This share has expired.", exhausted: "This share has reached its open limit.", revoked: "This share was revoked." }[info.state] ?? "Share unavailable.";
    return;
  }
  encKey = info.encrypted_file_key;
  encKeyNonce = info.encrypted_file_key_nonce;
  if (info.requires_password) {
    phase.value = "password";
    return;
  }
  const k = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("k");
  if (!k) {
    phase.value = "error";
    message.value = "Missing key in link.";
    return;
  }
  try {
    const shareKey = await cryptoApi.deriveShareKey(fromBase64(k), fromBase64(info.share_salt));
    await unlockWithShareKey(shareKey);
  } catch {
    phase.value = "error";
    message.value = "Couldn't open this share — the link may be corrupted.";
  }
}

async function submitPassword() {
  try {
    const shareKey = await cryptoApi.deriveShareKey(
      new TextEncoder().encode(passwordInput.value),
      fromBase64(info!.share_salt),
    );
    const verifier = await cryptoApi.shareVerifier(shareKey);
    const res = await sharesApi.verify(shareId, { password_verifier: verifier });
    encKey = res.encrypted_file_key;
    encKeyNonce = res.encrypted_file_key_nonce;
    info!.encrypted_manifest = res.encrypted_manifest;
    info!.encrypted_manifest_nonce = res.encrypted_manifest_nonce;
    await unlockWithShareKey(shareKey);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      message.value = "Wrong password.";
    } else {
      message.value = "Couldn't open this share. Please try again.";
    }
  }
}

async function openPreview() {
  if (!manifest.value || !fileKey.value) return;
  const m = manifest.value;
  const kind = kindOf(m.mime);
  const ivBase = fromBase64(m.iv_base);
  if (kind === "other" || !canPreview(kind, m.size)) {
    message.value = "Preview not supported for this file — use Download.";
    return;
  }
  if (kind === "video" && ["video/mp4", "video/quicktime", "video/x-m4v"].includes(m.mime) && typeof MediaSource !== "undefined") {
    preview.value = {
      kind, url: "", name: m.name,
      player: { fileKey: fileKey.value, ivBase, chunkSize: FILE_CHUNK_SIZE, totalSize: m.size, fetchChunk: fetchChunk },
    };
    return;
  }
  const n = Math.max(1, Math.ceil(m.size / FILE_CHUNK_SIZE));
  const parts = new Array<Uint8Array>(n);
  for (let i = 0; i < n; i++) {
    const cipher = await fetchChunk(i);
    parts[i] = await cryptoApi.decryptChunk(fileKey.value, ivBase, i, cipher);
  }
  const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: m.mime }));
  if (preview.value && !preview.value.player && preview.value.url.startsWith("blob:")) {
    URL.revokeObjectURL(preview.value.url);
  }
  preview.value = { kind, url, name: m.name, player: null };
}

async function download() {
  if (!manifest.value || !fileKey.value) return;
  downloading.value = true;
  try {
    const m = manifest.value;
    const ivBase = fromBase64(m.iv_base);
    const n = Math.max(1, Math.ceil(m.size / FILE_CHUNK_SIZE));
    const parts = new Array<Uint8Array>(n);
    for (let i = 0; i < n; i++) {
      const cipher = await fetchChunk(i);
      parts[i] = await cryptoApi.decryptChunk(fileKey.value, ivBase, i, cipher);
    }
    const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: m.mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = m.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    message.value = "Download failed — please try again.";
  } finally {
    downloading.value = false;
  }
}

function closePreview() {
  if (preview.value && !preview.value.player && preview.value.url.startsWith("blob:")) {
    URL.revokeObjectURL(preview.value.url);
  }
  preview.value = null;
}

onMounted(load);
</script>

<template>
  <main class="page">
    <div class="card">
      <h1>Shared file</h1>

      <p v-if="phase === 'loading'" class="muted">Opening…</p>

      <section v-else-if="phase === 'password'">
        <p>This share is password-protected.</p>
        <input v-model="passwordInput" type="password" placeholder="password" class="input" @keyup.enter="submitPassword" />
        <button class="primary" @click="submitPassword">Unlock</button>
        <p v-if="message" class="error">{{ message }}</p>
      </section>

      <section v-else-if="phase === 'ready'">
        <p class="name">{{ manifest?.name ?? "file" }}</p>
        <div class="actions">
          <button class="primary" @click="openPreview">Preview</button>
          <button class="primary" :disabled="downloading" @click="download">
            {{ downloading ? "…" : "Download" }}
          </button>
        </div>
        <p v-if="message" class="error">{{ message }}</p>
      </section>

      <section v-else>
        <p class="error">{{ message ?? "Share unavailable." }}</p>
      </section>

      <FilePreviewModal
        v-if="preview"
        :kind="preview.kind"
        :url="preview.url"
        :name="preview.name"
        :player="preview.player"
        @close="closePreview"
        @error="(m: string) => (message = m)"
      />
    </div>
  </main>
</template>

<style scoped>
.page { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1rem; }
.card { background: var(--df-color-bg-elevated); border: 1px solid var(--df-color-border); border-radius: var(--df-radius-md); padding: 2rem; width: 100%; max-width: 480px; text-align: center; }
h1 { margin: 0 0 1rem; }
.muted { color: var(--df-color-fg-muted); }
.name { font-weight: 700; word-break: break-all; }
.actions { display: flex; gap: 0.5rem; justify-content: center; margin-top: 1rem; }
.input { width: 100%; padding: 0.5rem; background: var(--df-color-bg); border: 1px solid var(--df-color-border); border-radius: var(--df-radius-sm); color: inherit; margin-bottom: 0.5rem; }
.primary { padding: 0.5rem 1rem; background: var(--df-color-accent, #406); color: #fff; border: 0; border-radius: var(--df-radius-sm); cursor: pointer; }
.primary:disabled { opacity: 0.5; cursor: default; }
.error { color: #c0392b; }
</style>
