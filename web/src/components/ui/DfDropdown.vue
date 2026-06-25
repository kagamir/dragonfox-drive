<script setup lang="ts">
import { Menu, MenuButton, MenuItems, MenuItem } from "@headlessui/vue";
import type { Component } from "vue";

export interface DropdownItem {
  label: string;
  icon?: Component;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}
withDefaults(defineProps<{ items: DropdownItem[]; align?: "left" | "right" }>(), { align: "left" });
</script>

<template>
  <Menu as="div" class="relative inline-block text-left">
    <MenuButton as="template"><slot name="trigger" /></MenuButton>
    <MenuItems :class="['absolute z-40 mt-1 min-w-[10rem] rounded-lg border border-border bg-surface py-1 shadow-md focus:outline-none', align === 'right' ? 'right-0' : 'left-0']">
      <MenuItem v-for="(it, i) in items" :key="i" v-slot="{ active }" :disabled="it.disabled">
        <button
          @click="it.onClick"
          :class="['flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left', active ? 'bg-bg' : '', it.danger ? 'text-danger' : 'text-fg']"
        >
          <component v-if="it.icon" :is="it.icon" class="h-4 w-4" />{{ it.label }}
        </button>
      </MenuItem>
    </MenuItems>
  </Menu>
</template>
