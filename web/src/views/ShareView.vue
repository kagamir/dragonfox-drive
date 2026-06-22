<script setup lang="ts">
import { useRoute } from "vue-router";
const route = useRoute();
</script>

<template>
  <main class="page">
    <div class="card">
      <h1>Shared file</h1>
      <p class="muted">Share ID: <code>{{ route.params.shareId }}</code></p>
      <p class="muted">Public link sharing arrives in P3.</p>
    </div>
  </main>
</template>

<style scoped>
.page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 1rem;
}
.card {
  background: var(--df-color-bg-elevated);
  border: 1px solid var(--df-color-border);
  border-radius: var(--df-radius-md);
  padding: 2rem;
  width: 100%;
  max-width: 420px;
  text-align: center;
}
h1 {
  margin: 0 0 1rem;
}
.muted {
  color: var(--df-color-fg-muted);
}
code {
  font-family: ui-monospace, SFMono-Regular, monospace;
}
</style>
