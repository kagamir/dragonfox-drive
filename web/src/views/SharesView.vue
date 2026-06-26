<script setup lang="ts">
import { onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "@/stores/auth";
import { useSharesStore } from "@/stores/shares";
import { useFilesStore } from "@/stores/files";
import { useConfirm } from "@/composables/useConfirm";
import { useToast } from "@/composables/useToast";
import AppHeader from "@/components/AppHeader.vue";
import DfButton from "@/components/ui/DfButton.vue";
import DfBadge from "@/components/ui/DfBadge.vue";
import DfEmpty from "@/components/ui/DfEmpty.vue";

const auth = useAuthStore();
const shares = useSharesStore();
const files = useFilesStore();
const confirm = useConfirm();
const toast = useToast();
const { t } = useI18n();

function nameOf(fileId: string) {
  return files.displayNames[fileId] ?? fileId.slice(0, 8);
}
function fileIdOf(id: string) {
  return shares.all.find((s) => s.id === id)?.file_id ?? "";
}
function opensOf(s: { download_count: number; download_limit: number | null }) {
  return s.download_limit ? `${s.download_count}/${s.download_limit}` : `${s.download_count}/∞`;
}
async function onRevoke(id: string) {
  if (!(await confirm.confirm({ message: t("share.revokeConfirm"), danger: true, confirmText: t("share.revoke") }))) return;
  try {
    await shares.revoke(fileIdOf(id), id);
    toast.success(t("share.revoked"));
  } catch {
    toast.error(t("share.revokeFailed"));
  }
}
async function onDelete(id: string) {
  if (!(await confirm.confirm({ message: t("share.purgeConfirm"), danger: true, confirmText: t("common.delete") }))) return;
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
});
</script>

<template>
  <div class="min-h-screen bg-bg">
    <AppHeader :username="auth.username ?? t('common.me')" active="shares" />
    <main class="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
      <h1 class="mb-4 text-xl font-bold text-fg">{{ t("share.shares") }}</h1>
      <DfEmpty v-if="!shares.all.length" :title="t('share.noShares')" />
      <ul v-else class="flex flex-col gap-2">
        <li
          v-for="s in shares.all"
          :key="s.id"
          class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-3 text-xs"
        >
          <span class="font-medium text-fg">{{ nameOf(s.file_id) }}</span>
          <span class="text-fg-muted">{{ opensOf(s) }}{{ s.requires_password ? " · " + t("share.withPassword") : "" }}</span>
          <span class="flex items-center gap-2">
            <DfBadge :variant="s.state === 'active' ? 'ok' : 'neutral'">{{ s.state }}</DfBadge>
            <DfButton variant="ghost" size="sm" :disabled="s.state === 'revoked'" @click="onRevoke(s.id)">{{ t("share.revoke") }}</DfButton>
            <DfButton variant="danger" size="sm" @click="onDelete(s.id)">{{ t("share.purge") }}</DfButton>
          </span>
        </li>
      </ul>
    </main>
  </div>
</template>
