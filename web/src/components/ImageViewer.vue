<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Camera, ChevronDown, Scan, ZoomIn, ZoomOut } from "lucide-vue-next";
import type { CameraData } from "@/util/imageExif";

const props = defineProps<{ url: string; name: string; blob?: Blob }>();
const { t } = useI18n();
const stage = ref<HTMLElement | null>(null);
const natural = ref({ w: 0, h: 0 });
const bounds = ref({ w: 0, h: 0 });
const fit = computed(() => natural.value.w && bounds.value.w
  ? Math.min(1, bounds.value.w / natural.value.w, bounds.value.h / natural.value.h) : 1);
const zoom = ref<number | null>(null);
const scale = computed(() => zoom.value ?? fit.value);
const photoWidth = computed(() => natural.value.w && bounds.value.w ? natural.value.w * scale.value + "px" : undefined);
const broken = ref(false);
const expanded = ref(false);
const exifState = ref<"idle" | "loading" | "ready" | "error">("idle");
const fields = ref<CameraData>({});
let observer: ResizeObserver | undefined;
let worker: Worker | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function measure() {
  if (stage.value) bounds.value = { w: stage.value.clientWidth, h: stage.value.clientHeight };
}
onMounted(() => {
  measure();
  if (stage.value && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(measure);
    observer.observe(stage.value);
  }
});
function loaded(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  natural.value = { w: image.naturalWidth, h: image.naturalHeight };
  measure();
}
function setScale(value: number | null, click?: MouseEvent) {
  const el = stage.value;
  if (!el) return;
  const box = el.getBoundingClientRect();
  const x = click?.detail ? click.clientX - box.left : el.clientWidth / 2;
  const y = click?.detail ? click.clientY - box.top : el.clientHeight / 2;
  const oldW = natural.value.w * scale.value;
  const oldH = natural.value.h * scale.value;
  const px = oldW ? (el.scrollLeft + x - Math.max(0, (el.clientWidth - oldW) / 2)) / oldW : .5;
  const py = oldH ? (el.scrollTop + y - Math.max(0, (el.clientHeight - oldH) / 2)) / oldH : .5;
  zoom.value = value === null ? null : Math.min(4, Math.max(fit.value, value));
  nextTick(() => {
    el.scrollLeft = px * natural.value.w * scale.value - x;
    el.scrollTop = py * natural.value.h * scale.value - y;
  });
}
function keydown(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey || broken.value) return;
  if (e.key === "+" || e.key === "=") setScale(scale.value * 1.5);
  else if (e.key === "-") setScale(scale.value / 1.5);
  else if (e.key === "0") setScale(null);
  else return;
  e.preventDefault();
}

function stopWorker() {
  worker?.terminate();
  worker = undefined;
  clearTimeout(timer);
}
function fail() { exifState.value = "error"; stopWorker(); }
function toggleDetails() {
  expanded.value = !expanded.value;
  if (!expanded.value && exifState.value === "loading") {
    stopWorker();
    exifState.value = "idle";
  }
  if (!expanded.value || exifState.value !== "idle") return;
  exifState.value = "loading";
  try {
    if (!props.blob) return fail();
    worker = new Worker(new URL("../workers/imageExif.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.failed) return fail();
      fields.value = data.fields;
      exifState.value = "ready";
      stopWorker();
    };
    worker.onerror = fail;
    timer = setTimeout(fail, 8000);
    worker.postMessage(props.blob);
  } catch { fail(); }
}
onBeforeUnmount(() => { observer?.disconnect(); stopWorker(); });
</script>

<template>
  <section class="viewer" @keydown="keydown">
    <div ref="stage" class="photo-stage" tabindex="0" role="region" :aria-label="t('imageDetails.view')">
      <div class="photo-center">
        <p v-if="broken" role="status" class="p-5 text-sm text-fg-muted">{{ t("imageDetails.unsupported") }}</p>
        <button v-else type="button" class="photo-button" :class="{ enlarged: scale > fit }"
          :aria-label="scale > fit ? t('imageDetails.fit') : t('imageDetails.zoomIn')"
          @click="setScale(scale > fit ? null : (fit < 1 ? 1 : 2), $event)">
          <img :src="url" :alt="name" :style="{ width: photoWidth }" @load="loaded" @error="broken = true" draggable="false" />
        </button>
      </div>
    </div>
    <div class="tools">
      <button type="button" class="details-toggle" :aria-expanded="expanded" @click="toggleDetails">
        <Camera aria-hidden="true" :size="16" />{{ t("imageDetails.title") }}
        <ChevronDown :size="14" aria-hidden="true" :class="{ 'rotate-180': expanded }" />
      </button>
      <div v-if="!broken" class="zoom-tools">
        <button type="button" :aria-label="t('imageDetails.zoomOut')" :title="t('imageDetails.zoomOut')"
          :disabled="!natural.w || scale <= fit" @click="setScale(scale / 1.5)"><ZoomOut :size="17" /></button>
        <span class="tabular-nums">{{ Math.round(scale * 100) }}%</span>
        <button type="button" :aria-label="t('imageDetails.zoomIn')" :title="t('imageDetails.zoomIn')"
          :disabled="!natural.w || scale >= 4" @click="setScale(scale * 1.5)"><ZoomIn :size="17" /></button>
        <button type="button" :aria-label="t('imageDetails.fit')" :title="t('imageDetails.fit')"
          :disabled="zoom === null" @click="setScale(null)"><Scan :size="17" /></button>
      </div>
    </div>
    <div v-if="expanded" class="metadata">
      <dl v-if="natural.w || Object.keys(fields).length" class="fields">
        <div v-if="natural.w"><dt>{{ t("imageDetails.dimensions") }}</dt><dd>{{ natural.w }} × {{ natural.h }} px</dd></div>
        <div v-for="(value, key) in fields" :key="key"><dt>{{ t('imageDetails.' + key) }}</dt><dd>{{ value }}</dd></div>
      </dl>
      <p v-if="exifState === 'loading'" role="status">{{ t("common.loading") }}</p>
      <p v-else-if="exifState === 'error'" role="status">{{ t("imageDetails.unreadable") }}</p>
      <p v-else-if="!Object.keys(fields).length" role="status">{{ t("imageDetails.none") }}</p>
    </div>
  </section>
</template>

<style scoped>
.viewer { width: 100%; min-width: 0; }
.photo-stage { width: 100%; height: min(62vh, 48rem); height: min(62dvh, 48rem); overflow: auto; overscroll-behavior: contain; background: var(--color-bg); border-radius: .7rem; }
.photo-center { width: max-content; min-width: 100%; min-height: 100%; display: grid; place-items: center; }
.photo-button { border: 0; padding: 0; background: transparent; cursor: zoom-in; }
.photo-button.enlarged { cursor: zoom-out; }
.photo-button img { display: block; max-width: none; height: auto; }
.tools { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: .3rem; padding-top: .55rem; }
.tools button { min-height: 2.5rem; border-radius: .5rem; }
.tools button:hover:enabled { background: var(--color-brand-soft); }
.details-toggle, .zoom-tools { display: flex; align-items: center; gap: .35rem; }
.details-toggle { padding: .3rem .55rem; font-weight: 600; }
.zoom-tools { color: var(--color-fg-muted); font-size: .8rem; }
.zoom-tools button { display: grid; place-items: center; min-width: 2.5rem; }
.zoom-tools button:disabled { opacity: .45; }
.metadata { margin-top: .5rem; padding: .9rem; background: var(--color-bg); border-radius: .7rem; }
.fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr)); gap: .8rem; }
.fields dt, .metadata p { font-size: .8rem; color: var(--color-fg-muted); }
.fields dd { margin: .1rem 0 0; font-weight: 600; overflow-wrap: anywhere; }
.fields + p { margin-top: .8rem; }
</style>
