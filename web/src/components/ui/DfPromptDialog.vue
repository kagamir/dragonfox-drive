<script setup lang="ts">
import { ref, watch } from "vue";
import { usePrompt } from "@/composables/usePrompt";
import DfModal from "./DfModal.vue";
import DfButton from "./DfButton.vue";
import DfInput from "./DfInput.vue";

const p = usePrompt();
const value = ref("");

watch(() => p.state.value.open, (open) => {
  if (open) value.value = p.state.value.initial ?? "";
});

function cancel() { p._submit(null); }
function submit() {
  const v = value.value.trim();
  if (v) p._submit(v);
}
</script>
<template>
  <DfModal :open="p.state.value.open" :title="p.state.value.title" @close="cancel">
    <form @submit.prevent="submit">
      <p class="mb-3 text-sm text-fg-muted">{{ p.state.value.message }}</p>
      <DfInput v-model="value" :placeholder="p.state.value.placeholder" autofocus />
      <div class="mt-5 flex justify-end gap-2">
        <DfButton type="button" variant="ghost" size="sm" @click="cancel">{{ p.state.value.cancelText }}</DfButton>
        <DfButton type="submit" size="sm" :disabled="!value.trim()">{{ p.state.value.confirmText }}</DfButton>
      </div>
    </form>
  </DfModal>
</template>
