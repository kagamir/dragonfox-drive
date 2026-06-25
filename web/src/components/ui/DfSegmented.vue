<script setup lang="ts">
import type { Component } from "vue";
defineProps<{ modelValue: string; options: { value: string; label?: string; icon?: Component }[] }>();
defineEmits<{ "update:modelValue": [string] }>();
</script>
<template>
  <div class="inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
    <button
      v-for="o in options"
      :key="o.value"
      @click="$emit('update:modelValue', o.value)"
      :class="['inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors', modelValue === o.value ? 'bg-brand text-white' : 'text-fg-muted hover:text-fg']"
    >
      <component v-if="o.icon" :is="o.icon" class="h-3.5 w-3.5" />
      <span v-if="o.label">{{ o.label }}</span>
    </button>
  </div>
</template>
