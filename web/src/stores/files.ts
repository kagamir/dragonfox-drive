import { defineStore } from "pinia";
import { ref } from "vue";

import { filesApi } from "@/api/files";
import { refreshAuthToken, ApiError, getAuthToken } from "@/api/client";
import type { FileMeta } from "@/api/types";
import { cryptoApi, ensureCryptoReady } from "@/workers/crypto";
import { useAuthStore } from "./auth";
import { useFoldersStore } from "./folders";
import { FILE_CHUNK_SIZE, chunkCount, toBase64, fromBase64, type Manifest } from "@/crypto/file";
import { kindOf, canPreview, PREVIEW_CAPS, type FileKind } from "@/crypto/preview";
import type { WrappedKey } from "@/crypto/keys";
import { ensureStreamSw, postToSw } from "@/sw/register";

export interface UploadSession {
  fileId: string;
  file: File;
  fileKey: Uint8Array;
  ivBase: Uint8Array;
  chunkCount: number;
  done: Set<number>;
  phase: "uploading" | "finalizing" | "done" | "error";
  progress: number; // 0..1
  abort: AbortController;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run `fn` over `items` with at most `limit` concurrent invocations. */
async function asyncPool<T>(
  limit: number,
  items: readonly T[],
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const p = (async () => fn(item))().finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) {
      try {
        await Promise.race(executing);
      } catch (e) {
        // A task failed. Settle the rest so their rejections are consumed
        // (not reported as unhandled) before propagating the first failure.
        await Promise.allSettled(executing);
        throw e;
      }
    }
  }
  await Promise.all(executing);
}

export const useFilesStore = defineStore("files", () => {
  const files = ref<FileMeta[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const uploading = ref(false);
  const uploadProgress = ref(0);
  const downloading = ref(false);
  const displayNames = ref<Record<string, string>>({});
  const fileParents = ref<Record<string, string | null>>({});
  const activeUploads = ref<UploadSession[]>([]);
  const preview = ref<{
    meta: FileMeta;
    url: string;
    kind: FileKind;
    name: string;
  } | null>(null);

  function masterKey(): Uint8Array {
    const key = useAuthStore().masterKey;
    if (!key) throw new Error("not unlocked — master key missing");
    return key;
  }

  /** Resolve the key that wraps a file's file_key: the parent folder's
   *  folder_key, or master_key when the file lives at root. */
  function wrapKeyForFile(id: string): Uint8Array {
    const mk = masterKey();
    const parentId = fileParents.value[id] ?? null;
    if (parentId === null) return mk;
    const foldersStore = useFoldersStore();
    const fk = foldersStore.folderKeyOf(parentId);
    if (!fk) throw new Error("parent folder key not available");
    return fk;
  }

  /** Unwrap a file's file_key and decrypt its manifest. Folder-aware: the
   *  wrap key is the parent folder's folder_key (or master_key at root).
   *  Returns both the file_key (for chunk decrypt / openVideo) and manifest. */
  async function unlockFile(meta: {
    id: string;
    encrypted_file_key: string | null;
    encrypted_file_key_nonce: string | null;
    encrypted_manifest: string | null;
    encrypted_manifest_nonce: string | null;
  }): Promise<{ fileKey: Uint8Array; manifest: Manifest }> {
    if (
      !meta.encrypted_file_key ||
      !meta.encrypted_file_key_nonce ||
      !meta.encrypted_manifest ||
      !meta.encrypted_manifest_nonce
    ) {
      throw new Error("file not fully uploaded");
    }
    const fileKey = await cryptoApi.unwrap(
      {
        ciphertext: fromBase64(meta.encrypted_file_key),
        iv: fromBase64(meta.encrypted_file_key_nonce),
      },
      wrapKeyForFile(meta.id),
    );
    const manifest = await cryptoApi.decryptManifestWithKey(
      fileKey,
      meta.encrypted_manifest,
      meta.encrypted_manifest_nonce,
    );
    return { fileKey, manifest };
  }

  let swListenerBound = false;
  function bindSwListener(): void {
    if (swListenerBound || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    swListenerBound = true;
    navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
      const d = e.data;
      if (d && d.type === "needToken" && d.fileId) {
        void refreshAuthToken().then((ok) => {
          const token = ok ? getAuthToken() : null;
          if (token) postToSw({ type: "token", fileId: d.fileId, token });
        });
      }
    });
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await filesApi.list();
      files.value = res.files;
      void decryptNames();
      void decryptParents();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Best-effort: decrypt each ready file's manifest to show its real name.
   * Never rejects — if the key is unavailable or a single manifest fails to
   * decrypt, we silently leave the file id as the display fallback.
   */
  async function decryptNames(): Promise<void> {
    try {
      masterKey();
    } catch {
      return;
    }
    for (const f of files.value) {
      if (
        f.status === "ready" &&
        f.encrypted_manifest &&
        f.encrypted_manifest_nonce &&
        f.encrypted_file_key &&
        f.encrypted_file_key_nonce &&
        !displayNames.value[f.id]
      ) {
        try {
          const { manifest: m } = await unlockFile(f);
          displayNames.value[f.id] = m.name;
        } catch {
          /* leave id as the display fallback */
        }
      }
    }
  }

  async function decryptParents(): Promise<void> {
    let key: Uint8Array;
    try {
      key = masterKey();
    } catch {
      return;
    }
    for (const f of files.value) {
      if (fileParents.value[f.id] === undefined) {
        if (f.encrypted_parent_id && f.encrypted_parent_id_nonce) {
          try {
            fileParents.value[f.id] = await cryptoApi.decryptParentId(
              key,
              fromBase64(f.encrypted_parent_id),
              fromBase64(f.encrypted_parent_id_nonce),
            );
          } catch {
            fileParents.value[f.id] = null;
          }
        } else {
          fileParents.value[f.id] = null;
        }
      }
    }
  }

  function filesWithParent(parentId: string | null): FileMeta[] {
    return files.value.filter((f) => (fileParents.value[f.id] ?? null) === parentId);
  }

  async function upload(file: File): Promise<void> {
    uploading.value = true;
    uploadProgress.value = 0;
    error.value = null;
    let session: UploadSession | null = null;
    try {
      await ensureCryptoReady();
      const mk = masterKey();
      const { fileKey, ivBase } = await cryptoApi.newFileKeyMaterial();
      const total = file.size;
      const n = chunkCount(total);

      const foldersStore = useFoldersStore();
      const parentId = foldersStore.currentFolderId;
      let wrapKey: Uint8Array;
      if (parentId === null) {
        wrapKey = mk;
      } else {
        const fk = foldersStore.folderKeyOf(parentId);
        if (!fk) throw new Error("current folder key not available");
        wrapKey = fk;
      }
      const wrapped: WrappedKey = await cryptoApi.wrap(fileKey, wrapKey);
      const parentEnc = await cryptoApi.encryptParentId(mk, parentId);
      const { id } = await filesApi.create({
        total_size: total,
        chunk_count: n,
        encrypted_file_key: toBase64(wrapped.ciphertext),
        encrypted_file_key_nonce: toBase64(wrapped.iv),
        ...(parentEnc
          ? {
              encrypted_parent_id: toBase64(parentEnc.ciphertext),
              encrypted_parent_id_nonce: toBase64(parentEnc.iv),
            }
          : {}),
      });
      fileParents.value[id] = parentId;

      const manifestObj = {
        version: 1,
        name: file.name,
        mime: file.type || "application/octet-stream",
        size: total,
        chunk_size: FILE_CHUNK_SIZE,
        iv_base: toBase64(ivBase),
        created_at: new Date().toISOString(),
      };
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestObj));
      const em = await cryptoApi.seal(fileKey, manifestBytes);
      await filesApi.putManifest(id, {
        encrypted_manifest: toBase64(em.ciphertext),
        encrypted_manifest_nonce: toBase64(em.iv),
      });

      session = {
        fileId: id, file, fileKey, ivBase, chunkCount: n,
        done: new Set<number>(), phase: "uploading", progress: 0,
        abort: new AbortController(),
      };
      activeUploads.value.push(session);

      const info = await filesApi.getChunks(id);
      for (const idx of info.indices) session.done.add(idx);
      session.progress = session.done.size / n;

      const missing: number[] = [];
      for (let i = 0; i < n; i++) if (!session.done.has(i)) missing.push(i);

      await asyncPool(3, missing, async (i) => {
        if (session!.abort.signal.aborted) return;
        const start = i * FILE_CHUNK_SIZE;
        const slice = file.slice(start, Math.min(start + FILE_CHUNK_SIZE, total));
        const plaintext = new Uint8Array(await slice.arrayBuffer());
        let attempt = 0;
        let refreshed = false;
        while (true) {
          const ciphertext = await cryptoApi.encryptChunk(fileKey, ivBase, i, plaintext);
          try {
            await filesApi.putChunk(
              id, i, ciphertext,
              undefined,
              session!.abort.signal,
            );
            break;
          } catch (e) {
            if (session!.abort.signal.aborted) return;
            if (!refreshed && e instanceof ApiError && e.status === 401) {
              refreshed = true;
              if (await refreshAuthToken()) continue;
            }
            if (++attempt > 3) throw e;
            await delay(500 * 2 ** attempt);
          }
        }
        session!.done.add(i);
        session!.progress = session!.done.size / n;
        uploadProgress.value = session!.progress;
      });

      if (session.abort.signal.aborted) return;
      session.phase = "finalizing";
      await filesApi.finalize(id);
      session.phase = "done";
      await refresh();
    } catch (e) {
      if (session) session.phase = "error";
      error.value = (e as Error).message;
      throw e;
    } finally {
      uploading.value = false;
      if (session && session.phase === "done") {
        const idx = activeUploads.value.indexOf(session);
        if (idx >= 0) activeUploads.value.splice(idx, 1);
      }
    }
  }

  async function cancelUpload(fileId: string): Promise<void> {
    const s = activeUploads.value.find((x) => x.fileId === fileId);
    if (!s) return;
    s.abort.abort();
    try { await filesApi.remove(fileId); } catch { /* best effort cleanup */ }
    const idx = activeUploads.value.indexOf(s);
    if (idx >= 0) activeUploads.value.splice(idx, 1);
  }

  function saveBlob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function download(meta: FileMeta): Promise<void> {
    downloading.value = true;
    error.value = null;
    try {
      await ensureCryptoReady();
      const { fileKey, manifest } = await unlockFile(meta);
      const ivBase = fromBase64(manifest.iv_base);
      const n = meta.chunk_count;
      const parts = new Array<Uint8Array>(n);
      await asyncPool(
        3,
        Array.from({ length: n }, (_, i) => i),
        async (i) => {
          const resp = await filesApi.getChunk(meta.id, i);
          const cipher = new Uint8Array(await resp.arrayBuffer());
          parts[i] = await cryptoApi.decryptChunk(fileKey, ivBase, i, cipher);
        },
      );
      saveBlob(new Blob(parts as BlobPart[], { type: manifest.mime }), manifest.name);
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    } finally {
      downloading.value = false;
    }
  }

  async function moveFile(id: string, newParentId: string | null): Promise<void> {
    error.value = null;
    try {
      await ensureCryptoReady();
      const mk = masterKey();
      const foldersStore = useFoldersStore();
      const meta = files.value.find((f) => f.id === id);
      if (!meta || !meta.encrypted_file_key || !meta.encrypted_file_key_nonce) {
        throw new Error("file not found");
      }
      const curParent = fileParents.value[id] ?? null;
      let curWrapKey: Uint8Array;
      if (curParent === null) {
        curWrapKey = mk;
      } else {
        const fk = foldersStore.folderKeyOf(curParent);
        if (!fk) throw new Error("current folder key not available");
        curWrapKey = fk;
      }
      const fileKey = await cryptoApi.unwrap(
        {
          ciphertext: fromBase64(meta.encrypted_file_key),
          iv: fromBase64(meta.encrypted_file_key_nonce),
        },
        curWrapKey,
      );
      let newWrapKey: Uint8Array;
      if (newParentId === null) {
        newWrapKey = mk;
      } else {
        const fk = foldersStore.folderKeyOf(newParentId);
        if (!fk) throw new Error("target folder key not available");
        newWrapKey = fk;
      }
      const rewrapped = await cryptoApi.wrap(fileKey, newWrapKey);
      const parentEnc = await cryptoApi.encryptParentId(mk, newParentId);
      await filesApi.move(id, {
        encrypted_parent_id: parentEnc ? toBase64(parentEnc.ciphertext) : null,
        encrypted_parent_id_nonce: parentEnc ? toBase64(parentEnc.iv) : null,
        encrypted_file_key: toBase64(rewrapped.ciphertext),
        encrypted_file_key_nonce: toBase64(rewrapped.iv),
      });
      fileParents.value[id] = newParentId;
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    }
  }

  async function openVideo(meta: FileMeta, manifest: Manifest, fileKey: Uint8Array): Promise<void> {
    const ivBase = fromBase64(manifest.iv_base);
    bindSwListener();
    let swOk = true;
    try {
      await ensureStreamSw();
    } catch {
      swOk = false;
    }
    if (swOk) {
      if (preview.value) closePreview();
      postToSw({
        type: "play",
        meta: {
          fileId: meta.id,
          fileKey,
          ivBase,
          size: manifest.size,
          chunkCount: meta.chunk_count,
          chunkSize: FILE_CHUNK_SIZE,
          token: getAuthToken() ?? "",
          mime: manifest.mime,
        },
      });
      preview.value = {
        meta,
        url: `/api/stream/${meta.id}`,
        kind: "video",
        name: manifest.name,
      };
      return;
    }
    // Fallback: whole-file blob for small videos; otherwise degrade.
    if (manifest.size <= PREVIEW_CAPS.video) {
      const n = meta.chunk_count;
      const parts = new Array<Uint8Array>(n);
      await asyncPool(
        3,
        Array.from({ length: n }, (_, i) => i),
        async (i) => {
          const resp = await filesApi.getChunk(meta.id, i);
          const cipher = new Uint8Array(await resp.arrayBuffer());
          parts[i] = await cryptoApi.decryptChunk(fileKey, ivBase, i, cipher);
        },
      );
      const blob = new Blob(parts as BlobPart[], { type: manifest.mime });
      if (preview.value) URL.revokeObjectURL(preview.value.url);
      preview.value = {
        meta,
        url: URL.createObjectURL(blob),
        kind: "video",
        name: manifest.name,
      };
      return;
    }
    error.value = "Streaming is unavailable in this browser — use Download.";
  }

  async function openPreview(meta: FileMeta): Promise<void> {
    error.value = null;
    try {
      await ensureCryptoReady();
      const { fileKey, manifest } = await unlockFile(meta);
      const kind = kindOf(manifest.mime);
      if (kind === "video") {
        return await openVideo(meta, manifest, fileKey);
      }
      if (kind === "other") {
        error.value = "Preview is not supported for this file type — use Download.";
        return;
      }
      if (!canPreview(kind, manifest.size)) {
        error.value = "File too large to preview — use Download.";
        return;
      }
      const ivBase = fromBase64(manifest.iv_base);
      const n = meta.chunk_count;
      const parts = new Array<Uint8Array>(n);
      await asyncPool(
        3,
        Array.from({ length: n }, (_, i) => i),
        async (i) => {
          const resp = await filesApi.getChunk(meta.id, i);
          const cipher = new Uint8Array(await resp.arrayBuffer());
          parts[i] = await cryptoApi.decryptChunk(fileKey, ivBase, i, cipher);
        },
      );
      const blob = new Blob(parts as BlobPart[], { type: manifest.mime });
      if (preview.value) URL.revokeObjectURL(preview.value.url);
      preview.value = {
        meta,
        url: URL.createObjectURL(blob),
        kind,
        name: manifest.name,
      };
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  function closePreview(): void {
    if (!preview.value) return;
    const p = preview.value;
    if (p.url.startsWith("blob:")) URL.revokeObjectURL(p.url);
    if (p.kind === "video" && p.url.startsWith("/api/stream/")) {
      postToSw({ type: "stop", fileId: p.meta.id });
    }
    preview.value = null;
  }

  async function remove(id: string): Promise<void> {
    await filesApi.remove(id);
    await refresh();
  }

  return {
    files,
    loading,
    error,
    uploading,
    uploadProgress,
    downloading,
    displayNames,
    activeUploads,
    fileParents,
    refresh,
    upload,
    cancelUpload,
    download,
    remove,
    filesWithParent,
    moveFile,
    preview,
    openPreview,
    closePreview,
  };
});
