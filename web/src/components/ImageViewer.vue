<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useMediaQuery } from "@vueuse/core";
import { Info, Maximize, Minimize, Scan, X, ZoomIn, ZoomOut } from "lucide-vue-next";
import PhotoCanvas from "./PhotoCanvas.vue";
import PhotoInfoDrawer from "./PhotoInfoDrawer.vue";

const props = defineProps<{
  url: string; name: string; blob?: Blob;
  canPrevious?: boolean; canNext?: boolean; navigating?: boolean; navigationError?: string;
}>();
const emit = defineEmits<{ close: []; navigate: [direction: -1 | 1] }>();
const { t } = useI18n();
const viewer = ref<HTMLElement | null>(null);
const canvas = ref<InstanceType<typeof PhotoCanvas> | null>(null);
const drawer = ref<InstanceType<typeof PhotoInfoDrawer> | null>(null);
const infoButton = ref<HTMLButtonElement | null>(null);
const expanded = ref(false);
const compact = useMediaQuery("(max-width: 42rem)");
const dimensions = ref({ width: 0, height: 0 });
const fullscreenAvailable = ref(false);
const fullscreen = ref(false);
const fullscreenError = ref(false);
const zoomPercent = computed(() => Math.round((canvas.value?.scale ?? 1) * 100));

watch(() => props.url, () => { dimensions.value = { width: 0, height: 0 }; }, { flush: "sync" });

async function showInfo(open: boolean) {
  expanded.value = open;
  await nextTick();
  if (open) drawer.value?.focusClose();
  else infoButton.value?.focus();
}

function navigate(direction: -1 | 1) {
  if (props.navigating || canvas.value?.isZoomed || (direction < 0 ? !props.canPrevious : !props.canNext)) return;
  emit("navigate", direction);
}
function keydown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Escape" && expanded.value) {
    e.preventDefault();
    e.stopPropagation();
    void showInfo(false);
    return;
  }
  if (compact.value && expanded.value) return;
  switch (e.key) {
    case "ArrowLeft": navigate(-1); break;
    case "ArrowRight": navigate(1); break;
    case "+": case "=": canvas.value?.zoomIn(); break;
    case "-": canvas.value?.zoomOut(); break;
    case "0": canvas.value?.resetZoom(); break;
    default: return;
  }
  e.preventDefault();
}

function onFullscreenChange() {
  fullscreen.value = document.fullscreenElement === viewer.value;
}
onMounted(() => {
  fullscreenAvailable.value = !!document.fullscreenEnabled && !!viewer.value?.requestFullscreen;
  document.addEventListener("fullscreenchange", onFullscreenChange);
});
onBeforeUnmount(() => document.removeEventListener("fullscreenchange", onFullscreenChange));
async function toggleFullscreen() {
  fullscreenError.value = false;
  try {
    if (document.fullscreenElement === viewer.value) await document.exitFullscreen();
    else await viewer.value?.requestFullscreen();
  } catch { fullscreenError.value = true; }
}
</script>

<template>
  <section ref="viewer" class="photo-viewer" :class="{ 'info-open': expanded }"
    data-testid="photo-viewer" @keydown="keydown">
    <div class="photo-pane" :inert="compact && expanded">
      <header class="photo-header">
        <button type="button" class="photo-icon" data-testid="photo-close"
          :aria-label="t('common.close')" :title="t('common.close')" @click="emit('close')">
          <X aria-hidden="true" />
        </button>
        <span class="photo-name" data-testid="photo-name" :title="name" aria-live="polite">{{ name }}</span>
        <span v-if="navigating" class="photo-spinner" role="status" :aria-label="t('common.loading')" />
        <button ref="infoButton" type="button" class="photo-icon info-toggle" data-testid="photo-info-toggle"
          :aria-label="t('imageDetails.title')" :title="t('imageDetails.title')"
          :aria-expanded="expanded" aria-controls="photo-info" @click="showInfo(!expanded)">
          <Info aria-hidden="true" />
        </button>
        <button v-if="fullscreenAvailable" type="button" class="photo-icon" data-testid="photo-fullscreen"
          :aria-label="t(fullscreen ? 'imageDetails.exitFullscreen' : 'imageDetails.fullscreen')"
          :title="t(fullscreen ? 'imageDetails.exitFullscreen' : 'imageDetails.fullscreen')" @click="toggleFullscreen">
          <component :is="fullscreen ? Minimize : Maximize" aria-hidden="true" />
        </button>
      </header>
      <PhotoCanvas ref="canvas" :url="url" :name="name" :can-previous="canPrevious && !navigating"
        :can-next="canNext && !navigating" @navigate="navigate"
        @dimensions="(width, height) => { dimensions = { width, height } }" />

      <p v-if="navigationError || fullscreenError" role="status" class="viewer-error">
        {{ navigationError || t("imageDetails.fullscreenError") }}
      </p>

      <div class="zoom-tools" role="group" :aria-label="t('imageDetails.zoom')">
        <button type="button" class="photo-icon" :disabled="!canvas?.canZoomOut"
          :aria-label="t('imageDetails.zoomOut')" :title="t('imageDetails.zoomOut')" @click="canvas?.zoomOut()">
          <ZoomOut aria-hidden="true" />
        </button>
        <span data-testid="photo-zoom" class="zoom-percent">{{ zoomPercent }}%</span>
        <button type="button" class="photo-icon" :disabled="!canvas?.canZoomIn"
          :aria-label="t('imageDetails.zoomIn')" :title="t('imageDetails.zoomIn')" @click="canvas?.zoomIn()">
          <ZoomIn aria-hidden="true" />
        </button>
        <button type="button" class="photo-icon fit-control" data-testid="photo-fit" :disabled="!canvas?.isZoomed"
          :aria-label="t('imageDetails.fit')" :title="t('imageDetails.fit')" @click="canvas?.resetZoom()">
          <Scan aria-hidden="true" />
        </button>
      </div>
    </div>

    <button v-if="expanded && compact" class="drawer-scrim" type="button" tabindex="-1"
      :aria-label="t('imageDetails.closeInfo')" @click="showInfo(false)" />
    <Transition name="photo-drawer">
      <PhotoInfoDrawer v-show="expanded" ref="drawer" class="info-drawer" :open="expanded" :name="name" :blob="blob"
        :width="dimensions.width" :height="dimensions.height" @close="showInfo(false)" />
    </Transition>
  </section>
</template>

<style scoped>
.photo-viewer {
  --photo-panel: #202023;
  --photo-muted: #b8b8bf;
  --drawer-width: min(22rem, 38vw);
  position: relative;
  isolation: isolate;
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: #f6f6f7;
  background: #101012;
  color-scheme: dark;
}
.photo-pane { position: absolute; inset: 0; display: flex; min-width: 0; }
.info-open .photo-pane { inset-inline-end: var(--drawer-width); }
.photo-header {
  position: absolute; inset: 0 0 auto; z-index: 2;
  display: flex; align-items: center; gap: .55rem;
  padding: max(.65rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) 1.15rem max(1rem, env(safe-area-inset-left));
  background: linear-gradient(to bottom, rgb(0 0 0 / .73), transparent);
  pointer-events: none;
}
.photo-icon {
  pointer-events: auto; display: inline-grid; flex: none; place-items: center;
  width: 2.75rem; height: 2.75rem; border-radius: 50%; color: inherit; cursor: pointer;
}
.photo-icon svg { width: 1.22rem; height: 1.22rem; stroke-width: 1.8; }
.photo-icon:hover:enabled, .photo-icon[aria-expanded="true"] { background: rgb(255 255 255 / .18); }
.photo-viewer :deep(button:focus-visible) { outline: 2px solid #fff; outline-offset: -3px; }
.photo-icon:disabled { opacity: .38; cursor: default; }
.photo-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; text-shadow: 0 1px 4px #000; }
.info-toggle { margin-inline-start: auto; }
.photo-spinner { flex: none; width: 1rem; height: 1rem; border: 2px solid #777; border-top-color: white; border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.zoom-tools {
  position: absolute; bottom: max(1.1rem, env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); z-index: 1;
  display: flex; align-items: center; border: 1px solid rgb(255 255 255 / .19); border-radius: 2rem;
  padding: 2px; background: rgb(30 30 34 / .9); box-shadow: 0 3px 14px #0005;
}
.zoom-percent { min-width: 3.2rem; text-align: center; font-size: .82rem; font-variant-numeric: tabular-nums; }
.fit-control { margin-inline-start: 3px; position: relative; }
.fit-control::before { content: ""; position: absolute; left: -2px; top: 25%; height: 50%; width: 1px; background: rgb(255 255 255 / .35); }
.info-drawer {
  position: absolute; inset-block: 0; inset-inline-end: 0; z-index: 4; width: var(--drawer-width);
  background: var(--photo-panel); border-inline-start: 1px solid rgb(255 255 255 / .12);
}
.drawer-scrim { position: absolute; inset: 0; z-index: 3; background: #0008; }
.viewer-error { position: absolute; z-index: 2; right: 1rem; top: 4.5rem; padding: .45rem .85rem; border-radius: .5rem; background: var(--photo-panel); font-size: .85rem; }
@media (max-width: 42rem) {
  .photo-viewer { --drawer-width: min(22rem, 90vw); }
  .info-open .photo-pane { inset-inline-end: 0; }
  .photo-header { gap: .15rem; padding-inline: max(.45rem, env(safe-area-inset-left)) max(.45rem, env(safe-area-inset-right)); }
}
@media (prefers-reduced-motion: no-preference) {
  .photo-drawer-enter-active, .photo-drawer-leave-active { transition: transform .18s ease-out; }
  .photo-drawer-enter-from, .photo-drawer-leave-to { transform: translateX(100%); }
}
@media (prefers-reduced-motion: reduce) { .photo-spinner { animation: none; } }
</style>
