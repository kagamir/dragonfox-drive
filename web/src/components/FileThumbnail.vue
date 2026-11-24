<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import type { FileMeta } from "@/api/types";
import { useAuthStore } from "@/stores/auth";
import { useFilesStore } from "@/stores/files";
import { thumbnailMime, useThumbnailsStore } from "@/stores/thumbnails";
import FileTypeIcon from "./FileTypeIcon.vue";

const props = defineProps<{ file: FileMeta; name: string }>();
const files = useFilesStore();
const auth = useAuthStore();
const thumbnails = useThumbnailsStore();
const tile = ref<HTMLElement | null>(null);
const nearby = ref(false);
const url = ref("");
let observer: IntersectionObserver | undefined;

onMounted(() => {
  if (!tile.value || typeof IntersectionObserver === "undefined") {
    nearby.value = true;
    return;
  }
  observer = new IntersectionObserver(([entry]) => { nearby.value = entry.isIntersecting; }, { rootMargin: "160px" });
  observer.observe(tile.value);
});
onUnmounted(() => observer?.disconnect());

watch(() => [
  nearby.value, props.file.id, props.file.status, props.file.encrypted_manifest_nonce,
  props.name, files.displayMimes[props.file.id], auth.userId, auth.masterKey, auth.isAuthenticated,
], async (_, __, cleanup) => {
  if (!nearby.value || !thumbnailMime(files.displayMimes[props.file.id], props.name)) return;
  const controller = new AbortController();
  let ownUrl = "";
  cleanup(() => {
    controller.abort();
    if (ownUrl) URL.revokeObjectURL(ownUrl);
    url.value = "";
  });
  try {
    const blob = await thumbnails.load(props.file, controller.signal);
    if (blob && !controller.signal.aborted) url.value = ownUrl = URL.createObjectURL(blob);
  } catch {
    // Decode failures, missing keys and interrupted downloads leave the file actionable.
  }
}, { flush: "sync" });
</script>

<template>
  <span ref="tile" class="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg">
    <img v-if="url" :src="url" alt="" draggable="false" class="absolute inset-0 h-full w-full object-cover" />
    <slot v-else><FileTypeIcon :name="name" /></slot>
  </span>
</template>
