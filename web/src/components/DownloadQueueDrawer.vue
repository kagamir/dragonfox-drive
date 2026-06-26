<script setup lang="ts">
import { X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
defineProps<{ downloads: { fileId: string; name: string; progress: number; phase: string }[] }>();
defineEmits<{ cancel: [string] }>();
const { t } = useI18n();
</script>
<template>
  <Teleport to="body">
    <div v-if="downloads.length" class="fixed bottom-4 right-4 z-[55] w-80 rounded-xl border border-border bg-surface shadow-lg">
      <div class="border-b border-border px-4 py-2.5 text-sm font-semibold text-fg">{{ t("share.download") }} ({{ downloads.length }})</div>
      <ul class="max-h-72 overflow-auto">
        <li v-for="d in downloads" :key="d.fileId" class="flex items-center gap-2 px-4 py-2.5">
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium text-fg">{{ d.name }}</p>
            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-bg">
              <div class="h-full rounded-full bg-brand transition-all" :style="{ width: Math.round(d.progress * 100) + '%' }" />
            </div>
          </div>
          <span class="text-[10px] text-fg-muted">{{ t("downloadPhase." + d.phase) }}</span>
          <button class="text-fg-muted hover:text-danger" @click="$emit('cancel', d.fileId)"><X class="h-4 w-4" /></button>
        </li>
      </ul>
    </div>
  </Teleport>
</template>
