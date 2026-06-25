<script setup lang="ts">
import { ChevronRight } from "lucide-vue-next";
defineProps<{ items: { id: string | null; label: string }[] }>();
defineEmits<{ navigate: [string | null] }>();
</script>
<template>
  <nav class="flex items-center gap-1 text-sm">
    <template v-for="(it, i) in items" :key="i">
      <button
        v-if="i < items.length - 1"
        @click="$emit('navigate', it.id)"
        class="text-fg-muted transition-colors hover:text-brand"
      >{{ it.label }}</button>
      <span v-else class="font-semibold text-fg">{{ it.label }}</span>
      <ChevronRight v-if="i < items.length - 1" class="h-3.5 w-3.5 text-fg-muted/60" />
    </template>
  </nav>
</template>
