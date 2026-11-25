<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronLeft, ChevronRight } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

const props = defineProps<{ url: string; name: string; canPrevious?: boolean; canNext?: boolean }>();
const emit = defineEmits<{ navigate: [direction: -1 | 1]; dimensions: [width: number, height: number] }>();
const { t } = useI18n();

type Point = { x: number; y: number };
const stage = ref<HTMLElement | null>(null);
const image = ref<HTMLImageElement | null>(null);
const viewport = ref({ width: 0, height: 0 });
const natural = ref({ width: 0, height: 0 });
const broken = ref(false);
const zoom = ref<number | null>(null);
const offset = ref<Point>({ x: 0, y: 0 });
const grabbing = ref(false);
const pointers = new Map<number, Point>();
let firstPress: Point = { x: 0, y: 0 };
let suppressClick = false;
let observer: ResizeObserver | undefined;

const fit = computed(() => {
  const { width, height } = viewport.value;
  return width && height && natural.value.width && natural.value.height
    ? Math.min(1, width / natural.value.width, height / natural.value.height) : 1;
});
const scale = computed(() => zoom.value ?? fit.value);
const isZoomed = computed(() => scale.value > fit.value);
const canZoomIn = computed(() => natural.value.width > 0 && scale.value < 4);
const canZoomOut = computed(() => natural.value.width > 0 && isZoomed.value);
const style = computed(() => natural.value.width ? {
  width: natural.value.width * scale.value + "px",
  maxWidth: "none", maxHeight: "none",
  transform: `translate(calc(-50% + ${offset.value.x}px), calc(-50% + ${offset.value.y}px))`,
} : undefined);

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}
function pan(x: number, y: number) {
  const limitX = Math.max(0, (natural.value.width * scale.value - viewport.value.width) / 2);
  const limitY = Math.max(0, (natural.value.height * scale.value - viewport.value.height) / 2);
  offset.value = { x: clamp(x, -limitX, limitX), y: clamp(y, -limitY, limitY) };
}
// Points are relative to the viewport center. Keep the same image pixel under the cursor
// or between two fingers as their distance and midpoint change.
function zoomAt(value: number, from: Point, to: Point = from) {
  if (!natural.value.width) return;
  const next = clamp(value, fit.value, 4);
  const ratio = next / scale.value;
  zoom.value = next > fit.value ? next : null;
  pan(to.x - (from.x - offset.value.x) * ratio, to.y - (from.y - offset.value.y) * ratio);
}
function zoomIn() { zoomAt(scale.value * 1.5, { x: 0, y: 0 }); }
function zoomOut() { zoomAt(scale.value / 1.5, { x: 0, y: 0 }); }
function resetZoom() { zoom.value = null; offset.value = { x: 0, y: 0 }; }
defineExpose({ zoomIn, zoomOut, resetZoom, scale, canZoomIn, canZoomOut, isZoomed });

function measure() {
  const el = stage.value;
  if (!el) return;
  viewport.value = { width: el.clientWidth, height: el.clientHeight };
  if (zoom.value !== null && zoom.value <= fit.value) resetZoom();
  else pan(offset.value.x, offset.value.y);
}
function loaded(event: Event) {
  const el = event.currentTarget as HTMLImageElement;
  if (el !== image.value) return;
  natural.value = { width: el.naturalWidth, height: el.naturalHeight };
  measure();
  emit("dimensions", el.naturalWidth, el.naturalHeight);
}
watch(() => props.url, () => {
  natural.value = { width: 0, height: 0 };
  broken.value = false;
  pointers.clear();
  grabbing.value = false;
  suppressClick = true;
  resetZoom();
  emit("dimensions", 0, 0);
});
onMounted(() => {
  measure();
  if (stage.value && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(measure);
    observer.observe(stage.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());

function position(event: MouseEvent): Point {
  const rect = stage.value!.getBoundingClientRect();
  return { x: event.clientX - rect.left - viewport.value.width / 2,
    y: event.clientY - rect.top - viewport.value.height / 2 };
}
function wheel(event: WheelEvent) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.value.height : 1;
  const delta = clamp(event.deltaY * unit, -300, 300);
  if (!delta) return;
  if (pointers.size) suppressClick = true;
  zoomAt(scale.value * Math.exp(-delta * 0.0025), position(event));
}

function pointerDown(event: PointerEvent) {
  if (event.button !== 0 || pointers.size >= 2) return;
  const point = position(event);
  if (!pointers.size) {
    firstPress = point;
    suppressClick = isZoomed.value;
  } else suppressClick = true;
  pointers.set(event.pointerId, point);
  grabbing.value = true;
  stage.value?.setPointerCapture?.(event.pointerId);
}
function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function distance(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y); }
function pointerMove(event: PointerEvent) {
  const before = pointers.get(event.pointerId);
  if (!before) return;
  const now = position(event);
  pointers.set(event.pointerId, now);
  if (distance(now, firstPress) > 5) suppressClick = true;
  if (pointers.size === 2) {
    const otherId = [...pointers.keys()].find(id => id !== event.pointerId)!;
    const other = pointers.get(otherId)!;
    const oldDistance = distance(other, before);
    if (oldDistance > 0) zoomAt(scale.value * distance(other, now) / oldDistance, midpoint(other, before), midpoint(other, now));
  } else if (isZoomed.value) {
    pan(offset.value.x + now.x - before.x, offset.value.y + now.y - before.y);
  }
}
function pointerUp(event: PointerEvent) {
  if (!pointers.delete(event.pointerId)) return;
  // The last position is not guaranteed to have produced a pointermove.
  if (event.type !== "pointerup" || distance(position(event), firstPress) > 5) suppressClick = true;
  grabbing.value = pointers.size > 0;
}
function navigate(direction: -1 | 1) {
  if (!isZoomed.value && (direction < 0 ? props.canPrevious : props.canNext)) emit("navigate", direction);
}
function clickStage(event: MouseEvent) {
  if (event.button !== 0 || suppressClick) return;
  navigate(position(event).x < 0 ? -1 : 1);
}
</script>

<template>
  <div ref="stage" class="photo-stage" :class="{ enlarged: isZoomed, grabbing }" data-testid="photo-stage"
    tabindex="0" role="region" :aria-label="t('imageDetails.view')" @wheel.prevent="wheel"
    @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp"
    @pointercancel="pointerUp" @lostpointercapture="pointerUp" @click="clickStage">
    <p v-if="broken" role="status">{{ t("imageDetails.unsupported") }}</p>
    <img v-else-if="url" :key="url" ref="image" data-testid="photo-image" :src="url" :alt="name"
      :style="style" draggable="false" @load="loaded" @error="broken = true" />
    <template v-if="!isZoomed && (canPrevious || canNext)">
      <button type="button" class="photo-step previous" data-testid="photo-previous" :disabled="!canPrevious"
        :aria-label="t('imageDetails.previous')" :title="t('imageDetails.previous')" @pointerdown.stop @click.stop="navigate(-1)">
        <ChevronLeft aria-hidden="true" :size="24" />
      </button>
      <button type="button" class="photo-step next" data-testid="photo-next" :disabled="!canNext"
        :aria-label="t('imageDetails.next')" :title="t('imageDetails.next')" @pointerdown.stop @click.stop="navigate(1)">
        <ChevronRight aria-hidden="true" :size="24" />
      </button>
    </template>
  </div>
</template>

<style scoped>
.photo-stage {
  position: relative; display: grid; place-items: center; flex: 1; min-width: 0; min-height: 0;
  overflow: hidden; overscroll-behavior: contain; touch-action: none; user-select: none;
}
.photo-stage img {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: block; max-width: 100%; max-height: 100%; height: auto; cursor: grab;
}
.photo-stage.enlarged { cursor: grab; }
.photo-stage.grabbing, .photo-stage.grabbing img { cursor: grabbing; }
.photo-stage p { padding: 1rem; color: #e4e4e4; text-align: center; }
.photo-step {
  position: absolute; top: 50%; translate: 0 -50%; width: 44px; height: 44px;
  display: grid; place-items: center; border: 1px solid rgb(255 255 255 / .18);
  border-radius: 50%; color: #fff; background: rgb(18 18 18 / .65); cursor: pointer;
}
.photo-step.previous { left: max(.75rem, env(safe-area-inset-left)); }
.photo-step.next { right: max(.75rem, env(safe-area-inset-right)); }
.photo-step:disabled { visibility: hidden; }
.photo-step:enabled:hover { background: rgb(18 18 18 / .9); }
.photo-step:focus-visible, .photo-stage:focus-visible { outline-color: #fff; }
.photo-stage:focus-visible { outline-offset: -3px; }
</style>
