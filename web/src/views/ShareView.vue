<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { sharesApi } from "@/api/shares";
import { ApiError } from "@/api/client";
import { cryptoApi, ensureCryptoReady } from "@/workers/crypto";
import { fromBase64, FILE_CHUNK_SIZE, type Manifest } from "@/crypto/file";
import { kindOf, canPreview, type FileKind } from "@/crypto/preview";
import FilePreviewModal from "@/components/FilePreviewModal.vue";
import DfButton from "@/components/ui/DfButton.vue";
import DfInput from "@/components/ui/DfInput.vue";
import FileTypeIcon from "@/components/FileTypeIcon.vue";
import type { ShareInfo } from "@/api/types";

const { t } = useI18n();
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
  <main class="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-soft to-bg p-4 dark:from-brand/10">
    <div class="w-full max-w-md rounded-2xl border border-border bg-surface p-8 text-center shadow-md">
      <h1 class="mb-4 text-xl font-extrabold text-brand">🦊 {{ t("common.appName") }}</h1>

      <p v-if="phase === 'loading'" class="flex items-center justify-center gap-2 text-sm text-fg-muted">
        <span class="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" /> {{ t("share.opening") }}
      </p>

      <section v-else-if="phase === 'password'" class="flex flex-col gap-3">
        <p class="text-sm text-fg">{{ t("share.protected") }}</p>
        <DfInput v-model="passwordInput" type="password" :placeholder="t('share.password')" data-testid="share-password-input" @keyup.enter="submitPassword" />
        <DfButton data-testid="share-unlock-btn" :loading="false" @click="submitPassword">{{ t("share.unlock") }}</DfButton>
        <p v-if="message" class="text-sm text-danger">{{ message }}</p>
      </section>

      <section v-else-if="phase === 'ready'" class="flex flex-col items-center gap-4">
        <FileTypeIcon :name="manifest?.name ?? 'file'" />
        <p class="break-all text-sm font-semibold text-fg">{{ manifest?.name ?? t("common.appName") }}</p>
        <div class="flex gap-2">
          <DfButton data-testid="share-preview-btn" @click="openPreview">{{ t("share.preview") }}</DfButton>
          <DfButton variant="ghost" data-testid="share-download-btn" :loading="downloading" @click="download">{{ downloading ? t("share.downloading") : t("share.download") }}</DfButton>
        </div>
        <p v-if="message" class="text-sm text-danger">{{ message }}</p>
      </section>

      <section v-else>
        <p class="text-sm text-danger">{{ message ?? t("share.unavailable") }}</p>
      </section>

      <FilePreviewModal
        v-if="preview"
        :kind="preview.kind" :url="preview.url" :name="preview.name" :player="preview.player"
        @close="closePreview" @error="(m: string) => (message = m)"
      />
    </div>
  </main>
</template>
