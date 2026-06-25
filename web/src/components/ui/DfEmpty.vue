<script setup lang="ts">
import { Inbox } from "lucide-vue-next";
defineProps<{ title: string; description?: string }>();
</script>
<template>
  <div class="flex flex-col items-center justify-center gap-3 py-14 text-center">
    <Inbox class="w-12 h-12 text-fg-muted/40" />
    <p class="text-base font-semibold text-fg">{{ title }}</p>
    <p v-if="description" class="text-sm text-fg-muted">{{ description }}</p>
    <slot name="action" />
  </div>
</template>
