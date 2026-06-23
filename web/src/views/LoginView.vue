<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const router = useRouter();

const username = ref("");
const password = ref("");
const error = ref<string | null>(null);
const loading = ref(false);

async function submit() {
  error.value = null;
  loading.value = true;
  try {
    await auth.login({ username: username.value, password: password.value });
    router.push({ name: "drive" });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="page">
    <div class="card">
      <h1>Sign in</h1>
      <p class="muted">
        Your password is encrypted in the browser before it leaves this device.
      </p>

      <form @submit.prevent="submit">
        <label>
          Username
          <input
            v-model="username"
            type="text"
            autocomplete="username"
            required
            :disabled="loading"
          />
        </label>
        <label>
          Password
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
            :disabled="loading"
          />
        </label>

        <button type="submit" :disabled="loading">
          {{ loading ? "Signing in..." : "Sign in" }}
        </button>

        <p v-if="error" class="error">{{ error }}</p>
      </form>

      <p class="muted">
        No account?
        <RouterLink :to="{ name: 'register' }">Create one</RouterLink>
      </p>
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
  max-width: 380px;
}
h1 {
  margin: 0 0 0.5rem;
  font-size: 1.5rem;
}
.muted {
  color: var(--df-color-fg-muted);
  font-size: 0.85rem;
}
form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 1.5rem 0;
}
label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
}
input {
  padding: 0.5rem 0.6rem;
  border-radius: var(--df-radius-sm);
  border: 1px solid var(--df-color-border);
  background: var(--df-color-bg);
  color: var(--df-color-fg);
  font-size: 0.95rem;
}
button {
  padding: 0.6rem 0.8rem;
  background: var(--df-color-accent);
  color: var(--df-color-accent-fg);
  border: 0;
  border-radius: var(--df-radius-sm);
  cursor: pointer;
  font-weight: 600;
}
button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.error {
  color: #ff6b6b;
  font-size: 0.85rem;
  margin: 0;
}
</style>
