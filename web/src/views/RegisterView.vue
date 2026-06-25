<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useConfigStore } from "@/stores/config";

const auth = useAuthStore();
const config = useConfigStore();
const router = useRouter();

const username = ref("");
const password = ref("");
const confirm = ref("");
const error = ref<string | null>(null);
const loading = ref(false);

async function submit() {
  error.value = null;
  if (password.value !== confirm.value) {
    error.value = "Passwords do not match.";
    return;
  }
  loading.value = true;
  try {
    await auth.register({ username: username.value, password: password.value });
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
      <template v-if="config.loaded && !config.allowRegistration">
        <h1>Registration disabled</h1>
        <p class="muted">
          This instance is not accepting new accounts. Ask the operator to
          create one for you, or sign in if you already have one.
        </p>
        <p class="muted">
          <RouterLink :to="{ name: 'login' }">Sign in</RouterLink>
        </p>
      </template>
      <template v-else>
        <h1>Create account</h1>
        <p class="muted">
          We derive a master encryption key from your password in the browser.
          Lose the password and your data is unrecoverable - there is no reset.
        </p>

        <form @submit.prevent="submit">
          <label>
            Username
            <input
              v-model="username"
              type="text"
              autocomplete="username"
              pattern="[a-z0-9_-]{3,32}"
              title="3-32 chars: lowercase letters, digits, underscore, hyphen"
              required
              :disabled="loading"
            />
          </label>
          <label>
            Password
            <input v-model="password" type="password" autocomplete="new-password" required :disabled="loading" />
          </label>
          <label>
            Confirm password
            <input v-model="confirm" type="password" autocomplete="new-password" required :disabled="loading" />
          </label>

          <button type="submit" :disabled="loading">
            {{ loading ? "Creating..." : "Create account" }}
          </button>

          <p v-if="error" class="error">{{ error }}</p>
        </form>

        <p class="muted">
          Already registered?
          <RouterLink :to="{ name: 'login' }">Sign in</RouterLink>
        </p>
      </template>
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
