<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import type { FileKind } from "@/crypto/preview";

const props = defineProps<{ kind: FileKind; url: string; name: string }>();
const emit = defineEmits<{ close: [] }>();

const text = ref("");

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

async function loadText() {
  try {
    const res = await fetch(props.url);
    text.value = await res.text();
  } catch {
    text.value = "(unable to decode text)";
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  if (props.kind === "text") void loadText();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="preview-backdrop" @click.self="emit('close')">
    <div class="preview-card">
      <header>
        <span class="name">{{ name }}</span>
        <button class="link" @click="emit('close')">Close</button>
      </header>
      <div class="body">
        <img v-if="kind === 'image'" :src="url" :alt="name" />
        <pre v-else-if="kind === 'text'">{{ text }}</pre>
        <audio v-else-if="kind === 'audio'" controls :src="url" />
        <video v-else-if="kind === 'video'" controls :src="url" />
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
.body img, .body video { max-width: 85vw; max-height: 75vh; }
.body pre { white-space: pre-wrap; word-break: break-word; max-width: 80vw; }
.link { background: transparent; border: 0; cursor: pointer; color: var(--df-color-fg-muted); }
</style>
