<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
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

const { t } = useI18n();
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
    devicesError.value = t("settings.devicesLoadFailed");
  }
}

async function onRevokeDevice(id: string): Promise<void> {
  if (!(await confirm.confirm({ message: t("settings.revokeDeviceConfirm"), danger: true, confirmText: t("settings.revokeDevice") }))) return;
  busyId.value = id;
  try {
    await devicesApi.revoke(id);
    await refreshDevices();
    toast.success(t("settings.deviceRevoked"));
  } catch {
    toast.error(t("settings.revokeFailed"));
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
  if (!(await confirm.confirm({ message: t("share.revokeConfirm"), danger: true, confirmText: t("share.revoke") }))) return;
  try {
    await shares.revoke(fileIdOf(id), id);
    toast.success(t("share.revoked"));
  } catch {
    toast.error(t("share.revokeFailed"));
  }
}

async function onDelete(id: string): Promise<void> {
  if (!(await confirm.confirm({ message: t("share.purgeConfirm"), danger: true, confirmText: t("share.purge") }))) return;
  try {
    await shares.purge(id);
    toast.success(t("share.deleted"));
  } catch {
    toast.error(t("share.deleteFailed"));
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
    <AppHeader :username="auth.username ?? t('common.me')" active="settings" />
    <main class="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
      <h1 class="mb-4 text-xl font-bold text-fg">{{ t("settings.settings") }}</h1>
      <DfSegmented
        v-model="tab"
        :options="[
          { value: 'account', label: t('settings.account') },
          { value: 'devices', label: t('settings.devices') },
          { value: 'shares', label: t('share.shares') },
        ]"
        class="mb-4"
      />

      <DfCard v-if="tab === 'account'" :header="t('settings.account')">
        <p class="text-sm text-fg">{{ t("settings.signedInAs") }}：<strong>{{ auth.username }}</strong></p>
        <template #footer>
          <DfButton variant="ghost" size="sm" data-testid="sign-out-btn" :loading="busySignOut" @click="onSignOut">{{ t("settings.signOut") }}</DfButton>
        </template>
      </DfCard>

      <DfCard v-else-if="tab === 'devices'" :header="t('settings.devices')">
        <p v-if="devicesError" class="text-sm text-danger">{{ devicesError }}</p>
        <p v-else-if="!devices.length" class="text-sm text-fg-muted">{{ t("settings.noDevices") }}</p>
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
                <DfBadge v-if="d.id === auth.deviceId" variant="proc">{{ t("settings.currentDevice") }}</DfBadge>
              </p>
              <p class="text-xs text-fg-muted">{{ t("settings.lastSeen") }} {{ relativeTime(d.last_seen_at) }}</p>
            </div>
            <DfButton
              v-if="d.id === auth.deviceId"
              variant="ghost"
              size="sm"
              data-testid="sign-out-btn"
              :loading="busySignOut"
              @click="onSignOut"
            >{{ t("settings.signOut") }}</DfButton>
            <DfButton
              v-else
              variant="danger"
              size="sm"
              data-testid="revoke-device-btn"
              :loading="busyId === d.id"
              @click="onRevokeDevice(d.id)"
            >{{ t("settings.revokeDevice") }}</DfButton>
          </li>
        </ul>
      </DfCard>

      <DfCard v-else :header="t('share.shares')">
        <p v-if="!shares.all.length" class="text-sm text-fg-muted">{{ t("settings.noShares") }}</p>
        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="s in shares.all"
            :key="s.id"
            class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-xs"
          >
            <span class="font-medium text-fg">{{ nameOf(s.file_id) }}</span>
            <span class="text-fg-muted">
              {{ t("settings.created") }} {{ fmt(s.created_at) }} · {{ t("settings.expires") }} {{ fmt(s.expires_at) }} · {{ t("settings.opens") }} {{ opensOf(s) }}{{ s.requires_password ? ` · ${t("share.password")}` : "" }}
            </span>
            <span class="flex items-center gap-2">
              <DfBadge :variant="s.state === 'active' ? 'ok' : 'neutral'">{{ s.state }}</DfBadge>
              <DfButton variant="ghost" size="sm" :disabled="s.state === 'revoked'" @click="onRevoke(s.id)">{{ t("share.revoke") }}</DfButton>
              <DfButton variant="danger" size="sm" @click="onDelete(s.id)">{{ t("share.purge") }}</DfButton>
            </span>
          </li>
        </ul>
      </DfCard>
    </main>
  </div>
</template>
