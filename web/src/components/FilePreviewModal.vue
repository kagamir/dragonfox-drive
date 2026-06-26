<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { FileKind } from "@/crypto/preview";
import type { PlayerPayload } from "@/player/msePlayer";
import Mp4Player from "./Mp4Player.vue";
import DfModal from "@/components/ui/DfModal.vue";

const props = defineProps<{ kind: FileKind; url: string; name: string; player?: PlayerPayload | null }>();
const emit = defineEmits<{ close: []; error: [message: string] }>();
const text = ref("");
async function loadText() {
  try { text.value = await (await fetch(props.url)).text(); }
  catch { text.value = "(unable to decode text)"; }
}
onMounted(() => { if (props.kind === "text") void loadText(); });
</script>

<template>
  <Mp4Player v-if="player" :payload="player" :name="name" @close="emit('close')" @error="(m) => emit('error', m)" />
  <DfModal v-else :open="true" :title="name" size="lg" @close="emit('close')">
    <div class="flex flex-col items-center gap-3">
      <img v-if="kind === 'image'" :src="url" :alt="name" class="max-h-[70vh] max-w-full rounded-lg" />
      <pre v-else-if="kind === 'text'" class="max-h-[70vh] w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg p-4 text-sm text-fg">{{ text }}</pre>
      <audio v-else-if="kind === 'audio'" controls :src="url" />
      <video v-else-if="kind === 'video'" controls :src="url" class="max-h-[70vh] max-w-full rounded-lg bg-black" />
    </div>
  </DfModal>
</template>
