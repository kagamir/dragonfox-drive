<script setup lang="ts">
import { onMounted } from "vue";
import { useAuthStore } from "@/stores/auth";
import { useSharesStore } from "@/stores/shares";
import { useFilesStore } from "@/stores/files";

const auth = useAuthStore();
const shares = useSharesStore();
const files = useFilesStore();

function nameOf(fileId: string): string {
  return files.displayNames[fileId] ?? fileId.slice(0, 8);
}
function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}
function opensOf(s: { download_count: number; download_limit: number | null }): string {
  return s.download_limit ? `${s.download_count}/${s.download_limit}` : `${s.download_count}/∞`;
}
function fileIdOf(id: string): string {
  return shares.all.find((s) => s.id === id)?.file_id ?? "";
}

async function onRevoke(id: string) {
  if (!confirm("Revoke this share? The link stops working immediately (record kept).")) return;
  try {
    await shares.revoke(fileIdOf(id), id);
  } catch {
    alert("Failed to revoke the share.");
  }
}

async function onDelete(id: string) {
  if (!confirm("Permanently delete this share record? This cannot be undone.")) return;
  try {
    await shares.purge(id);
  } catch {
    alert("Failed to delete the share.");
  }
}

onMounted(async () => {
  await files.refresh();
  await shares.loadAll();
});
</script>

<template>
  <main class="page">
    <header class="bar">
      <RouterLink :to="{ name: 'drive' }">Back</RouterLink>
    </header>
    <section class="content">
      <h1>Settings</h1>
      <div class="card">
        <h2>Account</h2>
        <p>Signed in as <strong>{{ auth.username }}</strong></p>
      </div>
      <div class="card">
        <h2>Devices</h2>
        <p class="muted">Device management will be added in P4.</p>
      </div>
      <div class="card">
        <h2>Shares</h2>
        <p v-if="!shares.all.length" class="muted">You have no shares.</p>
        <table v-else class="shares">
          <thead>
            <tr>
              <th>File</th><th>Created</th><th>Expires</th><th>Opens</th>
              <th>Password</th><th>State</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in shares.all" :key="s.id">
              <td class="name">{{ nameOf(s.file_id) }}</td>
              <td>{{ fmt(s.created_at) }}</td>
              <td>{{ fmt(s.expires_at) }}</td>
              <td>{{ opensOf(s) }}</td>
              <td>{{ s.requires_password ? "yes" : "no" }}</td>
              <td>{{ s.state }}</td>
              <td class="actions">
                <button class="link" :disabled="s.state === 'revoked'" @click="onRevoke(s.id)">Revoke</button>
                <button class="link danger" @click="onDelete(s.id)">Delete</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</template>

<style scoped>
.page { display: flex; flex-direction: column; min-height: 100vh; }
.bar { padding: 0.8rem 1.5rem; border-bottom: 1px solid var(--df-color-border); background: var(--df-color-bg-elevated); }
.content { padding: 2rem 1.5rem; max-width: 900px; width: 100%; margin: 0 auto; }
h1 { margin: 0 0 1rem; font-size: 1.4rem; }
.card { background: var(--df-color-bg-elevated); border: 1px solid var(--df-color-border); border-radius: var(--df-radius-md); padding: 1.25rem; margin-bottom: 1rem; }
.card h2 { margin: 0 0 0.5rem; font-size: 1.05rem; }
.muted { color: var(--df-color-fg-muted); }
.shares { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
.shares th, .shares td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--df-color-border); }
.shares th { color: var(--df-color-fg-muted); font-weight: 600; }
.name { word-break: break-all; }
.actions { white-space: nowrap; }
.link { background: transparent; border: 0; color: var(--df-color-fg-muted); cursor: pointer; }
.link:disabled { opacity: 0.4; cursor: default; }
.danger { color: #c0392b; }
</style>
