<!-- web/src/components/UpdatePrompt.vue -->
<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { storeToRefs } from "pinia";
import { useIntegrityStore } from "@/stores/integrity";
import { useToast } from "@/composables/useToast";
import DfModal from "@/components/ui/DfModal.vue";
import DfButton from "@/components/ui/DfButton.vue";

const RELEASES_URL = "https://github.com/kagamir/dragonfox-drive/releases";

const { t } = useI18n();
const store = useIntegrityStore();
const { updateAvailable, pinned, latestHash, applying } = storeToRefs(store);
const toast = useToast();

// Local "not now" dismissal — hides the dialog until the next check/reload
// without recording the version as ignored.
const dismissed = ref(false);
const open = computed(() => updateAvailable.value && !dismissed.value);

const short = (h: string | null | undefined) => (h ? h.slice(0, 16) + "…" : "—");

async function onUpdate() {
  try {
    await store.applyUpdate(); // reloads on success
  } catch {
    toast.error(t("integrity.updateFailed"));
  }
}
function onNotNow() {
  dismissed.value = true;
}
function onIgnore() {
  if (latestHash.value) store.ignoreVersion(latestHash.value);
}
</script>

<template>
  <DfModal :open="open" :title="t('integrity.updateTitle')" size="md" @close="onNotNow">
    <p class="mb-4 text-sm text-fg-muted">{{ t("integrity.updateBody") }}</p>
    <dl class="mb-4 space-y-2 text-sm">
      <div class="flex justify-between gap-4">
        <dt class="text-fg-muted">{{ t("integrity.currentVersion") }}</dt>
        <dd class="font-mono text-fg" :title="pinned?.buildHash">{{ short(pinned?.buildHash) }}</dd>
      </div>
      <div class="flex justify-between gap-4">
        <dt class="text-fg-muted">{{ t("integrity.newVersion") }}</dt>
        <dd class="font-mono text-fg" :title="latestHash ?? ''">{{ short(latestHash) }}</dd>
      </div>
    </dl>
    <a :href="RELEASES_URL" target="_blank" rel="noopener noreferrer"
       class="mb-4 inline-block text-sm text-brand hover:underline">
      {{ t("integrity.verifyLink") }}
    </a>
    <div class="mt-2 flex flex-wrap justify-end gap-2">
      <DfButton variant="ghost" data-test="ignore" @click="onIgnore">{{ t("integrity.ignore") }}</DfButton>
      <DfButton variant="ghost" data-test="not-now" @click="onNotNow">{{ t("integrity.notNow") }}</DfButton>
      <DfButton data-test="update" :loading="applying" @click="onUpdate">{{ t("integrity.update") }}</DfButton>
    </div>
  </DfModal>
</template>
