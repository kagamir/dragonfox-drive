<script setup lang="ts">
import { computed } from "vue";
import { useFoldersStore } from "@/stores/folders";
import { CornerUpLeft } from "lucide-vue-next";
import DfModal from "@/components/ui/DfModal.vue";
import FileTypeIcon from "@/components/FileTypeIcon.vue";

const props = defineProps<{ open: boolean; excludeId?: string }>();
const emit = defineEmits<{ pick: [dest: string | null]; cancel: [] }>();
const folders = useFoldersStore();

const hiddenIds = computed<Set<string>>(() => {
  const out = new Set<string>();
  if (!props.excludeId) return out;
  const stack = [props.excludeId];
  out.add(props.excludeId);
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
  <DfModal :open="open" title="移动到…" size="sm" @close="emit('cancel')">
    <ul class="flex flex-col gap-0.5">
      <li>
        <button class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-bg" @click="emit('pick', null)">
          <CornerUpLeft class="h-4 w-4 text-fg-muted" /> 根目录
        </button>
      </li>
      <li v-for="d in destinations" :key="d.id">
        <button class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-bg" @click="emit('pick', d.id)">
          <FileTypeIcon :name="d.name" is-folder />
          <span class="truncate">{{ d.name }}</span>
        </button>
      </li>
      <li v-if="!destinations.length" class="px-3 py-2 text-sm text-fg-muted">没有其他文件夹。</li>
    </ul>
  </DfModal>
</template>
