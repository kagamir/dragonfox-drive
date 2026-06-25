<script setup lang="ts">
import {
  Dialog, DialogPanel, DialogTitle,
  TransitionRoot, TransitionChild,
} from "@headlessui/vue";
withDefaults(defineProps<{ open: boolean; title?: string; size?: "sm" | "md" | "lg" }>(), { size: "md" });
defineEmits<{ close: [] }>();
const maxW = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-2xl" };
</script>

<template>
  <TransitionRoot :show="open" as="template" appear>
    <Dialog @close="$emit('close')" class="relative z-50">
      <TransitionChild as="template"
        enter="duration-200 ease-out" enter-from="opacity-0" enter-to="opacity-100"
        leave="duration-150 ease-in" leave-from="opacity-100" leave-to="opacity-0">
        <div class="fixed inset-0 bg-black/40 backdrop-blur-sm" aria-hidden="true" />
      </TransitionChild>
      <div class="fixed inset-0 flex items-center justify-center p-4">
        <TransitionChild as="template"
          enter="duration-200 ease-out" enter-from="opacity-0 scale-95" enter-to="opacity-100 scale-100"
          leave="duration-150 ease-in" leave-from="opacity-100 scale-100" leave-to="opacity-0 scale-95">
          <DialogPanel :class="['w-full rounded-xl border border-border bg-surface p-6 shadow-lg', maxW[size]]">
            <DialogTitle v-if="title" class="mb-1 text-lg font-semibold text-fg">{{ title }}</DialogTitle>
            <slot />
          </DialogPanel>
        </TransitionChild>
      </div>
    </Dialog>
  </TransitionRoot>
</template>
