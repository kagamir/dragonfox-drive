<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useFoldersStore } from "@/stores/folders";
import { CornerUpLeft } from "lucide-vue-next";
import DfModal from "@/components/ui/DfModal.vue";
import FileTypeIcon from "@/components/FileTypeIcon.vue";

const props = defineProps<{ open: boolean; excludeIds?: string[] }>();
const emit = defineEmits<{ pick: [dest: string | null]; cancel: [] }>();
const { t } = useI18n();
const folders = useFoldersStore();

const hiddenIds = computed<Set<string>>(() => {
  const out = new Set<string>();
  if (!props.excludeIds?.length) return out;
  const stack = [...props.excludeIds];
  for (const id of props.excludeIds) out.add(id);
  while (stack.length) {
    const cur = stack.pop()!;
    for (const f of folders.folders) {
      if (f.parentId === cur && !out.has(f.id)) { out.add(f.id); stack.push(f.id); }
    }
  }
  return out;
});
const destinations = computed(() =>
  folders.folders
    .filter((f) => f.parentId === null && !hiddenIds.value.has(f.id))
    .sort((a, b) => a.name.localeCompare(b.name)),
);
</script>

<template>
  <DfModal :open="open" :title="t('drive.moveTo')" size="sm" @close="emit('cancel')">
    <ul class="flex flex-col gap-0.5">
      <li>
        <button class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-bg" data-testid="move-root-btn" @click="emit('pick', null)">
          <CornerUpLeft class="h-4 w-4 text-fg-muted" /> {{ t("drive.root") }}
        </button>
      </li>
      <li v-for="d in destinations" :key="d.id">
        <button class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-bg" @click="emit('pick', d.id)">
          <FileTypeIcon :name="d.name" is-folder />
          <span class="truncate">{{ d.name }}</span>
        </button>
      </li>
      <li v-if="!destinations.length" class="px-3 py-2 text-sm text-fg-muted">{{ t("drive.noOtherFolders") }}</li>
    </ul>
  </DfModal>
</template>
