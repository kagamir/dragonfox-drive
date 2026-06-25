<script setup lang="ts">
import { ref } from "vue";
defineProps<{ label: string }>();
const show = ref(false);
function on() { show.value = true; }
function off() { show.value = false; }
</script>
<template>
  <span class="relative inline-flex" @mouseenter="on" @mouseleave="off" @focusin="on" @focusout="off">
    <slot />
    <span
      role="tooltip"
      v-show="show"
      class="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-md"
    >{{ label }}</span>
  </span>
</template>
