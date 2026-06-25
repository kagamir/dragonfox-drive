<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useSharesStore } from "@/stores/shares";
import type { FileMeta } from "@/api/types";

const props = defineProps<{ file: FileMeta }>();
const emit = defineEmits<{ close: [] }>();

const shares = useSharesStore();

const password = ref("");
const usePassword = ref(false);
const expiryValue = ref<number | null>(null);
const expiryUnit = ref<"minutes" | "hours" | "days">("days");
const limitInput = ref<number | null>(null);
const createdUrl = ref<string | null>(null);
const copied = ref(false);

const existing = computed(() => shares.byFile[props.file.id] ?? []);
const canCreate = computed(
  () => !shares.creating && (!usePassword.value || password.value.trim().length > 0),
);

onMounted(() => {
  void shares.load(props.file.id);
});

function expiryTs(): string | null {
  const n = expiryValue.value;
  if (!n || n <= 0) return null;
  const ms = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[expiryUnit.value];
  return new Date(Date.now() + n * ms).toISOString();
}
function limitVal(): number | null {
  const n = limitInput.value;
  return n && n > 0 ? n : null;
}

async function onCreate() {
  copied.value = false;
  try {
    const { url } = await shares.create(props.file.id, {
      password: usePassword.value ? password.value : undefined,
      expiresAt: expiryTs(),
      downloadLimit: limitVal(),
    });
    createdUrl.value = url;
  } catch {
    /* error surfaced in store */
  }
}

async function copy() {
  if (!createdUrl.value) return;
  await navigator.clipboard.writeText(createdUrl.value);
  copied.value = true;
}

async function onRevoke(id: string) {
  if (!confirm("Revoke this share? The link stops working immediately.")) return;
  try {
    await shares.revoke(props.file.id, id);
  } catch {
    alert("Failed to revoke the share. Please try again.");
  }
}

async function onDelete(id: string) {
  if (!confirm("Permanently delete this share record? This cannot be undone.")) return;
  try {
    await shares.purge(id);
    await shares.load(props.file.id);
  } catch {
    alert("Failed to delete the share. Please try again.");
  }
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="card">
      <header>
        <span class="title">Share "{{ file.id.slice(0, 8) }}"</span>
        <button class="link" @click="emit('close')">Close</button>
      </header>

      <section v-if="!createdUrl">
        <label class="row"><input type="checkbox" v-model="usePassword" /> Password protect</label>
        <input v-if="usePassword" v-model="password" type="text" placeholder="password" class="input" />

        <label class="row">Expiry</label>
        <div class="pair">
          <input v-model.number="expiryValue" type="number" min="1" placeholder="Never" class="input" />
          <select v-model="expiryUnit" class="input unit">
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>

        <label class="row">Max opens</label>
        <input v-model.number="limitInput" type="number" min="1" placeholder="Unlimited" class="input" />

        <button class="primary" :disabled="!canCreate" @click="onCreate">
          {{ shares.creating ? "Creating…" : "Create share link" }}
        </button>
        <p v-if="usePassword && !password.trim()" class="error">Enter a password first.</p>
        <p v-if="shares.error" class="error">{{ shares.error }}</p>
      </section>

      <section v-else>
        <p class="muted">Share link (the key lives only in the URL fragment):</p>
        <code class="url">{{ createdUrl }}</code>
        <button class="primary" @click="copy">{{ copied ? "Copied!" : "Copy link" }}</button>
        <button class="link" @click="createdUrl = null">Create another</button>
      </section>

      <section v-if="existing.length">
        <h3>Existing shares</h3>
        <ul class="list">
          <li v-for="s in existing" :key="s.id">
            <span class="meta">{{ s.state }} · opens {{ s.download_count }}{{ s.download_limit ? "/" + s.download_limit : "" }}{{ s.requires_password ? " · password" : "" }}</span>
            <span class="btns">
              <button class="link" :disabled="s.state === 'revoked'" @click="onRevoke(s.id)">Revoke</button>
              <button class="link danger" @click="onDelete(s.id)">Delete</button>
            </span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 50; }
.card { background: var(--df-color-bg-elevated); border-radius: var(--df-radius-sm); padding: 1.5rem; width: 100%; max-width: 560px; display: flex; flex-direction: column; gap: 0.75rem; max-height: 90vh; overflow: auto; }
header { display: flex; justify-content: space-between; align-items: center; }
.title { font-weight: 700; }
.row { display: block; margin-top: 0.5rem; }
.input { width: 100%; padding: 0.4rem; background: var(--df-color-bg); border: 1px solid var(--df-color-border); border-radius: var(--df-radius-sm); color: inherit; }
.primary { padding: 0.5rem 1rem; background: var(--df-color-accent, #406); color: #fff; border: 0; border-radius: var(--df-radius-sm); cursor: pointer; margin-top: 0.5rem; }
.primary:disabled { opacity: 0.5; cursor: default; }
.link { background: transparent; border: 0; color: var(--df-color-fg-muted); cursor: pointer; }
.url { display: block; word-break: break-all; background: var(--df-color-bg); padding: 0.5rem; border-radius: var(--df-radius-sm); }
.muted { color: var(--df-color-fg-muted); }
.error { color: #c0392b; }
.list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.3rem; }
.list li { display: flex; justify-content: space-between; align-items: center; padding: 0.3rem 0; border-bottom: 1px solid var(--df-color-border); }
.meta { color: var(--df-color-fg-muted); font-size: 0.85rem; }
h3 { margin: 0.5rem 0 0; font-size: 1rem; }
.pair { display: flex; gap: 0.5rem; }
.pair .unit { flex: 0 0 7rem; }
.btns { display: flex; gap: 0.75rem; }
.danger { color: #c0392b; }
</style>
