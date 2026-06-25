<!-- web/src/components/AppHeader.vue -->
<script setup lang="ts">
import { RouterLink, useRouter } from "vue-router";
import { Sun, Moon, Monitor, Upload, LogOut, Settings as SettingsIcon } from "lucide-vue-next";
import { useTheme } from "@/composables/useTheme";
import { useAuthStore } from "@/stores/auth";
import DfButton from "@/components/ui/DfButton.vue";
import DfDropdown, { type DropdownItem } from "@/components/ui/DfDropdown.vue";
import DfTooltip from "@/components/ui/DfTooltip.vue";

defineProps<{ active: "drive" | "shares" | "settings"; username: string; showUpload?: boolean }>();
const emit = defineEmits<{ upload: [] }>();

const theme = useTheme();
const themeStore = theme.store;
const auth = useAuthStore();
const router = useRouter();

const themeIcon = { light: Sun, dark: Moon, auto: Monitor } as const;
function cycleTheme() {
  const order = ["light", "dark", "auto"] as const;
  const cur = theme.store.value as (typeof order)[number];
  theme.store.value = order[(order.indexOf(cur) + 1) % order.length];
}

const menu: DropdownItem[] = [
  { label: "设置", icon: SettingsIcon, onClick: () => router.push({ name: "settings" }) },
  { label: "退出登录", icon: LogOut, danger: true, onClick: async () => {
    await auth.logout();
    router.push({ name: "login" });
  }},
];
</script>

<template>
  <header class="sticky top-0 z-30 flex items-center gap-4 border-b border-border bg-surface/90 px-4 py-2.5 backdrop-blur md:px-6">
    <RouterLink :to="{ name: 'drive' }" class="flex items-center gap-1.5 font-extrabold text-brand">
      <span>🦊</span><span class="hidden sm:inline">DragonFox</span>
    </RouterLink>

    <nav class="flex items-center gap-1">
      <RouterLink :to="{ name: 'drive' }"
        :class="['rounded-full px-3 py-1.5 text-sm font-medium transition-colors', active==='drive' ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:text-fg']">
        我的文件
      </RouterLink>
      <!-- shares entry currently in Settings -->
    </nav>

    <div class="flex-1" />

    <DfButton v-if="showUpload" variant="primary" size="sm" @click="emit('upload')">
      <template #icon><Upload class="h-4 w-4" /></template>
      上传
    </DfButton>

    <DfTooltip :label="`主题：${themeStore}`">
      <button class="rounded-lg p-2 text-fg-muted hover:bg-bg hover:text-fg" @click="cycleTheme">
        <component :is="themeIcon[themeStore as keyof typeof themeIcon]" class="h-5 w-5" />
      </button>
    </DfTooltip>

    <DfDropdown :items="menu" align="right">
      <template #trigger>
        <button class="flex h-8 w-8 items-center justify-center rounded-full bg-brand/15 text-sm font-semibold text-brand">
          {{ username.slice(0, 1).toUpperCase() }}
        </button>
      </template>
    </DfDropdown>
  </header>
</template>
