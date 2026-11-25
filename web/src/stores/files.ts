import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";

import { filesApi } from "@/api/files";
import { refreshAuthToken, ApiError } from "@/api/client";
import type { FileMeta } from "@/api/types";
import { cryptoApi, ensureCryptoReady } from "@/workers/crypto";
import { useAuthStore } from "./auth";
import { useFoldersStore } from "./folders";
import { FILE_CHUNK_SIZE, chunkCount, newContentId, serializeManifest, toBase64, fromBase64, toHex, type Manifest } from "@/crypto/file";
import { kindOf, canPreview, PREVIEW_CAPS, type FileKind } from "@/crypto/preview";
import { displayMime } from "@/util/media";
import type { WrappedKey } from "@/crypto/keys";

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

export interface DownloadSession {
  fileId: string;
  name: string;
  progress: number; // 0..1
  phase: "downloading" | "done" | "error";
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
  const displayMimes = ref<Record<string, string>>({});
  let refreshId = 0;
  const fileParents = ref<Record<string, string | null>>({});
  const activeUploads = ref<UploadSession[]>([]);
  const activeDownloads = ref<DownloadSession[]>([]);
  const preview = shallowRef<{
    meta: FileMeta;
    url: string;
    kind: FileKind;
    previewBlob?: Blob;
    name: string;
    player?: { fileKey: Uint8Array; ivBase: Uint8Array; contentId: string; chunkSize: number; totalSize: number; fetchChunk: (idx: number) => Promise<Uint8Array> } | null;
  } | null>(null);

  const previewRequest = shallowRef<AbortController | null>(null);
  const previewLoading = computed(() => previewRequest.value !== null);

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

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    const id = ++refreshId;
    try {
      const res = await filesApi.list();
      if (refreshId !== id) return;
      const previous = new Map(files.value.map((f) => [f.id, f]));
      for (const f of res.files) {
        const old = previous.get(f.id);
        previous.delete(f.id);
        if (old?.encrypted_manifest !== f.encrypted_manifest || old?.encrypted_manifest_nonce !== f.encrypted_manifest_nonce) {
          delete displayNames.value[f.id];
          delete displayMimes.value[f.id];
        }
        if (old?.encrypted_parent_id !== f.encrypted_parent_id || old?.encrypted_parent_id_nonce !== f.encrypted_parent_id_nonce) {
          delete fileParents.value[f.id];
        }
      }
      for (const removedId of previous.keys()) {
        delete displayNames.value[removedId];
        delete displayMimes.value[removedId];
        delete fileParents.value[removedId];
      }
      files.value = res.files;
      await decryptParents(id);
      await decryptNames(id);
    } catch (e) {
      if (id === refreshId) error.value = (e as Error).message;
    } finally {
      if (id === refreshId) loading.value = false;
    }
  }

  /**
   * Best-effort: decrypt each ready file's manifest to show its real name.
   * Never rejects — if the key is unavailable or a single manifest fails to
   * decrypt, we silently leave the file id as the display fallback.
   */
  async function decryptNames(id: number): Promise<void> {
    if (id !== refreshId) return;
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
        displayMimes.value[f.id] === undefined
      ) {
        try {
          const { manifest: m } = await unlockFile(f);
          if (id !== refreshId) return;
          displayNames.value[f.id] = m.name;
          displayMimes.value[f.id] = m.mime || "";
        } catch {
          /* leave id as the display fallback */
        }
      }
    }
  }

  async function decryptParents(id: number): Promise<void> {
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
            const parent = await cryptoApi.decryptParentId(
              key,
              fromBase64(f.encrypted_parent_id),
              fromBase64(f.encrypted_parent_id_nonce),
            );
            if (id !== refreshId) return;
            fileParents.value[f.id] = parent;
          } catch {
            if (id !== refreshId) return;
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

  async function upload(file: File): Promise<string> {
    uploading.value = true;
    uploadProgress.value = 0;
    error.value = null;
    let session: UploadSession | null = null;
    let id = "";
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
      ({ id } = await filesApi.create({
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
      }));
      fileParents.value[id] = parentId;

      const contentId = newContentId();
      const manifestObj = {
        version: 1,
        name: file.name,
        mime: file.type || "application/octet-stream",
        size: total,
        chunk_size: FILE_CHUNK_SIZE,
        iv_base: toBase64(ivBase),
        content_id: contentId,
        created_at: new Date().toISOString(),
      };
      const manifestBytes = serializeManifest(manifestObj);
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
          const ciphertext = await cryptoApi.encryptChunk(fileKey, ivBase, i, plaintext, contentId);
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

      if (session.abort.signal.aborted) return id;
      session.phase = "finalizing";
      await filesApi.finalize(id);
      session.phase = "done";
      await refresh();
      return id;
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
    const session: DownloadSession = {
      fileId: meta.id,
      name: displayNames.value[meta.id] ?? meta.id,
      progress: 0,
      phase: "downloading",
      abort: new AbortController(),
    };
    activeDownloads.value.push(session);
    try {
      await ensureCryptoReady();
      const { fileKey, manifest } = await unlockFile(meta);
      const ivBase = fromBase64(manifest.iv_base);
      const n = meta.chunk_count;
      const parts = new Array<Uint8Array>(n);
      const done = new Set<number>();
      await asyncPool(
        3,
        Array.from({ length: n }, (_, i) => i),
        async (i) => {
          if (session.abort.signal.aborted) return;
          const resp = await filesApi.getChunk(meta.id, i, session.abort.signal);
          const cipher = new Uint8Array(await resp.arrayBuffer());
          parts[i] = await cryptoApi.decryptChunk(fileKey, ivBase, i, cipher, manifest.content_id);
          done.add(i);
          session.progress = done.size / n;
        },
      );
      if (session.abort.signal.aborted) return;
      saveBlob(new Blob(parts as BlobPart[], { type: manifest.mime }), manifest.name);
      session.phase = "done";
      setTimeout(() => {
        const idx = activeDownloads.value.indexOf(session);
        if (idx >= 0) activeDownloads.value.splice(idx, 1);
      }, 1500);
    } catch (e) {
      session.phase = "error";
      error.value = (e as Error).message;
      throw e;
    } finally {
      downloading.value = false;
    }
  }

  async function cancelDownload(fileId: string): Promise<void> {
    const s = activeDownloads.value.find((x) => x.fileId === fileId);
    if (!s) return;
    s.abort.abort();
    const idx = activeDownloads.value.indexOf(s);
    if (idx >= 0) activeDownloads.value.splice(idx, 1);
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
      // Keep the local cache in sync with the server: unlockFile re-derives the
      // wrap key from fileParents[id] and unwraps meta.encrypted_file_key, so
      // both must reflect the new parent together — otherwise the file can't be
      // opened/downloaded until a refresh re-fetches the re-wrapped key.
      files.value = files.value.map((f) =>
        f.id === id
          ? {
              ...f,
              encrypted_file_key: toBase64(rewrapped.ciphertext),
              encrypted_file_key_nonce: toBase64(rewrapped.iv),
              encrypted_parent_id: parentEnc ? toBase64(parentEnc.ciphertext) : null,
              encrypted_parent_id_nonce: parentEnc ? toBase64(parentEnc.iv) : null,
            }
          : f,
      );
      fileParents.value[id] = newParentId;
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    }
  }

  async function renameFile(id: string, newName: string): Promise<void> {
    error.value = null;
    try {
      await ensureCryptoReady();
      const meta = files.value.find((f) => f.id === id);
      if (!meta) throw new Error("file not found");
      const { fileKey, manifest } = await unlockFile(meta);
      const nextManifest: Manifest = { ...manifest, name: newName };
      const manifestBytes = serializeManifest(nextManifest);
      const em = await cryptoApi.seal(fileKey, manifestBytes);
      await filesApi.putManifest(id, {
        encrypted_manifest: toBase64(em.ciphertext),
        encrypted_manifest_nonce: toBase64(em.iv),
      });
      // Keep the local cache in sync with the server so a subsequent
      // preview/download doesn't re-fetch stale manifest data.
      files.value = files.value.map((f) =>
        f.id === id
          ? {
              ...f,
              encrypted_manifest: toBase64(em.ciphertext),
              encrypted_manifest_nonce: toBase64(em.iv),
            }
          : f,
      );
      displayNames.value[id] = newName;
      displayMimes.value[id] = manifest.mime || "";
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    }
  }

  /**
   * Replace a text file's content in place. Keeps the file's existing
   * file_key so any outstanding share links (which hold that key wrapped
   * with a share-derived key the server never sees) keep working — only
   * `iv_base` and `content_id` are refreshed per save. The old `updated_at`
   * is sent as the optimistic-concurrency stamp — a 409 means another device
   * saved first.
   */
  async function saveTextFile(id: string, text: string): Promise<void> {
    error.value = null;
    try {
      await ensureCryptoReady();
      const meta = files.value.find((f) => f.id === id);
      if (!meta) throw new Error("file not found");
      const plaintext = new TextEncoder().encode(text);
      if (plaintext.length === 0) throw new Error("content must not be empty");
      if (plaintext.length > PREVIEW_CAPS.text) throw new Error("file too large to save");
      const { fileKey, manifest } = await unlockFile(meta);
      // Discard the fileKey from newFileKeyMaterial — we only want its fresh
      // 96-bit ivBase. A new random iv_base per save makes IV reuse under the
      // retained file_key probabilistically impossible even across many edits.
      const { ivBase } = await cryptoApi.newFileKeyMaterial();
      // A fresh content_id (used as AAD) prevents splicing chunks/manifests
      // between old and new versions of the file.
      const contentId = newContentId();
      const sha = new Uint8Array(
        await crypto.subtle.digest("SHA-256", plaintext as BufferSource),
      );
      const nextManifest: Manifest = {
        ...manifest,
        size: plaintext.length,
        iv_base: toBase64(ivBase),
        content_id: contentId,
        plaintext_sha256: toHex(sha),
      };
      const em = await cryptoApi.seal(fileKey, serializeManifest(nextManifest));
      const ciphertext = await cryptoApi.encryptChunk(fileKey, ivBase, 0, plaintext, contentId);
      // Send the file's existing wrapped key back unchanged — never rewrap,
      // never rotate. unlockFile already validated these are non-null.
      const res = await filesApi.replaceContent(id, {
        total_size: plaintext.length,
        encrypted_file_key: meta.encrypted_file_key!,
        encrypted_file_key_nonce: meta.encrypted_file_key_nonce!,
        encrypted_manifest: toBase64(em.ciphertext),
        encrypted_manifest_nonce: toBase64(em.iv),
        chunk: toBase64(ciphertext),
        expected_updated_at: meta.updated_at,
      });
      // Keep the local cache in sync: encrypted_file_key/nonce are untouched
      // (same key as before), only the manifest ciphertext, size and stamp
      // change.
      files.value = files.value.map((f) =>
        f.id === id
          ? {
              ...f,
              total_size: plaintext.length,
              encrypted_manifest: toBase64(em.ciphertext),
              encrypted_manifest_nonce: toBase64(em.iv),
              updated_at: res.updated_at,
            }
          : f,
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // The local row's key material may now be stale relative to the
        // server (another device saved first): refresh so a reopen-and-retry
        // decrypts the new chunk with the right key instead of failing.
        // Fired before setting error.value below, since refresh() itself
        // resets error.value synchronously at its start.
        void refresh();
      }
      error.value = (e as Error).message;
      throw e;
    }
  }

  /** Create a text file via the normal upload pipeline; returns the new id. */
  async function createTextFile(name: string, text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length === 0) throw new Error("content must not be empty");
    if (bytes.length > PREVIEW_CAPS.text) throw new Error("file too large to save");
    const file = new File([bytes], name, { type: "text/plain" });
    return upload(file);
  }

  function replacePreview(next: typeof preview.value): void {
    const previous = preview.value;
    preview.value = next;
    if (previous?.url.startsWith("blob:")) URL.revokeObjectURL(previous.url);
  }

  async function openPreview(meta: FileMeta): Promise<void> {
    previewRequest.value?.abort();
    const request = new AbortController();
    previewRequest.value = request;
    const signal = request.signal;
    error.value = null;
    try {
      await ensureCryptoReady();
      if (signal.aborted) return;
      const { fileKey, manifest } = await unlockFile(meta);
      if (signal.aborted) return;
      const mime = displayMime(manifest.mime, manifest.name);
      const kind = kindOf(mime);
      if (kind === "other") {
        error.value = "Preview is not supported for this file type — use Download.";
        return;
      }
      if (kind !== "video" && !canPreview(kind, manifest.size)) {
        error.value = "File too large to preview — use Download.";
        return;
      }
      const ivBase = fromBase64(manifest.iv_base);
      if (kind === "video" && ["video/mp4", "video/quicktime", "video/x-m4v"].includes(mime) && typeof MediaSource !== "undefined") {
        replacePreview({
          meta, url: "", kind, name: manifest.name,
          player: {
            fileKey, ivBase, contentId: manifest.content_id, chunkSize: FILE_CHUNK_SIZE, totalSize: manifest.size,
            fetchChunk: async (i: number) => {
              const r = await filesApi.getChunk(meta.id, i);
              return new Uint8Array(await r.arrayBuffer());
            },
          },
        });
        return;
      }
      if (kind === "video" && manifest.size > PREVIEW_CAPS.video) {
        error.value = "This video can't be played in the browser — use Download.";
        return;
      }
      const n = meta.chunk_count;
      const parts = new Array<Uint8Array>(n);
      await asyncPool(3, Array.from({ length: n }, (_, i) => i), async (i) => {
        if (signal.aborted) return;
        const resp = await filesApi.getChunk(meta.id, i, signal);
        const cipher = new Uint8Array(await resp.arrayBuffer());
        if (!signal.aborted) parts[i] = await cryptoApi.decryptChunk(fileKey, ivBase, i, cipher, manifest.content_id);
      });
      if (signal.aborted) return;
      const blob = new Blob(parts as BlobPart[], { type: mime });
      replacePreview({
        meta, url: URL.createObjectURL(blob), kind, name: manifest.name,
        previewBlob: kind === "image" || kind === "text" ? blob : undefined,
        player: null,
      });
    } catch (e) {
      if (!signal.aborted) {
        error.value = (e as Error).message;
        request.abort();
      }
    } finally {
      if (previewRequest.value === request) previewRequest.value = null;
    }
  }

  function closePreview(): void {
    previewRequest.value?.abort();
    previewRequest.value = null;
    replacePreview(null);
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
    displayMimes,
    activeUploads,
    activeDownloads,
    fileParents,
    refresh,
    upload,
    cancelUpload,
    download,
    cancelDownload,
    remove,
    filesWithParent,
    moveFile,
    renameFile,
    saveTextFile,
    createTextFile,
    unlockFile,
    preview,
    previewLoading,
    openPreview,
    closePreview,
  };
});
