<script setup lang="ts">
import { computed } from "vue";
const props = defineProps<{ variant?: "neutral" | "ok" | "warn" | "err" | "proc" }>();
const map: Record<string, string> = {
  neutral: "bg-fg-muted/15 text-fg-muted",
  ok: "bg-success/15 text-success",
  warn: "bg-warning/15 text-warning",
  err: "bg-danger/15 text-danger",
  proc: "bg-brand/15 text-brand",
};
const cls = computed(() => [
  "inline-flex items-center text-xs font-semibold px-2.5 py-0.5 rounded-full",
  map[props.variant ?? "neutral"],
]);
</script>
<template><span :class="cls"><slot /></span></template>
