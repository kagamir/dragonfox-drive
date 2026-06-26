<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useSharesStore } from "@/stores/shares";
import { useFilesStore } from "@/stores/files";
import { authApi } from "@/api/auth";
import { devicesApi } from "@/api/devices";
import type { DeviceItem } from "@/api/types";
import { relativeTime } from "@/util/time";
import { useConfirm } from "@/composables/useConfirm";
import { useToast } from "@/composables/useToast";
import AppHeader from "@/components/AppHeader.vue";
import DfCard from "@/components/ui/DfCard.vue";
import DfButton from "@/components/ui/DfButton.vue";
import DfBadge from "@/components/ui/DfBadge.vue";
import DfSegmented from "@/components/ui/DfSegmented.vue";
import { Laptop } from "lucide-vue-next";

const auth = useAuthStore();
const shares = useSharesStore();
const files = useFilesStore();
const router = useRouter();
const confirm = useConfirm();
const toast = useToast();

const tab = ref<"account" | "devices" | "shares">("account");
const devices = ref<DeviceItem[]>([]);
const devicesError = ref<string | null>(null);
const busyId = ref<string | null>(null);
const busySignOut = ref(false);

function nameOf(fileId: string): string {
  return files.displayNames[fileId] ?? fileId.slice(0, 8);
}
function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}
function opensOf(s: { download_count: number; download_limit: number | null }): string {
  return s.download_limit ? `${s.download_count}/${s.download_limit}` : `${s.download_count}/∞`;
}
function fileIdOf(id: string): string {
  return shares.all.find((s) => s.id === id)?.file_id ?? "";
}

async function refreshDevices(): Promise<void> {
  try {
    devices.value = await devicesApi.list();
    devicesError.value = null;
  } catch {
    devicesError.value = "加载设备列表失败。";
  }
}

async function onRevokeDevice(id: string): Promise<void> {
  if (!(await confirm.confirm({ message: "吊销此设备？它将立即被登出。", danger: true, confirmText: "吊销" }))) return;
  busyId.value = id;
  try {
    await devicesApi.revoke(id);
    await refreshDevices();
    toast.success("已吊销");
  } catch {
    toast.error("吊销失败");
  } finally {
    busyId.value = null;
  }
}

async function onSignOut(): Promise<void> {
  busySignOut.value = true;
  try {
    try { await authApi.logout(); } catch { /* server may already consider us revoked */ }
    await auth.logout();
    router.push({ name: "login" });
  } finally {
    busySignOut.value = false;
  }
}

async function onRevoke(id: string): Promise<void> {
  if (!(await confirm.confirm({ message: "撤销此分享？链接将立即失效。", danger: true, confirmText: "撤销" }))) return;
  try {
    await shares.revoke(fileIdOf(id), id);
    toast.success("已撤销");
  } catch {
    toast.error("撤销失败");
  }
}

async function onDelete(id: string): Promise<void> {
  if (!(await confirm.confirm({ message: "永久删除此分享记录？此操作无法撤销。", danger: true, confirmText: "删除" }))) return;
  try {
    await shares.purge(id);
    toast.success("已删除");
  } catch {
    toast.error("删除失败");
  }
}

onMounted(async () => {
  await files.refresh();
  await shares.loadAll();
  await refreshDevices();
});
</script>

<template>
  <div class="min-h-screen bg-bg">
    <AppHeader :username="auth.username ?? '我'" active="settings" />
    <main class="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
      <h1 class="mb-4 text-xl font-bold text-fg">设置</h1>
      <DfSegmented
        v-model="tab"
        :options="[
          { value: 'account', label: '账户' },
          { value: 'devices', label: '设备' },
          { value: 'shares', label: '分享' },
        ]"
        class="mb-4"
      />

      <DfCard v-if="tab === 'account'" header="账户">
        <p class="text-sm text-fg">登录身份：<strong>{{ auth.username }}</strong></p>
        <template #footer>
          <DfButton variant="ghost" size="sm" :loading="busySignOut" @click="onSignOut">退出登录</DfButton>
        </template>
      </DfCard>

      <DfCard v-else-if="tab === 'devices'" header="设备">
        <p v-if="devicesError" class="text-sm text-danger">{{ devicesError }}</p>
        <p v-else-if="!devices.length" class="text-sm text-fg-muted">没有已注册设备。</p>
        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="d in devices"
            :key="d.id"
            class="flex items-center gap-3 rounded-lg border border-border p-3"
          >
            <Laptop class="h-5 w-5 text-fg-muted" />
            <div class="min-w-0 flex-1">
              <p class="flex items-center gap-2 text-sm font-medium text-fg">
                {{ d.name }}
                <DfBadge v-if="d.id === auth.deviceId" variant="proc">当前设备</DfBadge>
              </p>
              <p class="text-xs text-fg-muted">最后在线 {{ relativeTime(d.last_seen_at) }}</p>
            </div>
            <DfButton
              v-if="d.id === auth.deviceId"
              variant="ghost"
              size="sm"
              :loading="busySignOut"
              @click="onSignOut"
            >退出登录</DfButton>
            <DfButton
              v-else
              variant="danger"
              size="sm"
              :loading="busyId === d.id"
              @click="onRevokeDevice(d.id)"
            >吊销</DfButton>
          </li>
        </ul>
      </DfCard>

      <DfCard v-else header="分享">
        <p v-if="!shares.all.length" class="text-sm text-fg-muted">暂无分享。</p>
        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="s in shares.all"
            :key="s.id"
            class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-xs"
          >
            <span class="font-medium text-fg">{{ nameOf(s.file_id) }}</span>
            <span class="text-fg-muted">
              创建 {{ fmt(s.created_at) }} · 到期 {{ fmt(s.expires_at) }} · 打开 {{ opensOf(s) }}{{ s.requires_password ? " · 密码" : "" }}
            </span>
            <span class="flex items-center gap-2">
              <DfBadge :variant="s.state === 'active' ? 'ok' : 'neutral'">{{ s.state }}</DfBadge>
              <DfButton variant="ghost" size="sm" :disabled="s.state === 'revoked'" @click="onRevoke(s.id)">撤销</DfButton>
              <DfButton variant="danger" size="sm" @click="onDelete(s.id)">删除</DfButton>
            </span>
          </li>
        </ul>
      </DfCard>
    </main>
  </div>
</template>
