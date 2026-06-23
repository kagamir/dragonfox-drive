import { defineStore } from "pinia";
import { ref } from "vue";

import { filesApi } from "@/api/files";
import type { FileMeta } from "@/api/types";
import { cryptoApi, ensureCryptoReady } from "@/workers/crypto";
import { useAuthStore } from "./auth";

export const useFilesStore = defineStore("files", () => {
  const files = ref<FileMeta[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const uploading = ref(false);
  const uploadProgress = ref(0);
  const downloading = ref(false);
  const displayNames = ref<Record<string, string>>({});

  function masterKey(): Uint8Array {
    const key = useAuthStore().masterKey;
    if (!key) throw new Error("not unlocked — master key missing");
    return key;
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await filesApi.list();
      files.value = res.files;
      void decryptNames();
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
    let key: Uint8Array;
    try {
      key = masterKey();
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
          const m = await cryptoApi.decryptManifest(
            key,
            f.encrypted_file_key,
            f.encrypted_file_key_nonce,
            f.encrypted_manifest,
            f.encrypted_manifest_nonce,
          );
          displayNames.value[f.id] = m.name;
        } catch {
          /* leave id as the display fallback */
        }
      }
    }
  }

  async function upload(file: File): Promise<void> {
    uploading.value = true;
    uploadProgress.value = 0;
    error.value = null;
    try {
      await ensureCryptoReady();
      const key = masterKey();
      const plaintext = new Uint8Array(await file.arrayBuffer());
      const payload = await cryptoApi.encryptFile(
        key,
        plaintext,
        file.name,
        file.type,
      );
      const { id } = await filesApi.create({
        total_size: plaintext.length,
        chunk_count: 1,
        encrypted_file_key: payload.encrypted_file_key,
        encrypted_file_key_nonce: payload.encrypted_file_key_nonce,
      });
      await filesApi.putManifest(id, {
        encrypted_manifest: payload.encrypted_manifest,
        encrypted_manifest_nonce: payload.encrypted_manifest_nonce,
      });
      await filesApi.putChunk(id, 0, payload.ciphertext, (r) => {
        uploadProgress.value = r;
      });
      await filesApi.finalize(id);
      await refresh();
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    } finally {
      uploading.value = false;
    }
  }

  async function download(meta: FileMeta): Promise<void> {
    downloading.value = true;
    try {
      await ensureCryptoReady();
      const key = masterKey();
      const resp = await filesApi.getChunk(meta.id, 0);
      const ciphertext = new Uint8Array(await resp.arrayBuffer());
      const { plaintext, manifest } = await cryptoApi.decryptFile(
        key,
        meta.encrypted_file_key!,
        meta.encrypted_file_key_nonce!,
        meta.encrypted_manifest!,
        meta.encrypted_manifest_nonce!,
        ciphertext,
      );
      const blob = new Blob([plaintext as BlobPart], { type: manifest.mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = manifest.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    } finally {
      downloading.value = false;
    }
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
    refresh,
    upload,
    download,
    remove,
  };
});
