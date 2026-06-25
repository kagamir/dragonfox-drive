<script setup lang="ts">
import { computed } from "vue";
import {
  FileText, Image as ImageIcon, Film, Music, Archive, Folder, File,
} from "lucide-vue-next";
import type { Component } from "vue";

const props = defineProps<{ name: string; isFolder?: boolean }>();

const DOC = ["pdf","doc","docx","txt","md","rtf","xls","xlsx","ppt","pptx","csv"];
const IMG = ["png","jpg","jpeg","gif","webp","svg","bmp"];
const VID = ["mp4","mov","m4v","webm","mkv","avi"];
const AUD = ["mp3","wav","flac","aac","ogg","m4a"];
const ZIP = ["zip","tar","gz","rar","7z"];

function ext(n: string): string {
  const i = n.lastIndexOf(".");
  return i < 0 ? "" : n.slice(i + 1).toLowerCase();
}

const CATS: Record<string, { icon: Component; cls: string }> = {
  doc:    { icon: FileText, cls: "bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300" },
  img:    { icon: ImageIcon, cls: "bg-pink-100 text-pink-600 dark:bg-pink-500/20 dark:text-pink-300" },
  vid:    { icon: Film, cls: "bg-orange-100 text-orange-600 dark:bg-orange-500/20 dark:text-orange-300" },
  aud:    { icon: Music, cls: "bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300" },
  zip:    { icon: Archive, cls: "bg-green-100 text-green-600 dark:bg-green-500/20 dark:text-green-300" },
  folder: { icon: Folder, cls: "bg-orange-100 text-orange-600 dark:bg-orange-500/20 dark:text-orange-300" },
  other:  { icon: File, cls: "bg-gray-100 text-gray-500 dark:bg-gray-500/20 dark:text-gray-300" },
};

const cat = computed(() => {
  if (props.isFolder) return CATS.folder;
  const e = ext(props.name);
  if (DOC.includes(e)) return CATS.doc;
  if (IMG.includes(e)) return CATS.img;
  if (VID.includes(e)) return CATS.vid;
  if (AUD.includes(e)) return CATS.aud;
  if (ZIP.includes(e)) return CATS.zip;
  return CATS.other;
});
</script>

<template>
  <span :class="['inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', cat.cls]">
    <component :is="cat.icon" class="h-5 w-5" />
  </span>
</template>
