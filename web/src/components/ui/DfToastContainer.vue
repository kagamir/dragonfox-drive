<script setup lang="ts">
import { CheckCircle2, Info, AlertTriangle, XCircle, X } from "lucide-vue-next";
import { useToast, type ToastType } from "@/composables/useToast";
const toast = useToast();
const icons = { success: CheckCircle2, info: Info, warning: AlertTriangle, error: XCircle };
const colors: Record<ToastType, string> = {
  success: "text-success",
  info: "text-brand",
  warning: "text-warning",
  error: "text-danger",
};
</script>
<template>
  <Teleport to="body">
    <div class="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      <div
        v-for="t in toast.items.value"
        :key="t.id"
        class="flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3 shadow-md"
      >
        <component :is="icons[t.type]" :class="['mt-0.5 h-4 w-4 shrink-0', colors[t.type]]" />
        <p class="flex-1 text-sm text-fg">{{ t.message }}</p>
        <button class="text-fg-muted hover:text-fg" @click="toast.remove(t.id)">
          <X class="h-4 w-4" />
        </button>
      </div>
    </div>
  </Teleport>
</template>
