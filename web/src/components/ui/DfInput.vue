<script setup lang="ts">
const props = defineProps<{
  modelValue: string;
  label?: string;
  hint?: string;
  error?: string;
  placeholder?: string;
  type?: string;
  autocomplete?: string;
  disabled?: boolean;
  autofocus?: boolean;
}>();
defineEmits<{ "update:modelValue": [string] }>();
</script>

<template>
  <label class="flex flex-col gap-1 text-sm">
    <span v-if="label" class="font-medium text-fg">{{ label }}</span>
    <span class="inline-flex items-center gap-2 rounded-lg border bg-surface px-3 py-2 focus-within:ring-2 focus-within:ring-brand/60"
      :class="error ? 'border-danger' : 'border-border'">
      <slot name="prefix" />
      <input
        :type="type ?? 'text'"
        :value="modelValue"
        :placeholder="placeholder"
        :autocomplete="autocomplete"
        :disabled="disabled"
        :autofocus="autofocus"
        class="w-full bg-transparent text-fg placeholder:text-fg-muted/70 outline-none disabled:opacity-60"
        :class="error ? 'border-danger' : 'border-border'"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
      <slot name="suffix" />
    </span>
    <span v-if="error" class="text-xs text-danger">{{ error }}</span>
    <span v-else-if="hint" class="text-xs text-fg-muted">{{ hint }}</span>
  </label>
</template>
