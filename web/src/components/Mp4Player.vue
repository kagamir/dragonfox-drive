<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { createChunkBuffer } from "@/player/chunkbuf";
import { playMp4, type MseHandle, type PlayerPayload } from "@/player/msePlayer";

const props = defineProps<{ payload: PlayerPayload; name: string }>();
const emit = defineEmits<{ error: [message: string]; close: [] }>();

const videoEl = ref<HTMLVideoElement | null>(null);
let handle: MseHandle | null = null;

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  if (!videoEl.value) return;
  const buf = createChunkBuffer({
    fileId: props.payload.fileId,
    fileKey: props.payload.fileKey,
    ivBase: props.payload.ivBase,
    chunkSize: props.payload.chunkSize,
    totalSize: props.payload.totalSize,
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
  <div class="preview-backdrop" @click.self="emit('close')">
    <div class="preview-card">
      <header>
        <span class="name">{{ name }}</span>
        <button class="link" @click="emit('close')">Close</button>
      </header>
      <div class="body">
        <video ref="videoEl" controls autoplay />
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
.preview-card {
  background: var(--df-color-bg-elevated); border-radius: var(--df-radius-sm);
  max-width: 90vw; max-height: 90vh; overflow: auto; padding: 1rem;
  display: flex; flex-direction: column; gap: 0.75rem;
}
header { display: flex; justify-content: space-between; align-items: center; }
.name { font-weight: 600; }
.body video { max-width: 85vw; max-height: 75vh; }
.link { background: transparent; border: 0; cursor: pointer; color: var(--df-color-fg-muted); }
</style>
