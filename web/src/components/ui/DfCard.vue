<template>
  <div class="rounded-xl border border-border bg-surface">
    <div v-if="$slots.header" class="border-b border-border px-5 py-3.5 font-semibold text-fg">
      <slot name="header" />
    </div>
    <div class="p-5"><slot /></div>
    <div v-if="$slots.footer" class="border-t border-border px-5 py-3"><slot name="footer" /></div>
  </div>
</template>
