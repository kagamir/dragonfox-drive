<script setup lang="ts">
import { ref } from "vue";
import { onClickOutside } from "@vueuse/core";
import type { Component } from "vue";

export interface ContextItem { label: string; icon?: Component; danger?: boolean; onClick: () => void; }
defineProps<{ items: ContextItem[] }>();

const open = ref(false);
const x = ref(0);
const y = ref(0);
const root = ref<HTMLElement | null>(null);
onClickOutside(root, () => (open.value = false));

function show(e: { preventDefault: () => void; clientX: number; clientY: number }) {
  e.preventDefault();
  x.value = e.clientX;
  y.value = e.clientY;
  open.value = true;
}
function pick(it: ContextItem) {
  it.onClick();
  open.value = false;
}
defineExpose({ show });
</script>

<template>
  <Teleport to="body">
    <div
      v-show="open"
      ref="root"
      data-cm="root"
      :style="{ left: x + 'px', top: y + 'px' }"
      class="fixed z-[55] min-w-[10rem] rounded-lg border border-border bg-surface py-1 shadow-md"
    >
      <button
        v-for="(it, i) in items"
        :key="i"
        @click="pick(it)"
        :class="['flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg', it.danger ? 'text-danger' : 'text-fg']"
      >
        <component v-if="it.icon" :is="it.icon" class="h-4 w-4" />{{ it.label }}
      </button>
    </div>
  </Teleport>
</template>
