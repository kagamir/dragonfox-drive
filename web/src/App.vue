<script setup lang="ts">
import { onMounted } from "vue";
import { useAuthStore } from "@/stores/auth";
import { useConfigStore } from "@/stores/config";

const auth = useAuthStore();
const config = useConfigStore();

onMounted(() => {
  // Try to restore session from IndexedDB (device-level key path).
  void auth.tryRestoreSession();
  // Pull public runtime flags (e.g. allow_registration) for the pre-auth UI.
  void config.load();
});
</script>

<template>
  <RouterView />
</template>

<style scoped></style>
