<script setup lang="ts">
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "@/stores/auth";
import { useConfigStore } from "@/stores/config";
import { AlertTriangle } from "lucide-vue-next";
import DfInput from "@/components/ui/DfInput.vue";
import DfButton from "@/components/ui/DfButton.vue";
import DfBadge from "@/components/ui/DfBadge.vue";

const { t } = useI18n();
const auth = useAuthStore();
const config = useConfigStore();
const router = useRouter();
const username = ref("");
const password = ref("");
const confirmPwd = ref("");
const error = ref<string | null>(null);
const loading = ref(false);

const mismatch = computed(() => confirmPwd.value.length > 0 && password.value !== confirmPwd.value);

async function submit() {
  error.value = null;
  if (password.value !== confirmPwd.value) {
    error.value = t("auth.mismatch");
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
  <main class="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-soft to-bg p-4 dark:from-brand/10">
    <div class="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-md">
      <template v-if="config.loaded && !config.allowRegistration">
        <h1 class="mb-2 text-xl font-bold text-fg">{{ t("auth.regClosed") }}</h1>
        <p class="mb-4 text-sm text-fg-muted">{{ t("auth.regClosedBody") }}</p>
        <DfButton variant="ghost" @click="router.push({ name: 'login' })">{{ t("auth.signIn") }}</DfButton>
      </template>
      <template v-else>
        <h1 class="mb-1 text-2xl font-extrabold text-brand">{{ t("auth.createAccount") }}</h1>
        <p class="mb-3 flex items-center gap-1.5">
          <DfBadge variant="warn"><AlertTriangle class="mr-1 inline h-3 w-3" />{{ t("auth.warnTitle") }}</DfBadge>
        </p>
        <p class="mb-5 text-sm text-fg-muted">{{ t("auth.warnBody") }}</p>
        <form class="flex flex-col gap-3" @submit.prevent="submit">
          <DfInput v-model="username" :label="t('auth.username')" autocomplete="username" :placeholder="t('auth.usernameHint')" :disabled="loading" />
          <DfInput v-model="password" :label="t('auth.password')" type="password" autocomplete="new-password" :disabled="loading" />
          <DfInput v-model="confirmPwd" :label="t('auth.confirmPassword')" type="password" autocomplete="new-password" :error="mismatch ? t('auth.mismatch') : undefined" :disabled="loading" />
          <DfButton type="submit" data-testid="register-submit" :loading="loading" :disabled="loading">{{ loading ? t("auth.creating") : t("auth.createAccount") }}</DfButton>
          <p v-if="error" class="text-sm text-danger">{{ error }}</p>
        </form>
        <p class="mt-5 text-center text-sm text-fg-muted">
          {{ t("auth.haveAccount") }}<RouterLink :to="{ name: 'login' }" class="font-medium text-brand">{{ t("auth.signIn") }}</RouterLink>
        </p>
      </template>
    </div>
  </main>
</template>
