<script setup lang="ts">
import { useConfirm } from "@/composables/useConfirm";
import DfModal from "./DfModal.vue";
import DfButton from "./DfButton.vue";

const c = useConfirm();
function cancel() { c._resolve(false); }
function ok() { c._resolve(true); }
</script>
<template>
  <DfModal :open="c.state.value.open" :title="c.state.value.title" @close="cancel">
    <p class="text-sm text-fg-muted">{{ c.state.value.message }}</p>
    <div class="mt-5 flex justify-end gap-2">
      <DfButton variant="ghost" size="sm" @click="cancel">{{ c.state.value.cancelText }}</DfButton>
      <DfButton :variant="c.state.value.danger ? 'danger' : 'primary'" size="sm" @click="ok">
        {{ c.state.value.confirmText }}
      </DfButton>
    </div>
  </DfModal>
</template>
