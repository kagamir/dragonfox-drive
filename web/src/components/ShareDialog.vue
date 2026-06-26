<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { useSharesStore } from "@/stores/shares";
import { useConfirm } from "@/composables/useConfirm";
import { useToast } from "@/composables/useToast";
import { useClipboard } from "@vueuse/core";
import type { FileMeta } from "@/api/types";
import DfModal from "@/components/ui/DfModal.vue";
import DfButton from "@/components/ui/DfButton.vue";
import DfInput from "@/components/ui/DfInput.vue";

const props = defineProps<{ file: FileMeta }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const shares = useSharesStore();
const confirm = useConfirm();
const toast = useToast();
const { copy: copyToClipboard, copied } = useClipboard({ source: "" });

const password = ref("");
const usePassword = ref(false);
const expiryValue = ref("");
const expiryUnit = ref<"minutes" | "hours" | "days">("days");
const limitInput = ref("");
const createdUrl = ref<string | null>(null);

const existing = computed(() => shares.byFile[props.file.id] ?? []);
const canCreate = computed(() => !shares.creating && (!usePassword.value || password.value.trim().length > 0));

onMounted(() => { void shares.load(props.file.id); });

function expiryTs(): string | null {
  const n = Number(expiryValue.value);
  if (!expiryValue.value || !n || n <= 0) return null;
  const ms = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[expiryUnit.value];
  return new Date(Date.now() + n * ms).toISOString();
}
function limitVal(): number | null {
  const n = Number(limitInput.value);
  return limitInput.value && n > 0 ? n : null;
}

async function onCreate() {
  try {
    const { url } = await shares.create(props.file.id, {
      password: usePassword.value ? password.value : undefined,
      expiresAt: expiryTs(),
      downloadLimit: limitVal(),
    });
    createdUrl.value = url;
    toast.success(t("share.linkCreated"));
  } catch { /* store surfaces error */ }
}

async function doCopy() {
  if (!createdUrl.value) return;
  await copyToClipboard(createdUrl.value);
  toast.success(t("share.copied"));
}

async function onRevoke(id: string) {
  if (!(await confirm.confirm({ message: t("share.revokeConfirm"), danger: true, confirmText: t("share.revoke") }))) return;
  try { await shares.revoke(props.file.id, id); toast.success(t("share.revoked")); }
  catch { toast.error(t("share.revokeFailed")); }
}
async function onDelete(id: string) {
  if (!(await confirm.confirm({ message: t("share.purgeConfirm"), danger: true, confirmText: t("share.purge") }))) return;
  try { await shares.purge(id); await shares.load(props.file.id); toast.success(t("share.deleted")); }
  catch { toast.error(t("share.deleteFailed")); }
}
</script>

<template>
  <DfModal :open="true" :title="t('share.shareTitle', { name: file.id.slice(0, 8) })" size="lg" @close="emit('close')">
    <div class="flex flex-col gap-4">
      <section v-if="!createdUrl" class="flex flex-col gap-3">
        <label class="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" v-model="usePassword" class="accent-brand" data-testid="use-password-toggle" /> {{ t("share.passwordProtect") }}
        </label>
        <DfInput v-if="usePassword" v-model="password" data-testid="share-password" :placeholder="t('share.password')" />

        <div>
          <p class="mb-1 text-sm font-medium text-fg">{{ t("share.expiry") }}</p>
          <div class="flex gap-2">
            <DfInput v-model="expiryValue" type="number" data-testid="expiry-value" :placeholder="t('share.never')" />
            <select v-model="expiryUnit" data-testid="expiry-unit" class="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg">
              <option value="minutes">{{ t("share.minutes") }}</option><option value="hours">{{ t("share.hours") }}</option><option value="days">{{ t("share.days") }}</option>
            </select>
          </div>
        </div>

        <div>
          <p class="mb-1 text-sm font-medium text-fg">{{ t("share.maxOpens") }}</p>
          <DfInput v-model="limitInput" type="number" data-testid="max-opens" :placeholder="t('share.unlimited')" />
        </div>

        <DfButton data-testid="create-share-btn" :disabled="!canCreate || shares.creating" :loading="shares.creating" @click="onCreate">
          {{ shares.creating ? t("share.creating") : t("share.createLink") }}
        </DfButton>
        <p v-if="usePassword && !password.trim()" class="text-xs text-danger">{{ t("share.enterPassword") }}</p>
        <p v-if="shares.error" class="text-xs text-danger">{{ shares.error }}</p>
      </section>

      <section v-else class="flex flex-col gap-3">
        <p class="text-xs text-fg-muted">{{ t("share.linkHint") }}</p>
        <code class="break-all rounded-lg bg-bg p-3 text-xs text-fg">{{ createdUrl }}</code>
        <div class="flex gap-2">
          <DfButton data-testid="copy-link-btn" @click="doCopy">{{ copied ? t("share.copied") : t("common.copy") }}</DfButton>
          <DfButton variant="ghost" data-testid="create-another-btn" @click="createdUrl = null">{{ t("share.createAnother") }}</DfButton>
        </div>
      </section>

      <section v-if="existing.length" class="border-t border-border pt-3">
        <h3 class="mb-2 text-sm font-semibold text-fg">{{ t("share.existing") }}</h3>
        <ul class="flex flex-col gap-1">
          <li v-for="s in existing" :key="s.id" class="flex items-center justify-between gap-2 border-b border-border py-2 last:border-0">
            <span class="text-xs text-fg-muted">{{ s.state }} · {{ t("share.opensCount", { n: s.download_count, limit: s.download_limit ? "/" + s.download_limit : "" }) }}{{ s.requires_password ? " " + t("share.withPassword") : "" }}</span>
            <span class="flex gap-1">
              <DfButton variant="ghost" size="sm" :disabled="s.state === 'revoked'" @click="onRevoke(s.id)">{{ t("share.revoke") }}</DfButton>
              <DfButton variant="danger" size="sm" @click="onDelete(s.id)">{{ t("share.purge") }}</DfButton>
            </span>
          </li>
        </ul>
      </section>
    </div>
  </DfModal>
</template>
