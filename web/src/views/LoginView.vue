<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "@/stores/auth";
import { useConfigStore } from "@/stores/config";
import { useTheme } from "@/composables/useTheme";
import { Sun, Moon, Monitor, Lock } from "lucide-vue-next";
import DfInput from "@/components/ui/DfInput.vue";
import DfButton from "@/components/ui/DfButton.vue";

const { t } = useI18n();
const auth = useAuthStore();
const config = useConfigStore();
const router = useRouter();
const theme = useTheme();
const themeStore = theme.store;
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

const themeIcon = { light: Sun, dark: Moon, auto: Monitor } as const;
function cycleTheme() {
  const order = ["light", "dark", "auto"] as const;
  const cur = themeStore.value as (typeof order)[number];
  themeStore.value = order[(order.indexOf(cur) + 1) % order.length];
}
</script>

<template>
  <main class="relative flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-soft to-bg p-4 dark:from-brand/10">
    <button class="absolute right-4 top-4 rounded-lg p-2 text-fg-muted hover:bg-bg hover:text-fg" data-testid="theme-cycle-btn" :aria-label="t('theme.toggle', { mode: t('theme.' + (themeStore as string)) })" @click="cycleTheme">
      <component :is="themeIcon[themeStore as keyof typeof themeIcon]" class="h-5 w-5" />
    </button>
    <div class="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-md">
      <h1 class="mb-1 text-2xl font-extrabold text-brand">🦊 {{ t("common.appName") }}</h1>
      <p class="mb-6 flex items-center gap-1.5 text-sm text-fg-muted">
        <Lock class="h-3.5 w-3.5" /> {{ t("auth.tagline") }}
      </p>
      <form class="flex flex-col gap-3" @submit.prevent="submit">
        <DfInput v-model="username" :label="t('auth.username')" autocomplete="username" :disabled="loading" />
        <DfInput v-model="password" :label="t('auth.password')" type="password" autocomplete="current-password" :disabled="loading" />
        <DfButton type="submit" data-testid="login-submit" :loading="loading" :disabled="loading">{{ loading ? t("auth.signingIn") : t("auth.signIn") }}</DfButton>
        <p v-if="error" class="text-sm text-danger">{{ error }}</p>
      </form>
      <p v-if="config.allowRegistration" class="mt-5 text-center text-sm text-fg-muted">
        {{ t("auth.noAccount") }}<RouterLink :to="{ name: 'register' }" class="font-medium text-brand">{{ t("auth.createOne") }}</RouterLink>
      </p>
    </div>
  </main>
</template>
