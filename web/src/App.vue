<script setup lang="ts">
import { onMounted } from "vue";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();

onMounted(() => {
  // Try to restore session from IndexedDB (device-level key path).
  void auth.tryRestoreSession();
});
</script>

<template>
  <RouterView />
</template>

<style scoped></style>
