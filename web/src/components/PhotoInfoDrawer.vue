<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X } from "lucide-vue-next";
import type { CameraData } from "@/util/imageExif";

const props = defineProps<{ open: boolean; name: string; blob?: Blob; width: number; height: number }>();
defineEmits<{ close: [] }>();
const { t } = useI18n();
const closeButton = ref<HTMLButtonElement | null>(null);
defineExpose({ focusClose: () => closeButton.value?.focus({ preventScroll: true }) });
const cache = new WeakMap<Blob, CameraData>();
const fields = ref<CameraData>({});
const status = ref<"idle" | "loading" | "ready" | "error">("idle");

watch([() => props.blob, () => props.open], ([blob, open], _, onCleanup) => {
  fields.value = {};
  if (!open) {
    status.value = "idle";
    return;
  }
  if (!blob) {
    status.value = "error";
    return;
  }
  const cached = cache.get(blob);
  if (cached) {
    fields.value = cached;
    status.value = "ready";
    return;
  }

  let active = true;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function stop() {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    worker?.terminate();
  }
  function fail() {
    if (!active) return;
    status.value = "error";
    stop();
  }
  onCleanup(stop);
  status.value = "loading";
  try {
    worker = new Worker(new URL("../workers/imageExif.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<{ fields?: CameraData }>) => {
      if (!active) return;
      if (!data.fields) return fail();
      fields.value = data.fields;
      cache.set(blob, data.fields);
      status.value = "ready";
      stop();
    };
    worker.onerror = fail;
    timer = setTimeout(fail, 8000);
    worker.postMessage(blob);
  } catch { fail(); }
}, { immediate: true });
</script>

<template>
  <aside id="photo-info" data-testid="photo-info-drawer" class="info-panel" :aria-label="t('imageDetails.title')">
    <header class="info-header">
      <h2>{{ t("imageDetails.title") }}</h2>
      <button ref="closeButton" type="button" :title="t('imageDetails.closeInfo')" :aria-label="t('imageDetails.closeInfo')"
        @click="$emit('close')"><X :size="20" aria-hidden="true" /></button>
    </header>
    <div class="info-content">
      <dl class="file-details">
        <div><dt>{{ t("drive.fileName") }}</dt><dd>{{ name }}</dd></div>
        <div v-if="width && height"><dt>{{ t("imageDetails.dimensions") }}</dt><dd>{{ width }} × {{ height }} px</dd></div>
      </dl>
      <dl v-if="Object.keys(fields).length" class="camera-details">
        <div v-for="(value, key) in fields" :key="key">
          <dt>{{ t('imageDetails.' + key) }}</dt><dd>{{ value }}</dd>
        </div>
      </dl>
      <p v-else-if="status === 'loading'" role="status">{{ t("common.loading") }}</p>
      <p v-else-if="status === 'error'" role="status">{{ t("imageDetails.unreadable") }}</p>
      <p v-else-if="status === 'ready'" role="status">{{ t("imageDetails.none") }}</p>
    </div>
  </aside>
</template>

<style scoped>
.info-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.info-header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: max(.65rem, env(safe-area-inset-top)) max(.75rem, env(safe-area-inset-right)) .65rem 1.35rem;
  border-bottom: 1px solid rgb(255 255 255 / .12);
}
.info-header h2 { margin: 0; font-size: 1.05rem; font-weight: 650; }
.info-header button {
  display: grid;
  place-items: center;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
  color: inherit;
  cursor: pointer;
}
.info-header button:hover { background: rgb(255 255 255 / .1); }
.info-content {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 1.4rem max(1.35rem, env(safe-area-inset-right)) max(1.4rem, env(safe-area-inset-bottom)) 1.35rem;
}
.info-content dl { display: grid; gap: 1.1rem; margin: 0; }
.info-content dt, .info-content p { color: var(--photo-muted, #b4b3b8); }
.info-content dt { font-size: .8rem; }
.info-content dd { margin: .15rem 0 0; font-size: .95rem; line-height: 1.45; overflow-wrap: anywhere; }
.info-content .camera-details, .info-content p {
  margin-top: 1.25rem;
  padding-top: 1.25rem;
  border-top: 1px solid rgb(255 255 255 / .12);
}
.info-content p { font-size: .875rem; }
</style>
