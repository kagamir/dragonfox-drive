import { defineStore } from "pinia";
import { ref } from "vue";
import { sharesApi } from "@/api/shares";
import { cryptoApi, ensureCryptoReady } from "@/workers/crypto";
import { useFilesStore } from "./files";
import { toBase64 } from "@/crypto/file";
import type { ShareListItem } from "@/api/types";

export interface CreatedShare {
  id: string;
  url: string;
}

export const useSharesStore = defineStore("shares", () => {
  const byFile = ref<Record<string, ShareListItem[]>>({});
  const all = ref<ShareListItem[]>([]);
  const creating = ref(false);
  const error = ref<string | null>(null);

  async function load(fileId: string): Promise<void> {
    const res = await sharesApi.listForFile(fileId);
    byFile.value[fileId] = res.shares;
  }

  async function loadAll(): Promise<void> {
    const res = await sharesApi.listAll();
    all.value = res.shares;
  }

  /**
   * Create a share. `opts.password` → password mode (URL has no key); else the
   * key travels in the URL fragment. Returns the share id + full URL.
   */
  async function create(
    fileId: string,
    opts: {
      password?: string;
      expiresAt?: string | null;
      downloadLimit?: number | null;
    },
  ): Promise<CreatedShare> {
    creating.value = true;
    error.value = null;
    try {
      await ensureCryptoReady();
      const files = useFilesStore();
      const meta = files.files.find((f) => f.id === fileId);
      if (!meta || !meta.encrypted_file_key || !meta.encrypted_file_key_nonce) {
        throw new Error("file not found or not uploaded");
      }
      const { fileKey } = await files.unlockFile(meta);

      const { sharePassword, shareSalt } = await cryptoApi.newShareMaterial();
      const pwBytes = opts.password
        ? new TextEncoder().encode(opts.password)
        : sharePassword;
      const shareKey = await cryptoApi.deriveShareKey(pwBytes, shareSalt);
      const wrapped = await cryptoApi.wrapFileKeyForShare(fileKey, shareKey);
      const passwordHash = opts.password ? await cryptoApi.shareVerifier(shareKey) : null;

      const { id } = await sharesApi.create({
        file_id: fileId,
        share_salt: toBase64(shareSalt),
        encrypted_file_key: toBase64(wrapped.ciphertext),
        encrypted_file_key_nonce: toBase64(wrapped.iv),
        password_hash: passwordHash ?? undefined,
        expires_at: opts.expiresAt ?? undefined,
        download_limit: opts.downloadLimit ?? undefined,
      });

      const k = toBase64(pwBytes);
      const url = `${window.location.origin}${window.location.pathname}#/s/${id}${opts.password ? "" : `?k=${k}`}`;
      await load(fileId);
      return { id, url };
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    } finally {
      creating.value = false;
    }
  }

  async function revoke(fileId: string, id: string): Promise<void> {
    await sharesApi.revoke(id);
    await load(fileId);
    await loadAll();
  }

  async function purge(id: string): Promise<void> {
    await sharesApi.purge(id);
    await loadAll();
  }

  return { byFile, all, creating, error, load, loadAll, create, revoke, purge };
});
