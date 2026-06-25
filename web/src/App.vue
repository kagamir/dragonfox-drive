<script setup lang="ts">
import { onMounted } from "vue";
import { useAuthStore } from "@/stores/auth";
import { useConfigStore } from "@/stores/config";
import { onSessionLost } from "@/api/client";

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
  <div v-if="auth.isRestoring" class="app-loading">Loading…</div>
  <RouterView v-else />
</template>

<style scoped>
.app-loading {
  position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--df-color-fg-muted); font-size: 0.95rem;
}
</style>
