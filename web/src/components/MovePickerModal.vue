<script setup lang="ts">
import { computed } from "vue";
import { useFoldersStore } from "@/stores/folders";

const props = defineProps<{ open: boolean; excludeId?: string }>();
const emit = defineEmits<{ pick: [dest: string | null]; cancel: [] }>();

const folders = useFoldersStore();

/** The set of folder ids to hide: the excluded folder + all its descendants. */
const hiddenIds = computed<Set<string>>(() => {
  const out = new Set<string>();
  if (!props.excludeId) return out;
  const stack = [props.excludeId];
  out.add(props.excludeId);
  while (stack.length) {
    const cur = stack.pop()!;
    for (const f of folders.folders) {
      if (f.parentId === cur && !out.has(f.id)) {
        out.add(f.id);
        stack.push(f.id);
      }
    }
  }
  return out;
});

/** Root-level folders not hidden, for the flat picker (P3: no nesting UI). */
const destinations = computed(() =>
  folders.folders
    .filter((f) => f.parentId === null && !hiddenIds.value.has(f.id))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("cancel");
}
</script>

<template>
  <div v-if="open" class="picker-backdrop" @click.self="emit('cancel')" @keydown="onKey">
    <div class="picker-card">
      <header>
        <span class="title">Move to…</span>
        <button class="link" @click="emit('cancel')">Cancel</button>
      </header>
      <ul class="dest-list">
        <li>
          <button class="link row" @click="emit('pick', null)">Move to root</button>
        </li>
        <li v-for="d in destinations" :key="d.id">
          <button class="link row" @click="emit('pick', d.id)">📁 {{ d.name }}</button>
        </li>
        <li v-if="!destinations.length" class="muted">No other folders.</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.picker-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: center; justify-content: center; z-index: 60;
}
.picker-card {
  background: var(--df-color-bg-elevated); border-radius: var(--df-radius-sm);
  padding: 1rem; width: 100%; max-width: 420px;
}
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
.title { font-weight: 600; }
.dest-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.row { display: block; width: 100%; text-align: left; padding: 0.4rem 0.5rem; border-radius: var(--df-radius-sm); }
.row:hover { background: var(--df-color-border); }
.link { background: transparent; border: 0; cursor: pointer; color: var(--df-color-fg); }
.muted { color: var(--df-color-fg-muted); padding: 0.4rem 0.5rem; }
</style>
