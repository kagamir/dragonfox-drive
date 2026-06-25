<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useSharesStore } from "@/stores/shares";
import type { FileMeta } from "@/api/types";

const props = defineProps<{ file: FileMeta }>();
const emit = defineEmits<{ close: [] }>();

const shares = useSharesStore();

const password = ref("");
const usePassword = ref(false);
const expiry = ref<"none" | "1d" | "7d" | "30d">("none");
const limitChoice = ref<"none" | "10" | "100">("none");
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
  if (expiry.value === "none") return null;
  const days = { "1d": 1, "7d": 7, "30d": 30 }[expiry.value];
  return new Date(Date.now() + days * 86400_000).toISOString();
}
function limitVal(): number | null {
  if (limitChoice.value === "none") return null;
  return Number(limitChoice.value);
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
        <select v-model="expiry" class="input">
          <option value="none">Never</option>
          <option value="1d">1 day</option>
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
        </select>

        <label class="row">Max opens</label>
        <select v-model="limitChoice" class="input">
          <option value="none">Unlimited</option>
          <option value="10">10</option>
          <option value="100">100</option>
        </select>

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
            <button class="link" :disabled="s.state === 'revoked'" @click="onRevoke(s.id)">Revoke</button>
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
</style>
