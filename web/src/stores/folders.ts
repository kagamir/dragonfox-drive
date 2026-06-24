import { defineStore } from "pinia";
import { ref, computed } from "vue";

import { foldersApi } from "@/api/folders";
import { cryptoApi, ensureCryptoReady } from "@/workers/crypto";
import { useAuthStore } from "./auth";
import { useFilesStore } from "./files";
import { fromBase64, toBase64 } from "@/crypto/file";
import type {
  CreateFolderRequest,
  DeleteFolderRequest,
  FolderInfo,
  PatchFolderRequest,
} from "@/api/types";
import type { FileMeta } from "@/api/types";

export interface FolderNode {
  id: string;
  parentId: string | null;
  folderKey: Uint8Array;
  name: string;
  createdAt: string;
}

export interface FolderEntry {
  kind: "folder";
  folder: FolderNode;
}
export interface FileEntry {
  kind: "file";
  file: FileMeta;
}
export type TreeEntry = FolderEntry | FileEntry;

const PAGE_SIZE = 50;

export const useFoldersStore = defineStore("folders", () => {
  const folders = ref<FolderNode[]>([]);
  const currentFolderId = ref<string | null>(null);
  const page = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);

  function masterKey(): Uint8Array {
    const key = useAuthStore().masterKey;
    if (!key) throw new Error("not unlocked — master key missing");
    return key;
  }

  const byId = computed(() => {
    const m = new Map<string, FolderNode>();
    for (const f of folders.value) m.set(f.id, f);
    return m;
  });

  function folderKeyOf(id: string): Uint8Array | undefined {
    return byId.value.get(id)?.folderKey;
  }

  const breadcrumbs = computed<FolderNode[]>(() => {
    const path: FolderNode[] = [];
    let cur = currentFolderId.value ? byId.value.get(currentFolderId.value) ?? null : null;
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? byId.value.get(cur.parentId) ?? null : null;
    }
    return path;
  });

  const childrenFolders = computed(() =>
    folders.value
      .filter((f) => f.parentId === currentFolderId.value)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  const combinedChildren = computed<TreeEntry[]>(() => {
    const filesStore = useFilesStore();
    const folderRows: FolderEntry[] = childrenFolders.value.map((folder) => ({ kind: "folder", folder }));
    const fileRows: FileEntry[] = filesStore
      .filesWithParent(currentFolderId.value)
      .map((file) => ({ kind: "file", file }));
    return [...folderRows, ...fileRows];
  });

  const totalPages = computed(() =>
    Math.max(1, Math.ceil(combinedChildren.value.length / PAGE_SIZE)),
  );

  const paginatedView = computed<TreeEntry[]>(() => {
    const start = page.value * PAGE_SIZE;
    return combinedChildren.value.slice(start, start + PAGE_SIZE);
  });

  async function loadTree(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await ensureCryptoReady();
      const mk = masterKey();
      const { folders: rows } = await foldersApi.list();

      // 1. decrypt parent ids with master_key
      const shape: { row: FolderInfo; parentId: string | null }[] = [];
      for (const row of rows) {
        const parentId =
          row.encrypted_parent_id && row.encrypted_parent_id_nonce
            ? await cryptoApi.decryptParentId(
                mk,
                fromBase64(row.encrypted_parent_id),
                fromBase64(row.encrypted_parent_id_nonce),
              )
            : null;
        shape.push({ row, parentId });
      }

      // 2. orphan recovery: parent not present → root
      const idSet = new Set(rows.map((r) => r.id));
      for (const s of shape) {
        if (s.parentId && !idSet.has(s.parentId)) s.parentId = null;
      }

      // 3. BFS the key-wrap chain from roots
      const childrenOf = new Map<string | null, string[]>();
      for (const s of shape) {
        const arr = childrenOf.get(s.parentId) ?? [];
        arr.push(s.row.id);
        childrenOf.set(s.parentId, arr);
      }
      const keyById = new Map<string, Uint8Array>();
      const nameById = new Map<string, string>();
      const queue: (string | null)[] = [null];
      const processed = new Set<string>();
      while (queue.length) {
        const parent = queue.shift()!;
        for (const cid of childrenOf.get(parent) ?? []) {
          if (processed.has(cid)) continue;
          processed.add(cid);
          const s = shape.find((x) => x.row.id === cid)!;
          const wrapperKey = parent === null ? mk : keyById.get(parent)!;
          const folderKey = await cryptoApi.unwrapFolderKey(
            {
              ciphertext: fromBase64(s.row.encrypted_folder_key),
              iv: fromBase64(s.row.encrypted_folder_key_nonce),
            },
            wrapperKey,
          );
          keyById.set(cid, folderKey);
          const name = await cryptoApi.decryptFolderName(
            folderKey,
            fromBase64(s.row.encrypted_name),
            fromBase64(s.row.encrypted_name_nonce),
          );
          nameById.set(cid, name);
          queue.push(cid);
        }
      }

      folders.value = shape.map((s) => ({
        id: s.row.id,
        parentId: s.parentId,
        folderKey: keyById.get(s.row.id)!,
        name: nameById.get(s.row.id) ?? "(encrypted)",
        createdAt: s.row.created_at,
      }));

      if (page.value > totalPages.value - 1) page.value = totalPages.value - 1;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  function navigateTo(folderId: string | null): void {
    currentFolderId.value = folderId;
    page.value = 0;
  }

  function setPage(n: number): void {
    page.value = Math.min(Math.max(0, n), totalPages.value - 1);
  }

  async function createFolder(name: string): Promise<void> {
    error.value = null;
    try {
      await ensureCryptoReady();
      const mk = masterKey();
      const folderKey = await cryptoApi.newFolderKey();
      const parentId = currentFolderId.value;
      let wrapperKey: Uint8Array;
      if (parentId === null) {
        wrapperKey = mk;
      } else {
        const pk = folderKeyOf(parentId);
        if (!pk) throw new Error("current folder key not available");
        wrapperKey = pk;
      }
      const wrapped = await cryptoApi.wrapFolderKey(folderKey, wrapperKey);
      const nameEnc = await cryptoApi.encryptFolderName(folderKey, name);
      const parentEnc = await cryptoApi.encryptParentId(mk, parentId);
      const body: CreateFolderRequest = {
        encrypted_parent_id: parentEnc ? toBase64(parentEnc.ciphertext) : null,
        encrypted_parent_id_nonce: parentEnc ? toBase64(parentEnc.iv) : null,
        encrypted_folder_key: toBase64(wrapped.ciphertext),
        encrypted_folder_key_nonce: toBase64(wrapped.iv),
        encrypted_name: toBase64(nameEnc.ciphertext),
        encrypted_name_nonce: toBase64(nameEnc.iv),
      };
      const { id } = await foldersApi.create(body);
      folders.value = [
        ...folders.value,
        { id, parentId, folderKey, name, createdAt: new Date().toISOString() },
      ];
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    }
  }

  async function renameFolder(id: string, newName: string): Promise<void> {
    const node = byId.value.get(id);
    if (!node) throw new Error("folder not found");
    const enc = await cryptoApi.encryptFolderName(node.folderKey, newName);
    await foldersApi.patch(id, {
      encrypted_name: toBase64(enc.ciphertext),
      encrypted_name_nonce: toBase64(enc.iv),
    });
    folders.value = folders.value.map((f) => (f.id === id ? { ...f, name: newName } : f));
  }

  function isDescendant(candidateId: string, ancestorId: string): boolean {
    let cur = byId.value.get(candidateId) ?? null;
    while (cur) {
      if (cur.id === ancestorId) return true;
      cur = cur.parentId ? byId.value.get(cur.parentId) ?? null : null;
    }
    return false;
  }

  async function moveFolder(id: string, newParentId: string | null): Promise<void> {
    if (newParentId !== null && isDescendant(newParentId, id)) {
      throw new Error("cannot move a folder into itself or its own descendant");
    }
    const mk = masterKey();
    const node = byId.value.get(id);
    if (!node) throw new Error("folder not found");
    let wrapperKey: Uint8Array;
    if (newParentId === null) {
      wrapperKey = mk;
    } else {
      const pk = folderKeyOf(newParentId);
      if (!pk) throw new Error("target folder key not available");
      wrapperKey = pk;
    }
    const wrapped = await cryptoApi.wrapFolderKey(node.folderKey, wrapperKey);
    const parentEnc = await cryptoApi.encryptParentId(mk, newParentId);
    const body: PatchFolderRequest = {
      encrypted_parent_id: parentEnc ? toBase64(parentEnc.ciphertext) : null,
      encrypted_parent_id_nonce: parentEnc ? toBase64(parentEnc.iv) : null,
      encrypted_folder_key: toBase64(wrapped.ciphertext),
      encrypted_folder_key_nonce: toBase64(wrapped.iv),
    };
    await foldersApi.patch(id, body);
    folders.value = folders.value.map((f) =>
      f.id === id ? { ...f, parentId: newParentId } : f,
    );
  }

  async function deleteFolder(id: string): Promise<void> {
    const folderIds = new Set<string>([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const f of folders.value) {
        if (f.parentId === cur && !folderIds.has(f.id)) {
          folderIds.add(f.id);
          stack.push(f.id);
        }
      }
    }
    const filesStore = useFilesStore();
    const fileIds = new Set<string>();
    for (const fid of folderIds) {
      for (const file of filesStore.filesWithParent(fid)) {
        fileIds.add(file.id);
      }
    }
    const body: DeleteFolderRequest = {
      folder_ids: [...folderIds],
      file_ids: [...fileIds],
    };
    await foldersApi.remove(id, body);
    folders.value = folders.value.filter((f) => !folderIds.has(f.id));
    await filesStore.refresh();
    if (currentFolderId.value && folderIds.has(currentFolderId.value)) {
      navigateTo(null);
    }
  }

  return {
    folders,
    currentFolderId,
    page,
    loading,
    error,
    breadcrumbs,
    totalPages,
    paginatedView,
    loadTree,
    navigateTo,
    setPage,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
    folderKeyOf,
  };
});
