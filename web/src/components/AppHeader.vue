<!-- web/src/components/AppHeader.vue -->
<script setup lang="ts">
import { RouterLink, useRouter } from "vue-router";
import { Sun, Moon, Monitor, Upload, LogOut, Settings as SettingsIcon, Languages } from "lucide-vue-next";
import { useTheme } from "@/composables/useTheme";
import { useAuthStore } from "@/stores/auth";
import { i18n, setLocale, type AppLocale } from "@/locales";
import { useI18n } from "vue-i18n";
import DfButton from "@/components/ui/DfButton.vue";
import DfDropdown, { type DropdownItem } from "@/components/ui/DfDropdown.vue";
import DfTooltip from "@/components/ui/DfTooltip.vue";

defineProps<{ active: "drive" | "shares" | "settings"; username: string; showUpload?: boolean }>();
const emit = defineEmits<{ upload: [] }>();
const { t } = useI18n();
const theme = useTheme();
const auth = useAuthStore();
const router = useRouter();

const themeIcon = { light: Sun, dark: Moon, auto: Monitor } as const;
const themeStore = theme.store;
function cycleTheme() {
  const o = ["light", "dark", "auto"] as const;
  theme.store.value = o[(o.indexOf(theme.store.value as (typeof o)[number]) + 1) % o.length];
}
const langLabel = { en: "English", zh: "中文" } as const;
const langItems: DropdownItem[] = (["en", "zh"] as AppLocale[]).map((l) => ({
  label: langLabel[l],
  onClick: () => { i18n.global.locale.value = l; setLocale(l); },
}));
const menu: DropdownItem[] = [
  { label: t("settings.settings"), icon: SettingsIcon, onClick: () => router.push({ name: "settings" }) },
  { label: t("settings.signOut"), icon: LogOut, danger: true, onClick: async () => {
    await auth.logout(); router.push({ name: "login" });
  }},
];
</script>

<template>
  <header class="sticky top-0 z-30 flex items-center gap-4 border-b border-border bg-surface/90 px-4 py-2.5 backdrop-blur md:px-6">
    <RouterLink :to="{ name: 'drive' }" class="flex items-center gap-1.5 font-extrabold text-brand">
      <span>🦊</span><span class="hidden sm:inline">{{ t("common.appName") }}</span>
    </RouterLink>
    <nav class="flex items-center gap-1">
      <RouterLink :to="{ name: 'drive' }"
        :class="['rounded-full px-3 py-1.5 text-sm font-medium transition-colors', active==='drive' ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:text-fg']">
        {{ t("drive.myFiles") }}
      </RouterLink>
      <RouterLink :to="{ name: 'shares' }"
        :class="['rounded-full px-3 py-1.5 text-sm font-medium transition-colors', active==='shares' ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:text-fg']">
        {{ t("share.shares") }}
      </RouterLink>
    </nav>
    <div class="flex-1" />
    <DfButton v-if="showUpload" variant="primary" size="sm" @click="emit('upload')">
      <template #icon><Upload class="h-4 w-4" /></template>{{ t("drive.upload") }}
    </DfButton>
    <DfDropdown :items="langItems" align="right">
      <template #trigger>
        <button class="rounded-lg p-2 text-fg-muted hover:bg-bg hover:text-fg" :aria-label="t('common.language')">
          <Languages class="h-5 w-5" />
        </button>
      </template>
    </DfDropdown>
    <DfTooltip :label="t('theme.toggle', { mode: t('theme.' + (themeStore as unknown as string)) })">
      <button class="rounded-lg p-2 text-fg-muted hover:bg-bg hover:text-fg" :aria-label="t('theme.toggle', { mode: themeStore })" @click="cycleTheme">
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
