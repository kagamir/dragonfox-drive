<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useSharesStore } from "@/stores/shares";
import { useConfirm } from "@/composables/useConfirm";
import { useToast } from "@/composables/useToast";
import { useClipboard } from "@vueuse/core";
import type { FileMeta } from "@/api/types";
import DfModal from "@/components/ui/DfModal.vue";
import DfButton from "@/components/ui/DfButton.vue";
import DfInput from "@/components/ui/DfInput.vue";

const props = defineProps<{ file: FileMeta }>();
const emit = defineEmits<{ close: [] }>();

const shares = useSharesStore();
const confirm = useConfirm();
const toast = useToast();
const { copy: copyToClipboard, copied } = useClipboard({ source: "" });

const password = ref("");
const usePassword = ref(false);
const expiryValue = ref("");
const expiryUnit = ref<"minutes" | "hours" | "days">("days");
const limitInput = ref("");
const createdUrl = ref<string | null>(null);

const existing = computed(() => shares.byFile[props.file.id] ?? []);
const canCreate = computed(() => !shares.creating && (!usePassword.value || password.value.trim().length > 0));

onMounted(() => { void shares.load(props.file.id); });

function expiryTs(): string | null {
  const n = Number(expiryValue.value);
  if (!expiryValue.value || !n || n <= 0) return null;
  const ms = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[expiryUnit.value];
  return new Date(Date.now() + n * ms).toISOString();
}
function limitVal(): number | null {
  const n = Number(limitInput.value);
  return limitInput.value && n > 0 ? n : null;
}

async function onCreate() {
  try {
    const { url } = await shares.create(props.file.id, {
      password: usePassword.value ? password.value : undefined,
      expiresAt: expiryTs(),
      downloadLimit: limitVal(),
    });
    createdUrl.value = url;
    toast.success("分享链接已创建");
  } catch { /* store surfaces error */ }
}

async function doCopy() {
  if (!createdUrl.value) return;
  await copyToClipboard(createdUrl.value);
  toast.success("链接已复制");
}

async function onRevoke(id: string) {
  if (!(await confirm.confirm({ message: "撤销此分享？链接将立即失效。", danger: true, confirmText: "撤销" }))) return;
  try { await shares.revoke(props.file.id, id); toast.success("已撤销"); }
  catch { toast.error("撤销失败，请重试"); }
}
async function onDelete(id: string) {
  if (!(await confirm.confirm({ message: "永久删除此分享记录？此操作无法撤销。", danger: true, confirmText: "删除" }))) return;
  try { await shares.purge(id); await shares.load(props.file.id); toast.success("已删除"); }
  catch { toast.error("删除失败，请重试"); }
}
</script>

<template>
  <DfModal :open="true" :title="`分享 “${file.id.slice(0, 8)}”`" size="lg" @close="emit('close')">
    <div class="flex flex-col gap-4">
      <section v-if="!createdUrl" class="flex flex-col gap-3">
        <label class="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" v-model="usePassword" class="accent-brand" /> 密码保护
        </label>
        <DfInput v-if="usePassword" v-model="password" placeholder="密码" />

        <div>
          <p class="mb-1 text-sm font-medium text-fg">有效期</p>
          <div class="flex gap-2">
            <DfInput v-model="expiryValue" type="number" placeholder="永不" />
            <select v-model="expiryUnit" class="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg">
              <option value="minutes">分钟</option><option value="hours">小时</option><option value="days">天</option>
            </select>
          </div>
        </div>

        <div>
          <p class="mb-1 text-sm font-medium text-fg">最大打开次数</p>
          <DfInput v-model="limitInput" type="number" placeholder="不限" />
        </div>

        <DfButton :disabled="!canCreate || shares.creating" :loading="shares.creating" @click="onCreate">
          {{ shares.creating ? "创建中…" : "创建分享链接" }}
        </DfButton>
        <p v-if="usePassword && !password.trim()" class="text-xs text-danger">请先输入密码。</p>
        <p v-if="shares.error" class="text-xs text-danger">{{ shares.error }}</p>
      </section>

      <section v-else class="flex flex-col gap-3">
        <p class="text-xs text-fg-muted">分享链接（密钥仅存于 URL 片段，不会上传服务器）：</p>
        <code class="break-all rounded-lg bg-bg p-3 text-xs text-fg">{{ createdUrl }}</code>
        <div class="flex gap-2">
          <DfButton @click="doCopy">{{ copied ? "已复制" : "复制链接" }}</DfButton>
          <DfButton variant="ghost" @click="createdUrl = null">再建一个</DfButton>
        </div>
      </section>

      <section v-if="existing.length" class="border-t border-border pt-3">
        <h3 class="mb-2 text-sm font-semibold text-fg">已有分享</h3>
        <ul class="flex flex-col gap-1">
          <li v-for="s in existing" :key="s.id" class="flex items-center justify-between gap-2 border-b border-border py-2 last:border-0">
            <span class="text-xs text-fg-muted">{{ s.state }} · 打开 {{ s.download_count }}{{ s.download_limit ? "/" + s.download_limit : "" }}{{ s.requires_password ? " · 密码" : "" }}</span>
            <span class="flex gap-1">
              <DfButton variant="ghost" size="sm" :disabled="s.state === 'revoked'" @click="onRevoke(s.id)">撤销</DfButton>
              <DfButton variant="danger" size="sm" @click="onDelete(s.id)">删除</DfButton>
            </span>
          </li>
        </ul>
      </section>
    </div>
  </DfModal>
</template>
