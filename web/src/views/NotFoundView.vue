<script setup lang="ts">
import { Compass } from "lucide-vue-next";
import DfButton from "@/components/ui/DfButton.vue";
</script>

<template>
  <main class="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg p-4 text-center">
    <Compass class="h-16 w-16 text-brand/60" />
    <h1 class="text-3xl font-extrabold text-fg">走丢了</h1>
    <p class="text-sm text-fg-muted">这个页面不存在，或已被移除。</p>
    <DfButton @click="$router.push({ name: 'drive' })">返回网盘</DfButton>
  </main>
</template>
