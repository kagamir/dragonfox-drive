import { defineStore } from "pinia";
import { ref } from "vue";

import { filesApi } from "@/api/files";
import type { FileMeta } from "@/api/types";

export const useFilesStore = defineStore("files", () => {
  const files = ref<FileMeta[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await filesApi.list();
      files.value = res.files;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  return { files, loading, error, refresh };
});
