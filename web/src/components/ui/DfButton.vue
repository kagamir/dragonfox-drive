<script setup lang="ts">
import { computed } from "vue";
import DfSpinner from "./DfSpinner.vue";

const props = withDefaults(
  defineProps<{
    variant?: "primary" | "ghost" | "danger" | "subtle";
    size?: "sm" | "md";
    loading?: boolean;
    disabled?: boolean;
    type?: "button" | "submit";
  }>(),
  { variant: "primary", size: "md", loading: false, disabled: false, type: "button" },
);

const variants: Record<string, string> = {
  primary: "bg-brand text-white hover:bg-brand-hover",
  ghost: "bg-surface text-fg border border-border hover:bg-bg",
  danger: "bg-danger text-white hover:opacity-90",
  subtle: "bg-transparent text-fg-muted hover:bg-bg hover:text-fg",
};
const sizes: Record<string, string> = {
  sm: "text-xs px-2.5 py-1.5",
  md: "text-sm px-4 py-2",
};
const cls = computed(() => [
  "inline-flex items-center justify-center gap-1.5 font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed",
  variants[props.variant],
  sizes[props.size],
]);
</script>

<template>
  <button :type="type" :class="cls" :disabled="disabled || loading">
    <DfSpinner v-if="loading" class="w-4 h-4" />
    <slot name="icon" />
    <slot />
  </button>
</template>
