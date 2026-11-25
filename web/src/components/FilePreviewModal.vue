<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/vue";
import type { FileKind } from "@/crypto/preview";
import type { PlayerPayload } from "@/player/msePlayer";
import Mp4Player from "./Mp4Player.vue";
import ImageViewer from "./ImageViewer.vue";
import DfModal from "@/components/ui/DfModal.vue";
import DfButton from "@/components/ui/DfButton.vue";
import { useConfirm } from "@/composables/useConfirm";

const props = defineProps<{
  kind: FileKind;
  url: string;
  previewBlob?: Blob;
  name: string;
  canPrevious?: boolean;
  canNext?: boolean;
  navigating?: boolean;
  navigationError?: string;
  player?: PlayerPayload | null;
  /** Enables text editing. Resolve = saved (edit mode exits); reject = keep
   *  the draft and stay in edit mode (the parent surfaces the error). */
  onSave?: ((text: string) => Promise<void>) | null;
  /** New-file flow: open directly in edit mode with an empty draft. */
  startEditing?: boolean;
}>();
const emit = defineEmits<{ close: []; error: [message: string]; navigate: [direction: -1 | 1] }>();
const { t } = useI18n();
const confirm = useConfirm();

const text = ref("");
const editing = ref(props.startEditing ?? false);
const draft = ref("");
const saving = ref(false);
const dirty = computed(() => editing.value && draft.value !== text.value);

watch(() => props.previewBlob, async (blob, _, onCleanup) => {
  if (props.kind !== "text" || props.startEditing) return;
  let current = true;
  onCleanup(() => { current = false; });
  text.value = "";
  if (!blob) return;
  try {
    const decoded = await blob.text();
    if (current) text.value = decoded;
  } catch {
    if (current) text.value = t("drive.textReadError");
  }
}, { immediate: true });

function startEdit() { draft.value = text.value; editing.value = true; }
async function cancelEdit() {
  if (dirty.value && !(await confirm.confirm({ message: t("drive.discardEdits"), danger: true }))) return;
  editing.value = false;
}
async function save() {
  if (!props.onSave || saving.value || draft.value.length === 0) return;
  saving.value = true;
  try {
    await props.onSave(draft.value);
    text.value = draft.value;
    editing.value = false;
  } catch { /* parent surfaces the error; keep the draft */ }
  finally { saving.value = false; }
}
async function requestClose() {
  if (dirty.value && !(await confirm.confirm({ message: t("drive.discardEdits"), danger: true }))) return;
  emit("close");
}
</script>

<template>
  <Mp4Player v-if="player" :payload="player" :name="name" @close="emit('close')" @error="(m) => emit('error', m)" />
  <Dialog v-else-if="kind === 'image'" :open="true" class="fixed inset-0 z-50" @close="emit('close')">
    <DialogPanel class="h-full w-full">
      <DialogTitle class="sr-only">{{ name }}</DialogTitle>
      <ImageViewer :url="url" :blob="previewBlob" :name="name" :can-previous="canPrevious" :can-next="canNext"
        :navigating="navigating" :navigation-error="navigationError" @navigate="(direction) => emit('navigate', direction)" @close="emit('close')" />
    </DialogPanel>
  </Dialog>
  <DfModal v-else :open="true" :title="name" size="lg" @close="requestClose">
    <div class="flex flex-col items-center gap-3">
      <template v-if="kind === 'text'">
        <textarea
          v-if="editing"
          v-model="draft"
          data-testid="text-editor"
          class="max-h-[70vh] min-h-[40vh] w-full resize-y rounded-lg bg-bg p-4 font-mono text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
          spellcheck="false"
        />
        <pre v-else class="max-h-[70vh] w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg p-4 text-sm text-fg">{{ text }}</pre>
        <div v-if="onSave" class="flex w-full justify-end gap-2">
          <template v-if="editing">
            <DfButton variant="ghost" size="sm" data-testid="edit-cancel-btn" :disabled="saving" @click="cancelEdit">{{ t("common.cancel") }}</DfButton>
            <DfButton size="sm" data-testid="edit-save-btn" :loading="saving" :disabled="saving || draft.length === 0" @click="save">{{ t("common.save") }}</DfButton>
          </template>
          <DfButton v-else variant="ghost" size="sm" data-testid="edit-btn" @click="startEdit">{{ t("drive.edit") }}</DfButton>
        </div>
      </template>
      <audio v-else-if="kind === 'audio'" controls :src="url" />
      <video v-else-if="kind === 'video'" controls :src="url" class="max-h-[70vh] max-w-full rounded-lg bg-black" />
    </div>
  </DfModal>
</template>
