<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useFilesStore } from "@/stores/files";

const auth = useAuthStore();
const files = useFilesStore();
const router = useRouter();

onMounted(() => {
  void files.refresh();
});

function signOut() {
  void auth.logout().then(() => router.push({ name: "login" }));
}
</script>

<template>
  <main class="page">
    <header class="bar">
      <div class="brand">
        <span class="logo"> DragonFox Drive </span>
      </div>
      <nav>
        <RouterLink :to="{ name: 'drive' }">My files</RouterLink>
        <RouterLink :to="{ name: 'settings' }">Settings</RouterLink>
        <button class="link" @click="signOut">Sign out</button>
      </nav>
    </header>

    <section class="content">
      <h1>Your encrypted files</h1>
      <p class="muted" v-if="!files.files.length && !files.loading">
        No files yet. Upload will arrive in P2.
      </p>

      <ul class="list" v-if="files.files.length">
        <li v-for="f in files.files" :key="f.id">
          <span class="name">{{ f.id }}</span>
          <span class="meta"
            >{{ f.total_size }} bytes · {{ f.status }}</span
          >
        </li>
      </ul>
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.8rem 1.5rem;
  border-bottom: 1px solid var(--df-color-border);
  background: var(--df-color-bg-elevated);
}
.brand .logo {
  font-weight: 700;
  letter-spacing: 0.02em;
}
nav {
  display: flex;
  gap: 1rem;
  align-items: center;
}
nav a {
  color: var(--df-color-fg-muted);
}
nav a.router-link-active {
  color: var(--df-color-fg);
}
.link {
  background: transparent;
  color: var(--df-color-fg-muted);
  border: 0;
  cursor: pointer;
  padding: 0;
}
.content {
  padding: 2rem 1.5rem;
  max-width: 1100px;
  width: 100%;
  margin: 0 auto;
}
h1 {
  margin: 0 0 1rem;
  font-size: 1.4rem;
}
.muted {
  color: var(--df-color-fg-muted);
}
.list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.list li {
  background: var(--df-color-bg-elevated);
  border: 1px solid var(--df-color-border);
  border-radius: var(--df-radius-sm);
  padding: 0.7rem 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.name {
  font-weight: 600;
}
.meta {
  color: var(--df-color-fg-muted);
  font-size: 0.8rem;
}
</style>
