<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Compass } from "lucide-vue-next";
import DfButton from "@/components/ui/DfButton.vue";

const { t } = useI18n();
</script>

<template>
  <main class="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg p-4 text-center">
    <Compass class="h-16 w-16 text-brand/60" />
    <h1 class="text-3xl font-extrabold text-fg">{{ t("notFound.title") }}</h1>
    <p class="text-sm text-fg-muted">{{ t("notFound.desc") }}</p>
    <DfButton data-testid="notfound-back" @click="$router.push({ name: 'drive' })">{{ t("notFound.back") }}</DfButton>
  </main>
</template>
