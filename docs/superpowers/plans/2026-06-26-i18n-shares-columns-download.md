# DragonFox Drive UI 增量实施计划：i18n / 分享 Tab / 列分离 / 下载进度

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 UI 重设计基础上交付 4 项增量：i18n（en 为主 + zh）、分享独立 tab、文件列表 3 列分离、下载进度条。

**Architecture:** 引入 `vue-i18n`（Composition API），集中消息包 `web/src/locales/{en,zh}.ts`，按 `navigator.language` 自动探测 + `localStorage` 持久化；新增 `/shares` 路由与 `SharesView`（从 Settings 迁出）；`FileList` 列 grid 扩为 4 列并加状态排序；`files` store 新增 `activeDownloads` 会话跟踪，镜像上传的 `activeUploads`，配套 `DownloadQueueDrawer` 右下角浮层。

**Tech Stack:** Vue 3.5 + TS + Vite 6 + Pinia（现状）+ 新增 `vue-i18n`。测试 vitest 3 + @vue/test-utils。

## Global Constraints

（逐字来自 spec `docs/superpowers/specs/2026-06-26-i18n-shares-columns-download-design.md` + 沿用 2026-06-25 spec）

- **i18n**：支持 `en`（默认）+ `zh`；优先级 `localStorage["df-lang"]` > `navigator.language`（`zh*`→zh 否则 en）> `en`；`fallbackLocale: "en"`；后端 API 报错**不翻译**。
- **品牌/主题/令牌**：沿用 `#FF7A45`、明亮为主 + 暗色镜像、Tailwind v4 令牌、`Df*` 组件库、Headless UI。
- **不改**：crypto/MSE/libsodium；`fixLibsodiumImport` 等配置不动；不改上传队列（仅新增对称下载队列）。
- **验证命令**：`npm run typecheck --prefix web`、`npm run test --prefix web`、`npm run build --prefix web`。
- **TDD 纪律**：每任务先写失败测试；master + 每任务 auto-commit（用户既定）。
- **测试回归**：现有测试若硬编码中文字面量，改用 `data-testid` 或 `t(key)` 断言，不锁死语言。

## 文件结构映射

**新增：**
- `web/src/locales/index.ts` — createI18n 实例 + 探测 + 持久化。
- `web/src/locales/en.ts` + `zh.ts` — 消息包（common/auth/drive/share/settings/toast/dialog/status/theme）。
- `web/src/views/SharesView.vue` — 分享管理页（从 Settings 迁出）。
- `web/src/components/DownloadQueueDrawer.vue` — 右下角下载队列浮层。

**修改：**
- `web/package.json`（+vue-i18n）、`web/src/main.ts`（挂载 i18n）、`web/index.html`（防闪烁 lang 脚本）。
- `web/src/components/AppHeader.vue`（语言切换器 + 分享导航胶囊 + active 类型 + i18n）。
- `web/src/components/ui/*.vue`（DfEmpty/FileList 等文案 i18n）、`web/src/composables/{useToast,useConfirm,usePrompt}.ts`（默认文案 i18n）。
- `web/src/router/index.ts`（+/shares）、`web/src/components/FileList.vue`（4 列 + 状态排序）、`web/src/stores/files.ts`（下载会话）、`web/src/views/DriveView.vue`（挂下载队列 + i18n）。
- `web/src/views/{LoginView,RegisterView,NotFoundView,SettingsView,ShareView}.vue`（文案 i18n；Settings 移除分享 tab）。

---

## 阶段 A：i18n 基础设施

### Task 1: vue-i18n 集成 + 消息包 + 探测 + 防闪烁

**Files:**
- Modify: `web/package.json`（`npm i vue-i18n`）
- Create: `web/src/locales/index.ts`、`web/src/locales/en.ts`、`web/src/locales/zh.ts`
- Modify: `web/src/main.ts`（挂载 i18n）、`web/index.html`（防闪烁 lang 脚本）
- Test: `web/src/locales/locales.test.ts`

**Interfaces:**
- `i18n` 全局实例；`useI18n()` 的 `t`、`locale` 可用。
- `detectLocale(): string` — 探测优先级（localStorage > navigator > en）。
- `<html lang>` 在首屏前由 index.html 内联脚本设置。

- [ ] **Step 1: 写失败测试 `locales.test.ts`**

```ts
// web/src/locales/locales.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { detectLocale } from "./index";

describe("detectLocale", () => {
  beforeEach(() => localStorage.clear());

  it("localStorage df-lang wins", () => {
    localStorage.setItem("df-lang", "zh");
    expect(detectLocale("en-US")).toBe("zh");
  });
  it("navigator zh* → zh", () => {
    expect(detectLocale("zh-CN")).toBe("zh");
    expect(detectLocale("zh-TW")).toBe("zh");
  });
  it("navigator non-zh → en", () => {
    expect(detectLocale("en-US")).toBe("en");
    expect(detectLocale("fr-FR")).toBe("en");
  });
  it("falls back to en when nothing set", () => {
    expect(detectLocale(undefined)).toBe("en");
  });
});
```

- [ ] **Step 2: 运行确认失败** — `npm run test --prefix web -- src/locales/locales.test.ts`（模块不存在）

- [ ] **Step 3: 安装依赖** — `npm install --prefix web vue-i18n`

- [ ] **Step 4: 创建 en.ts（完整消息包）**

```ts
// web/src/locales/en.ts
export default {
  common: {
    appName: "DragonFox Drive",
    cancel: "Cancel", confirm: "Confirm", delete: "Delete", close: "Close",
    copy: "Copy", copied: "Copied", save: "Save", loading: "Loading…",
    back: "Back", search: "Search",
  },
  auth: {
    signIn: "Sign in", signingIn: "Signing in…", createAccount: "Create account",
    creating: "Creating…", username: "Username", password: "Password",
    confirmPassword: "Confirm password", noAccount: "No account?",
    createOne: "Create one", haveAccount: "Already registered?",
    tagline: "End-to-end encrypted · your password never leaves this device",
    mismatch: "Passwords do not match.",
    warnTitle: "Important",
    warnBody: "A master encryption key is derived from your password in the browser. Lose the password and your data is unrecoverable — there is no reset.",
    usernameHint: "3–32 chars: lowercase letters, digits, underscore, hyphen",
    regClosed: "Registration disabled",
    regClosedBody: "This instance is not accepting new accounts. Ask the operator, or sign in.",
  },
  drive: {
    myFiles: "My files", newFolder: "New folder", searchHere: "Search this folder…",
    upload: "Upload", uploading: "Uploading", name: "Name", size: "Size", status: "Status",
    prev: "Previous", next: "Next", page: "Page {cur} / {total}",
    empty: "Nothing here yet", emptyDesc: "Drop a file here, or click upload",
    folder: "Folder", selected: "{n} selected", move: "Move", moveTo: "Move to…",
    root: "Root", noOtherFolders: "No other folders.",
    folderName: "Folder name", rename: "Rename",
    deleteFolder: "Delete \"{name}\" and everything inside it? This cannot be undone.",
    deleteFile: "Delete \"{name}\"?",
    createFolderTitle: "New folder", renameTitle: "Rename", create: "Create",
  },
  share: {
    share: "Share", shares: "Shares", shareTitle: "Share \"{name}\"",
    passwordProtect: "Password protect", password: "Password",
    expiry: "Expiry", never: "Never", minutes: "minutes", hours: "hours", days: "days",
    maxOpens: "Max opens", unlimited: "Unlimited",
    createLink: "Create share link", creating: "Creating…",
    linkCreated: "Share link created", copied: "Link copied",
    createAnother: "Create another",
    linkHint: "Share link (the key lives only in the URL fragment):",
    enterPassword: "Enter a password first.",
    existing: "Existing shares",
    revoke: "Revoke", revokeConfirm: "Revoke this share? The link stops working immediately.",
    purge: "Delete", purgeConfirm: "Permanently delete this share record? This cannot be undone.",
    revoked: "Revoked", deleted: "Deleted", revokeFailed: "Failed to revoke the share.",
    deleteFailed: "Failed to delete the share.",
    opensCount: "opens {n}{limit}", withPassword: "· password",
    guestTitle: "Shared file", opening: "Opening…", protected: "This share is password-protected.",
    unlock: "Unlock", preview: "Preview", download: "Download", downloading: "Downloading…",
    unavailable: "Share unavailable.",
    noShares: "You have no shares.",
  },
  settings: {
    settings: "Settings", account: "Account", devices: "Devices",
    signedInAs: "Signed in as", signOut: "Sign out",
    revokeDeviceConfirm: "Revoke this device? It will be signed out immediately.",
    revokeDevice: "Revoke", deviceRevoked: "Revoked", revokeFailed: "Failed to revoke.",
    noDevices: "No registered devices.", currentDevice: "Current device",
    lastSeen: "Last seen", noShares: "You have no shares.",
  },
  toast: {
    uploaded: "Upload complete", deleted: "Deleted", moved: "Moved",
    renamed: "Renamed", created: "Created", moveFailed: "Move failed, please retry",
    linkCopied: "Link copied", copyFailed: "Copy failed",
  },
  dialog: { confirmTitle: "Please confirm", confirm: "Confirm", cancel: "Cancel" },
  status: { ready: "Ready", uploading: "Uploading", pending: "Pending", folder: "Folder" },
  theme: { light: "light", dark: "dark", auto: "auto", toggle: "Theme: {mode}" },
  notFound: { title: "Lost in the woods", desc: "This page doesn't exist or was removed.", back: "Back to drive" },
};
```

- [ ] **Step 5: 创建 zh.ts（同结构中文）**

```ts
// web/src/locales/zh.ts
export default {
  common: {
    appName: "DragonFox Drive",
    cancel: "取消", confirm: "确认", delete: "删除", close: "关闭",
    copy: "复制", copied: "已复制", save: "保存", loading: "正在加载…",
    back: "返回", search: "搜索",
  },
  auth: {
    signIn: "登录", signingIn: "登录中…", createAccount: "创建账号",
    creating: "创建中…", username: "用户名", password: "密码",
    confirmPassword: "确认密码", noAccount: "没有账号？",
    createOne: "创建一个", haveAccount: "已有账号？",
    tagline: "端到端加密 · 密码永不离开本机",
    mismatch: "两次密码不一致。",
    warnTitle: "重要",
    warnBody: "密码在浏览器内派生主加密密钥。忘记密码则数据不可恢复——无法重置。",
    usernameHint: "3–32 字符：小写字母、数字、下划线、连字符",
    regClosed: "注册已关闭",
    regClosedBody: "此实例不接受新账号注册。请联系管理员，或直接登录。",
  },
  drive: {
    myFiles: "我的文件", newFolder: "新建文件夹", searchHere: "搜索当前文件夹…",
    upload: "上传", uploading: "上传中", name: "名称", size: "大小", status: "状态",
    prev: "上一页", next: "下一页", page: "第 {cur} / {total} 页",
    empty: "这里还很空", emptyDesc: "拖拽文件到此处，或点击上传按钮",
    folder: "文件夹", selected: "已选 {n} 项", move: "移动", moveTo: "移动到…",
    root: "根目录", noOtherFolders: "没有其他文件夹。",
    folderName: "文件夹名称", rename: "重命名",
    deleteFolder: "删除“{name}”及其所有内容？此操作无法撤销。",
    deleteFile: "删除“{name}”？",
    createFolderTitle: "新建文件夹", renameTitle: "重命名", create: "创建",
  },
  share: {
    share: "分享", shares: "分享", shareTitle: "分享“{name}”",
    passwordProtect: "密码保护", password: "密码",
    expiry: "有效期", never: "永不", minutes: "分钟", hours: "小时", days: "天",
    maxOpens: "最大打开次数", unlimited: "不限",
    createLink: "创建分享链接", creating: "创建中…",
    linkCreated: "分享链接已创建", copied: "链接已复制",
    createAnother: "再建一个",
    linkHint: "分享链接（密钥仅存于 URL 片段，不会上传服务器）：",
    enterPassword: "请先输入密码。",
    existing: "已有分享",
    revoke: "撤销", revokeConfirm: "撤销此分享？链接将立即失效。",
    purge: "删除", purgeConfirm: "永久删除此分享记录？此操作无法撤销。",
    revoked: "已撤销", deleted: "已删除", revokeFailed: "撤销失败，请重试。",
    deleteFailed: "删除失败，请重试。",
    opensCount: "打开 {n}{limit}", withPassword: "· 密码",
    guestTitle: "共享文件", opening: "正在打开…", protected: "此分享受密码保护。",
    unlock: "解锁", preview: "预览", download: "下载", downloading: "下载中…",
    unavailable: "分享不可用。",
    noShares: "暂无分享。",
  },
  settings: {
    settings: "设置", account: "账户", devices: "设备",
    signedInAs: "登录身份", signOut: "退出登录",
    revokeDeviceConfirm: "吊销此设备？它将立即被登出。",
    revokeDevice: "吊销", deviceRevoked: "已吊销", revokeFailed: "吊销失败。",
    noDevices: "没有已注册设备。", currentDevice: "当前设备",
    lastSeen: "最后在线", noShares: "暂无分享。",
  },
  toast: {
    uploaded: "上传完成", deleted: "已删除", moved: "已移动",
    renamed: "已重命名", created: "已创建", moveFailed: "移动失败，请重试",
    linkCopied: "链接已复制", copyFailed: "复制失败",
  },
  dialog: { confirmTitle: "请确认", confirm: "确认", cancel: "取消" },
  status: { ready: "就绪", uploading: "上传中", pending: "等待", folder: "文件夹" },
  theme: { light: "浅色", dark: "深色", auto: "跟随系统", toggle: "切换主题（当前：{mode}）" },
  notFound: { title: "走丢了", desc: "这个页面不存在，或已被移除。", back: "返回网盘" },
};
```

- [ ] **Step 6: 创建 `locales/index.ts`**

```ts
// web/src/locales/index.ts
import { createI18n } from "vue-i18n";
import en from "./en";
import zh from "./zh";

export const SUPPORTED = ["en", "zh"] as const;
export type AppLocale = (typeof SUPPORTED)[number];

export function detectLocale(navLang?: string): AppLocale {
  const saved = localStorage.getItem("df-lang");
  if (saved === "en" || saved === "zh") return saved;
  const lang = navLang ?? (typeof navigator !== "undefined" ? navigator.language : "en");
  return lang && lang.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function setLocale(locale: AppLocale): void {
  localStorage.setItem("df-lang", locale);
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "en",
  messages: { en, zh },
  missingWarn: false,
  fallbackWarn: false,
});
```

- [ ] **Step 7: 挂载 i18n + 防闪烁**

`web/src/main.ts`：在 `app.use(createPinia())` 后加 `app.use(i18n);`，并 `import { i18n } from "./locales";`。

`web/index.html` `<head>` 现有主题脚本内追加 lang 设置（同一段 IIFE 内）：

```js
try {
  var l = localStorage.getItem("df-lang");
  var nl = (navigator.language || "en").toLowerCase();
  var loc = (l === "en" || l === "zh") ? l : (nl.indexOf("zh") === 0 ? "zh" : "en");
  document.documentElement.lang = loc;
} catch (e) {}
```

- [ ] **Step 8: 测试通过 + 全量验证 + Commit**

```bash
npm run test --prefix web -- src/locales/locales.test.ts
npm run typecheck --prefix web && npm run build --prefix web
```
```bash
git add web/package.json web/package-lock.json web/src/locales web/src/main.ts web/index.html
git commit -m "feat(i18n): vue-i18n + en/zh message packs + locale detection + anti-flash"
```

---

### Task 2: AppHeader 语言切换器 + 分享导航胶囊 + i18n

**Files:** `web/src/components/AppHeader.vue`、`web/src/components/AppHeader.test.ts`

**说明：** AppHeader 加语言切换器（Languages 图标 + DfDropdown：English/中文，调 `i18n.global.locale.value = x; setLocale(x)`）；加"分享"导航胶囊（RouterLink `/shares`）；`active` prop 类型扩展 `"drive" | "shares" | "settings"`；AppHeader 自身文案 i18n（`drive.myFiles`/`share.shares`/主题 tooltip/用户菜单"设置""退出登录"）。

- [ ] **Step 1: 更新 AppHeader.test.ts**（stub i18n 或用 real；断言切换器存在 + 分享链接存在）

```ts
// 追加用例
it("renders a language switcher and a shares nav link", () => {
  const w = mount(AppHeader, { props: { active: "drive", username: "a" }, global: { plugins: [router] } });
  expect(w.text()).toMatch(/My files/); // i18n 默认 en
  expect(w.findAll("a").some((a) => a.attributes("href")?.includes("shares"))).toBe(true);
});
```

- [ ] **Step 2: 改 AppHeader.vue**

```vue
<script setup lang="ts">
import { RouterLink, useRouter } from "vue-router";
import { Sun, Moon, Monitor, Upload, LogOut, Settings as SettingsIcon, Languages } from "lucide-vue-next";
import { useTheme } from "@/composables/useTheme";
import { useAuthStore } from "@/stores/auth";
import { i18n, setLocale, type AppLocale } from "@/locales";
import { useI18n } from "vue-i18n";
import DfButton from "@/components/ui/DfButton.vue";
import DfDropdown, { type DropdownItem } from "@/components/ui/DfDropdown.vue";
import DfTooltip from "@/components/ui/DfTooltip.vue";

defineProps<{ active: "drive" | "shares" | "settings"; username: string; showUpload?: boolean }>();
const emit = defineEmits<{ upload: [] }>();
const { t } = useI18n();
const theme = useTheme();
const auth = useAuthStore();
const router = useRouter();

const themeIcon = { light: Sun, dark: Moon, auto: Monitor } as const;
const themeStore = theme.store;
function cycleTheme() {
  const o = ["light", "dark", "auto"] as const;
  theme.store.value = o[(o.indexOf(theme.store.value as (typeof o)[number]) + 1) % o.length];
}
const langLabel = { en: "English", zh: "中文" } as const;
const langItems: DropdownItem[] = (["en", "zh"] as AppLocale[]).map((l) => ({
  label: langLabel[l],
  onClick: () => { i18n.global.locale.value = l; setLocale(l); },
}));
const menu: DropdownItem[] = [
  { label: t("settings.settings"), icon: SettingsIcon, onClick: () => router.push({ name: "settings" }) },
  { label: t("settings.signOut"), icon: LogOut, danger: true, onClick: async () => {
    await auth.logout(); router.push({ name: "login" });
  }},
];
</script>

<template>
  <header class="sticky top-0 z-30 flex items-center gap-4 border-b border-border bg-surface/90 px-4 py-2.5 backdrop-blur md:px-6">
    <RouterLink :to="{ name: 'drive' }" class="flex items-center gap-1.5 font-extrabold text-brand">
      <span>🦊</span><span class="hidden sm:inline">{{ t("common.appName") }}</span>
    </RouterLink>
    <nav class="flex items-center gap-1">
      <RouterLink :to="{ name: 'drive' }"
        :class="['rounded-full px-3 py-1.5 text-sm font-medium transition-colors', active==='drive' ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:text-fg']">
        {{ t("drive.myFiles") }}
      </RouterLink>
      <RouterLink :to="{ name: 'shares' }"
        :class="['rounded-full px-3 py-1.5 text-sm font-medium transition-colors', active==='shares' ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:text-fg']">
        {{ t("share.shares") }}
      </RouterLink>
    </nav>
    <div class="flex-1" />
    <DfButton v-if="showUpload" variant="primary" size="sm" @click="emit('upload')">
      <template #icon><Upload class="h-4 w-4" /></template>{{ t("drive.upload") }}
    </DfButton>
    <DfDropdown :items="langItems" align="right">
      <template #trigger>
        <button class="rounded-lg p-2 text-fg-muted hover:bg-bg hover:text-fg" :aria-label="t('theme.toggle', { mode: i18n.global.locale.value })">
          <Languages class="h-5 w-5" />
        </button>
      </template>
    </DfDropdown>
    <DfTooltip :label="t('theme.toggle', { mode: t('theme.' + (themeStore as unknown as string)) })">
      <button class="rounded-lg p-2 text-fg-muted hover:bg-bg hover:text-fg" :aria-label="t('theme.toggle', { mode: themeStore })" @click="cycleTheme">
        <component :is="themeIcon[themeStore as keyof typeof themeIcon]" class="h-5 w-5" />
      </button>
    </DfTooltip>
    <DfDropdown :items="menu" align="right">
      <template #trigger>
        <button class="flex h-8 w-8 items-center justify-center rounded-full bg-brand/15 text-sm font-semibold text-brand">
          {{ username.slice(0, 1).toUpperCase() }}
        </button>
      </template>
    </DfDropdown>
  </header>
</template>
```

> 注意：theme toggle 的 `themeStore` 在模板用法继承 Task 13 的修复模式；i18n.global.locale.value 读写当前语言。测试若因 `useI18n` 注入失败，在 mount 的 `global.plugins` 里加 `i18n`。

- [ ] **Step 3: 测试通过 + typecheck + Commit**

```bash
git add web/src/components/AppHeader.vue web/src/components/AppHeader.test.ts
git commit -m "feat(i18n): AppHeader language switcher + shares nav + i18n"
```

---

## 阶段 B：文案 i18n 化（提取）

### Task 3: UI 组件 + Services 默认文案 i18n 化

**Files:** `web/src/components/ui/DfEmpty.vue`、`web/src/components/FileList.vue`（列头/状态/空态文案）、`web/src/composables/{useToast,useConfirm,usePrompt}.ts`（默认文案）。

**说明：** 这些组件/服务大多不含硬编码文案，少数有：DfEmpty 的 title/description 由调用方传入（调用方负责 t()），故 DfEmpty 本身不改。FileList 的列头（名称/大小/状态）、状态徽章标签、空态文案需 i18n。useToast/useConfirm/usePrompt 的**默认**标题/按钮文案（`"请确认"`/`"确认"`/`"取消"`/`"输入"`）改为 `t("dialog.*")`（保留调用方覆盖 props）。

- [ ] **Step 1: FileList 列头/状态 i18n** — 在 FileList 用 `useI18n` 的 `t`：列头 `t("drive.name")/t("drive.size")/t("drive.status")`；状态 `statusLabel(s)` 改为 `t("status." + map[s])`；空态 `title:t("drive.empty") desc:t("drive.emptyDesc")`；文件夹标签 `t("drive.folder")`。

```ts
// FileList <script setup> 内
import { useI18n } from "vue-i18n";
const { t } = useI18n();
const STATUS_KEY: Record<string, string> = { ready: "ready", uploading: "uploading", pending: "pending" };
function statusLabel(s: string) { return t("status." + (STATUS_KEY[s] ?? "pending")); }
// 模板：{{ t("drive.name") }} / {{ t("drive.size") }} / {{ t("drive.status") }} / DfEmpty :title="t('drive.empty')"
```

- [ ] **Step 2: useConfirm/usePrompt 默认文案 i18n** — 默认 title/confirmText/cancelText 走 `i18n.global.t(...)`（composable 内直接用 `i18n.global`，非 useI18n，因 composable 可能不在 setup 内调用）。

```ts
// useConfirm.ts
import { i18n } from "@/locales";
// confirm() 内：
title: opts.title ?? i18n.global.t("dialog.confirmTitle"),
confirmText: opts.confirmText ?? i18n.global.t("dialog.confirm"),
cancelText: opts.cancelText ?? i18n.global.t("dialog.cancel"),
```
（usePrompt 同理：默认 title `t("...")`——但 prompt 标题语境相关，保留调用方必传 message，默认 confirmText `dialog.confirm` / cancelText `dialog.cancel`。）

- [ ] **Step 3: 验证 + Commit** — typecheck/test/build 全绿。

```bash
git add web/src/components/ui web/src/components/FileList.vue web/src/composables
git commit -m "feat(i18n): extract UI components + dialog services default copy"
```

---

### Task 4: Views 文案 i18n 化 + 现有测试更新

**Files:** `web/src/views/{LoginView,RegisterView,NotFoundView,DriveView,SettingsView,ShareView}.vue` + 相关 `.test.ts`

**说明：** 每个 view 用 `useI18n()` 的 `t`，把硬编码中文/英文文案替换为消息包 key。DriveView 的 toast 消息（`toast.deleted` 等）、确认框 message（调用方传 `t(...)`）、分页文案（`drive.page {cur,total}` 用 vue-i18n 插值 `t("drive.page", {cur, total})`）。NotFound 用 `notFound.*`。

**示例（LoginView 关键替换）：**
```ts
const { t } = useI18n();
// 模板：
// <h1>{{ t("auth.signIn") }}</h1>
// <DfInput v-model="username" :label="t('auth.username')" />
// {{ t("auth.tagline") }}
// {{ loading ? t("auth.signingIn") : t("auth.signIn") }}
```

**测试更新：** `DriveView.test.ts` 等若断言中文字面量（如 `/新建文件夹/`、`/Drive/`），改为按 `data-testid` 或 i18n key。给关键交互元素加 `data-testid`（如新建文件夹按钮 `data-testid="new-folder-btn"`），测试按 testid 断言，语言无关。

- [ ] **Step 1: 各 view 逐个 i18n 化**（Login/Register/NotFound 较短；Drive/Settings/Share 较长，按文案逐条替换）
- [ ] **Step 2: 关键交互元素加 data-testid**（new-folder-btn / upload-btn / 等），更新现有测试按 testid 断言
- [ ] **Step 3: 加 1 个 i18n 切换 smoke 测试**（mount LoginView，切 locale 为 zh，断言文案变中文）
- [ ] **Step 4: 验证 + Commit**

```bash
npm run typecheck --prefix web && npm run test --prefix web && npm run build --prefix web
git add web/src/views web/src/components
git commit -m "feat(i18n): extract all views copy + language-agnostic tests (data-testid)"
```

---

## 阶段 C：分享独立 Tab

### Task 5: SharesView + /shares 路由 + Settings 收敛

**Files:**
- Create: `web/src/views/SharesView.vue`
- Modify: `web/src/router/index.ts`（+/shares）、`web/src/views/SettingsView.vue`（移除分享 tab）、`web/src/views/SharesView.test.ts`（新）

**说明：** 把 SettingsView 的"分享"卡片 + `onRevoke`/`onDelete`/`nameOf`/`fileIdOf`/`opensOf`/`existing` 迁到新 SharesView。SettingsView 的 DfSegmented 收敛为账户/设备。AppHeader 的分享胶囊在 Task 2 已加。

- [ ] **Step 1: 创建 SharesView.vue**

```vue
<!-- web/src/views/SharesView.vue -->
<script setup lang="ts">
import { onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useSharesStore } from "@/stores/shares";
import { useFilesStore } from "@/stores/files";
import { useConfirm } from "@/composables/useConfirm";
import { useToast } from "@/composables/useToast";
import AppHeader from "@/components/AppHeader.vue";
import DfCard from "@/components/ui/DfCard.vue";
import DfButton from "@/components/ui/DfButton.vue";
import DfBadge from "@/components/ui/DfBadge.vue";
import DfEmpty from "@/components/ui/DfEmpty.vue";

const shares = useSharesStore();
const files = useFilesStore();
const confirm = useConfirm();
const toast = useToast();
const { t } = useI18n();

function nameOf(fileId: string) { return files.displayNames[fileId] ?? fileId.slice(0, 8); }
function fileIdOf(id: string) { return shares.all.find((s) => s.id === id)?.file_id ?? ""; }
function opensOf(s: { download_count: number; download_limit: number | null }) {
  return s.download_limit ? `${s.download_count}/${s.download_limit}` : `${s.download_count}/∞`;
}
async function onRevoke(id: string) {
  if (!(await confirm.confirm({ message: t("share.revokeConfirm"), danger: true, confirmText: t("share.revoke") }))) return;
  try { await shares.revoke(fileIdOf(id), id); toast.success(t("share.revoked")); }
  catch { toast.error(t("share.revokeFailed")); }
}
async function onDelete(id: string) {
  if (!(await confirm.confirm({ message: t("share.purgeConfirm"), danger: true, confirmText: t("common.delete") }))) return;
  try { await shares.purge(id); toast.success(t("share.deleted")); }
  catch { toast.error(t("share.deleteFailed")); }
}
onMounted(async () => { await files.refresh(); await shares.loadAll(); });
</script>

<template>
  <div class="min-h-screen bg-bg">
    <AppHeader :username="'me'" active="shares" />
    <main class="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
      <h1 class="mb-4 text-xl font-bold text-fg">{{ t("share.shares") }}</h1>
      <DfEmpty v-if="!shares.all.length" :title="t('share.noShares')" />
      <ul v-else class="flex flex-col gap-2">
        <li v-for="s in shares.all" :key="s.id" class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-3 text-xs">
          <span class="font-medium text-fg">{{ nameOf(s.file_id) }}</span>
          <span class="text-fg-muted">{{ opensOf(s) }}{{ s.requires_password ? " · " + t("share.withPassword") : "" }}</span>
          <span class="flex items-center gap-2">
            <DfBadge :variant="s.state === 'active' ? 'ok' : 'neutral'">{{ s.state }}</DfBadge>
            <DfButton variant="ghost" size="sm" :disabled="s.state === 'revoked'" @click="onRevoke(s.id)">{{ t("share.revoke") }}</DfButton>
            <DfButton variant="danger" size="sm" @click="onDelete(s.id)">{{ t("share.purge") }}</DfButton>
          </span>
        </li>
      </ul>
    </main>
  </div>
</template>
```

> 注：`AppHeader :username` 应从 auth store 取——SharesView 内 `useAuthStore` 拿 username（与 Settings/Drive 一致）。上面 `'me'` 为占位，实现时用 `auth.username`。

- [ ] **Step 2: 加 /shares 路由**

`web/src/router/index.ts` routes 数组内 `/drive` 后加：

```ts
{
  path: "/shares",
  name: "shares",
  component: () => import("@/views/SharesView.vue"),
  meta: { requiresAuth: true },
},
```

- [ ] **Step 3: SettingsView 收敛** — 删除"分享" DfSegmented 选项 + 分享卡片渲染 + `onRevoke`/`onDelete`/`nameOf`/`fileIdOf`/`opensOf`；DfSegmented tab 选项收敛为账户/设备；保留 devices 逻辑。

- [ ] **Step 4: SharesView.test.ts**（stub stores，断言渲染分享列表 + 撤销确认流）

- [ ] **Step 5: 验证 + Commit**

```bash
npm run typecheck --prefix web && npm run test --prefix web && npm run build --prefix web
git add web/src/views/SharesView.vue web/src/views/SharesView.test.ts web/src/views/SettingsView.vue web/src/router/index.ts
git commit -m "feat(share): SharesView + /shares route; remove shares tab from Settings"
```

---

## 阶段 D：文件列表 3 列 + 状态排序

### Task 6: FileList 4 列 grid + 状态排序

**Files:** `web/src/components/FileList.vue`、`web/src/components/FileList.test.ts`

- [ ] **Step 1: 改 grid 为 4 列** — 列表 `<li>` 与列头 grid 从 `grid-cols-[auto_1fr_auto]` → `grid-cols-[auto_1fr_auto_auto]`。大小 span 独占第 3 列；状态徽章 + ⋯ 菜单 共占第 4 列。列头 3 个 sortable 按钮（名称/大小/状态），第 4 列头空。

```vue
<!-- 列头 -->
<div class="grid grid-cols-[auto_1fr_auto_auto] gap-3 border-b border-border px-3 pb-2 text-xs font-medium text-fg-muted">
  <span class="w-4" />
  <button @click="onSort('name')">{{ t("drive.name") }} <span v-if="sortKey==='name'">{{ sortDir==='asc'?'▲':'▼' }}</span></button>
  <button class="hidden sm:block" @click="onSort('size')">{{ t("drive.size") }} <span v-if="sortKey==='size'">{{ sortDir==='asc'?'▲':'▼' }}</span></button>
  <button @click="onSort('status')">{{ t("drive.status") }} <span v-if="sortKey==='status'">{{ sortDir==='asc'?'▲':'▼' }}</span></button>
</div>
<!-- 行 -->
<li class="grid grid-cols-[auto_1fr_auto_auto] ...">
  <input type="checkbox" ... />
  <div class="flex min-w-0 items-center gap-3"> <FileTypeIcon/> <button>{{ name }}</button> </div>
  <span class="hidden text-xs text-fg-muted sm:block">{{ fmtSize(...) }}</span>  <!-- 第3列 -->
  <div class="flex items-center gap-3">  <!-- 第4列 -->
    <DfBadge>{{ statusLabel }}</DfBadge> 或 文件夹文字
    <DfDropdown :items="itemsFor(e)">...</DfDropdown>
  </div>
</li>
```

- [ ] **Step 2: 状态排序** — `sortKey` 类型加 `"status"`；`sorted` computed 加 status 分支：文件夹置顶（-1），文件按 `STATUS_RANK[status]`（ready=0/uploading=1/pending=2/deleted=3），乘 dir。

```ts
const STATUS_RANK: Record<string, number> = { ready: 0, uploading: 1, pending: 2, deleted: 3 };
// sorted computed 内 status 分支：
const ra = a.kind === "folder" ? -1 : STATUS_RANK[a.file.status] ?? 9;
const rb = b.kind === "folder" ? -1 : STATUS_RANK[b.file.status] ?? 9;
return dir * (ra - rb);
```

- [ ] **Step 3: FileList.test.ts 加用例** — status 排序（ready 在 uploading 前）；3 列渲染（大小/状态分离）。

- [ ] **Step 4: 验证 + Commit**

```bash
npm run typecheck --prefix web && npm run test --prefix web && npm run build --prefix web
git add web/src/components/FileList.vue web/src/components/FileList.test.ts
git commit -m "feat(ui): FileList 4-column grid (name/size/status) + status sort"
```

---

## 阶段 E：下载进度

### Task 7: files store 下载会话 + 取消

**Files:** `web/src/stores/files.ts`、`web/src/stores/files.test.ts`（若无则新建/扩展）

**说明：** `getChunk` 已支持 `signal`（`api/files.ts:68`），无需改 API。

- [ ] **Step 1: 加 DownloadSession + activeDownloads + cancelDownload**

```ts
// files.ts 顶部接口区
export interface DownloadSession {
  fileId: string;
  name: string;
  progress: number; // 0..1
  phase: "downloading" | "done" | "error";
  abort: AbortController;
}

// store 内
const activeDownloads = ref<DownloadSession[]>([]);

async function download(meta: FileMeta): Promise<void> {
  downloading.value = true;
  error.value = null;
  const session: DownloadSession = {
    fileId: meta.id,
    name: displayNames.value[meta.id] ?? meta.id,
    progress: 0, phase: "downloading", abort: new AbortController(),
  };
  activeDownloads.value.push(session);
  try {
    await ensureCryptoReady();
    const { fileKey, manifest } = await unlockFile(meta);
    const ivBase = fromBase64(manifest.iv_base);
    const n = meta.chunk_count;
    const parts = new Array<Uint8Array>(n);
    const done = new Set<number>();
    await asyncPool(3, Array.from({ length: n }, (_, i) => i), async (i) => {
      if (session.abort.signal.aborted) return;
      const resp = await filesApi.getChunk(meta.id, i, session.abort.signal);
      const cipher = new Uint8Array(await resp.arrayBuffer());
      parts[i] = await cryptoApi.decryptChunk(fileKey, ivBase, i, cipher);
      done.add(i);
      session.progress = done.size / n;
    });
    if (session.abort.signal.aborted) return;
    saveBlob(new Blob(parts as BlobPart[], { type: manifest.mime }), manifest.name);
    session.phase = "done";
    setTimeout(() => {
      const idx = activeDownloads.value.indexOf(session);
      if (idx >= 0) activeDownloads.value.splice(idx, 1);
    }, 1500);
  } catch (e) {
    session.phase = "error";
    error.value = (e as Error).message;
    throw e;
  } finally {
    downloading.value = false;
  }
}

async function cancelDownload(fileId: string): Promise<void> {
  const s = activeDownloads.value.find((x) => x.fileId === fileId);
  if (!s) return;
  s.abort.abort();
  const idx = activeDownloads.value.indexOf(s);
  if (idx >= 0) activeDownloads.value.splice(idx, 1);
}

// return 加：activeDownloads, cancelDownload
```

- [ ] **Step 2: 测试**（mock unlockFile/asyncPool 或 getChunk）— 断言 download 推入 activeDownloads、progress 递增、cancelDownload 移除。

- [ ] **Step 3: 验证 + Commit**

```bash
npm run typecheck --prefix web && npm run test --prefix web && npm run build --prefix web
git add web/src/stores/files.ts web/src/stores/files.test.ts
git commit -m "feat(download): files store tracks activeDownloads + progress + cancel"
```

---

### Task 8: DownloadQueueDrawer + DriveView 挂载

**Files:** Create `web/src/components/DownloadQueueDrawer.vue` + `.test.ts`；Modify `web/src/views/DriveView.vue`

- [ ] **Step 1: 创建 DownloadQueueDrawer.vue**（镜像 UploadQueueDrawer，右下角，Teleport，进度条 + cancel emit）

```vue
<!-- web/src/components/DownloadQueueDrawer.vue -->
<script setup lang="ts">
import { X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
defineProps<{ downloads: { fileId: string; name: string; progress: number; phase: string }[] }>();
defineEmits<{ cancel: [string] }>();
const { t } = useI18n();
</script>
<template>
  <Teleport to="body">
    <div v-if="downloads.length" class="fixed bottom-4 right-4 z-[55] w-80 rounded-xl border border-border bg-surface shadow-lg">
      <div class="border-b border-border px-4 py-2.5 text-sm font-semibold text-fg">{{ t("share.download") }} ({{ downloads.length }})</div>
      <ul class="max-h-72 overflow-auto">
        <li v-for="d in downloads" :key="d.fileId" class="flex items-center gap-2 px-4 py-2.5">
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium text-fg">{{ d.name }}</p>
            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-bg">
              <div class="h-full rounded-full bg-brand transition-all" :style="{ width: Math.round(d.progress * 100) + '%' }" />
            </div>
          </div>
          <span class="text-[10px] text-fg-muted">{{ d.phase }}</span>
          <button class="text-fg-muted hover:text-danger" @click="$emit('cancel', d.fileId)"><X class="h-4 w-4" /></button>
        </li>
      </ul>
    </div>
  </Teleport>
</template>
```

- [ ] **Step 2: DriveView 挂载** — `<DownloadQueueDrawer :downloads="files.activeDownloads" @cancel="(id) => files.cancelDownload(id)" />`，紧邻 `<UploadQueueDrawer>`。import 组件。

- [ ] **Step 3: DownloadQueueDrawer.test.ts**（同 UploadQueueDrawer：empty→无渲染；一项→进度条+cancel emit；Teleport 查 document.body）

- [ ] **Step 4: 验证 + Commit**

```bash
npm run typecheck --prefix web && npm run test --prefix web && npm run build --prefix web
git add web/src/components/DownloadQueueDrawer.vue web/src/components/DownloadQueueDrawer.test.ts web/src/views/DriveView.vue
git commit -m "feat(download): DownloadQueueDrawer + mount in DriveView"
```

---

## 阶段 F：回归与验收

### Task 9: 全量回归 + 残留硬编码扫描 + 验收

**Files:** 全仓扫描，无新代码（仅可能零星补漏）

- [ ] **Step 1: 扫描残留中英文硬编码** — `grep -rnE "[一-龥]" web/src --include="*.vue" --include="*.ts"`，逐一甄别：locales/ 内的 zh.ts 是合法的；其余 `.vue`/composables 内的中文应为零（已迁到消息包）。补漏并提交。

- [ ] **Step 2: 全量自动化验收**

```bash
npm run typecheck --prefix web   # 0 errors
npm run test --prefix web        # all green (含新 i18n/列/下载/分享测试)
npm run build --prefix web       # green, libsodium intact
```

- [ ] **Step 3: 人工验收清单**

- [ ] 语言：浏览器中文环境→自动中文；切 English→全站英文；刷新保持；API 报错仍为后端原文。
- [ ] 分享：顶栏"分享"胶囊进入 `/shares`；列表+撤销+删除正常；Settings 无分享 tab。
- [ ] 列：列表 4 列（名称/大小/状态）；状态排序生效；移动端隐藏大小列。
- [ ] 下载：点下载→右下角浮层+进度条；取消中断；多文件并行；错误态可见。
- [ ] 回归：登录/注册/上传/预览/分享创建/设备吊销全流程 OK。

- [ ] **Step 4: Commit（如有补漏）**

```bash
git add -A web/src
git commit -m "chore(i18n): final hardcopy cleanup" || echo "nothing to clean"
```

---

## 自审

- **Spec 覆盖**：i18n（T1–T4）、分享 tab（T2 胶囊 + T5 页面/路由）、列分离（T6）、下载进度（T7 store + T8 drawer）、测试回归（各任务 TDD + T9）。每项均有任务。
- **占位符**：无 TBD；Task 5 的 `'me'` 占位已在说明里标注用 `auth.username`。
- **类型一致**：`DownloadSession`、`detectLocale`/`setLocale`/`AppLocale`、`active` prop 类型在跨任务引用处一致。
- **风险关口**：Task 1 build 验证 vue-i18n 与 libsodium 共存；Task 4 测试改 testid 避免语言锁死；Task 7 getChunk signal 已确认存在。

**Plan 完成。** 9 个任务，6 阶段（A i18n 基础 / B 文案提取 / C 分享 tab / D 列分离 / E 下载进度 / F 验收）。
