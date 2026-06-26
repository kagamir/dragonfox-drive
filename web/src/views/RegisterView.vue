<script setup lang="ts">
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useConfigStore } from "@/stores/config";
import { AlertTriangle } from "lucide-vue-next";
import DfInput from "@/components/ui/DfInput.vue";
import DfButton from "@/components/ui/DfButton.vue";
import DfBadge from "@/components/ui/DfBadge.vue";

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
    error.value = "两次密码不一致。";
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
        <h1 class="mb-2 text-xl font-bold text-fg">注册已关闭</h1>
        <p class="mb-4 text-sm text-fg-muted">此实例不接受新账号注册。请联系管理员，或直接登录。</p>
        <DfButton variant="ghost" @click="router.push({ name: 'login' })">返回登录</DfButton>
      </template>
      <template v-else>
        <h1 class="mb-1 text-2xl font-extrabold text-brand">创建账号</h1>
        <p class="mb-3 flex items-center gap-1.5">
          <DfBadge variant="warn"><AlertTriangle class="mr-1 inline h-3 w-3" />重要</DfBadge>
        </p>
        <p class="mb-5 text-sm text-fg-muted">密码在浏览器内派生主加密密钥。忘记密码则数据<b>不可恢复</b>。</p>
        <form class="flex flex-col gap-3" @submit.prevent="submit">
          <DfInput v-model="username" label="用户名" autocomplete="username" placeholder="3-32 字符：小写字母/数字/_/-" :disabled="loading" />
          <DfInput v-model="password" label="密码" type="password" autocomplete="new-password" :disabled="loading" />
          <DfInput v-model="confirmPwd" label="确认密码" type="password" autocomplete="new-password" :error="mismatch ? '两次密码不一致' : undefined" :disabled="loading" />
          <DfButton type="submit" :loading="loading" :disabled="loading">{{ loading ? "创建中…" : "创建账号" }}</DfButton>
          <p v-if="error" class="text-sm text-danger">{{ error }}</p>
        </form>
        <p class="mt-5 text-center text-sm text-fg-muted">
          已有账号？<RouterLink :to="{ name: 'login' }" class="font-medium text-brand">登录</RouterLink>
        </p>
      </template>
    </div>
  </main>
</template>
