<script setup lang="ts">
import { ref } from "vue";
import { useDropZone } from "@vueuse/core";

const emit = defineEmits<{ files: [File[]] }>();
const el = ref<HTMLElement | null>(null);
const over = ref(false);

function onDrop(fs: File[] | null) {
  over.value = false;
  if (fs && fs.length) emit("files", Array.from(fs));
}
useDropZone(el, {
  onDrop,
  onEnter: () => (over.value = true),
  onLeave: () => (over.value = false),
});
</script>

<template>
  <div
    ref="el"
    :class="['relative transition-colors', over ? 'ring-2 ring-brand ring-inset rounded-xl bg-brand/5' : '']"
  >
    <slot :over="over" />
  </div>
</template>
