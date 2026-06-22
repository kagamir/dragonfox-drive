<script setup lang="ts">
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
</script>

<template>
  <main class="page">
    <header class="bar">
      <RouterLink :to="{ name: 'drive' }">Back</RouterLink>
    </header>
    <section class="content">
      <h1>Settings</h1>
      <div class="card">
        <h2>Account</h2>
        <p>Signed in as <strong>{{ auth.email }}</strong></p>
      </div>
      <div class="card">
        <h2>Devices</h2>
        <p class="muted">Device management will be added in P4.</p>
      </div>
    </section>
  </main>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.bar {
  padding: 0.8rem 1.5rem;
  border-bottom: 1px solid var(--df-color-border);
  background: var(--df-color-bg-elevated);
}
.content {
  padding: 2rem 1.5rem;
  max-width: 800px;
  width: 100%;
  margin: 0 auto;
}
h1 {
  margin: 0 0 1rem;
  font-size: 1.4rem;
}
.card {
  background: var(--df-color-bg-elevated);
  border: 1px solid var(--df-color-border);
  border-radius: var(--df-radius-md);
  padding: 1.25rem;
  margin-bottom: 1rem;
}
.card h2 {
  margin: 0 0 0.5rem;
  font-size: 1.05rem;
}
.muted {
  color: var(--df-color-fg-muted);
}
</style>
