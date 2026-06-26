<script setup lang="ts">
import { onMounted } from "vue";
import { useAuthStore } from "@/stores/auth";
import { useConfigStore } from "@/stores/config";
import { onSessionLost } from "@/api/client";
import DfToastContainer from "@/components/ui/DfToastContainer.vue";
import DfConfirmDialog from "@/components/ui/DfConfirmDialog.vue";
import DfPromptDialog from "@/components/ui/DfPromptDialog.vue";

const auth = useAuthStore();
const config = useConfigStore();

onMounted(() => {
  // Register the session-lost handler first, before any auth work, so a
  // refresh-token failure observed by client.ts (on an authenticated
  // request) is propagated to the store.
  onSessionLost(() => auth.logout());
  // Try to restore session from IndexedDB (device-level key path).
  void auth.tryRestoreSession();
  // Pull public runtime flags (e.g. allow_registration) for the pre-auth UI.
  void config.load();
});
</script>

<template>
  <div v-if="auth.isRestoring" class="fixed inset-0 flex items-center justify-center bg-bg">
    <div class="flex flex-col items-center gap-3 text-fg-muted">
      <span class="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      <span class="text-sm">正在加载…</span>
    </div>
  </div>
  <template v-else>
    <RouterView />
    <DfToastContainer />
    <DfConfirmDialog />
    <DfPromptDialog />
  </template>
</template>
