<script setup lang="ts">
import { onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { storeToRefs } from "pinia";
import { useAuthStore } from "@/stores/auth";
import { useConfigStore } from "@/stores/config";
import { onSessionLost } from "@/api/client";
import { useToast } from "@/composables/useToast";
import { useIntegrityStore } from "@/stores/integrity";
import DfToastContainer from "@/components/ui/DfToastContainer.vue";
import DfConfirmDialog from "@/components/ui/DfConfirmDialog.vue";
import DfPromptDialog from "@/components/ui/DfPromptDialog.vue";
import UpdatePrompt from "@/components/UpdatePrompt.vue";

const { t } = useI18n();
const auth = useAuthStore();
const config = useConfigStore();

const integrity = useIntegrityStore();
const toast = useToast();
const { firstPin } = storeToRefs(integrity);
watch(firstPin, (v) => {
  if (v) toast.info(t("integrity.pinnedToast"), 8000);
});

onMounted(() => {
  // Register the session-lost handler first, before any auth work, so a
  // refresh-token failure observed by client.ts (on an authenticated
  // request) is propagated to the store.
  onSessionLost(() => auth.logout());
  // Session restore is kicked off in main.ts (before mount) so the router
  // guard can await it; nothing to do here.
  // Pull public runtime flags (e.g. allow_registration) for the pre-auth UI.
  void config.load();
});
</script>

<template>
  <div v-if="auth.isRestoring" class="fixed inset-0 flex items-center justify-center bg-bg">
    <div class="flex flex-col items-center gap-3 text-fg-muted">
      <span class="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      <span class="text-sm">{{ t("common.loading") }}</span>
    </div>
  </div>
  <template v-else>
    <RouterView />
    <DfToastContainer />
    <DfConfirmDialog />
    <DfPromptDialog />
    <UpdatePrompt />
  </template>
</template>
