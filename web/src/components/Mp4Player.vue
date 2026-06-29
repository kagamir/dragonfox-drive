<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { createChunkBuffer } from "@/player/chunkbuf";
import { playMp4, type MseHandle, type PlayerPayload } from "@/player/msePlayer";

const props = defineProps<{ payload: PlayerPayload; name: string }>();
const emit = defineEmits<{ error: [message: string]; close: [] }>();
const { t } = useI18n();

const videoEl = ref<HTMLVideoElement | null>(null);
let handle: MseHandle | null = null;

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  if (!videoEl.value) return;
  const buf = createChunkBuffer({
    fileKey: props.payload.fileKey,
    ivBase: props.payload.ivBase,
    contentId: props.payload.contentId,
    chunkSize: props.payload.chunkSize,
    totalSize: props.payload.totalSize,
    fetchChunk: props.payload.fetchChunk,
  });
  handle = playMp4(videoEl.value, buf, props.payload.totalSize, (e) => {
    emit("error", e.message);
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  handle?.dispose();
  handle = null;
});
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" @click.self="emit('close')">
    <div class="flex max-h-[90vh] max-w-[90vw] flex-col gap-3 overflow-auto rounded-xl border border-border bg-surface p-4 shadow-lg">
      <header class="flex items-center justify-between gap-4">
        <span class="font-semibold text-fg">{{ name }}</span>
        <button class="text-fg-muted hover:text-fg" @click="emit('close')">{{ t("common.close") }}</button>
      </header>
      <video ref="videoEl" controls autoplay class="max-h-[75vh] max-w-[85vw] rounded-lg bg-black" />
    </div>
  </div>
</template>
