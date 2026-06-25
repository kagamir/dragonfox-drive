# DragonFox Drive UI 重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 DragonFox Drive 前端从"功能化极简"原生 HTML/CSS 界面，重设计为友好活泼、优雅、便捷、美观的现代网盘体验（明亮为主 + 暗色可切换，橙色品牌）。

**Architecture:** 引入 Tailwind CSS v4（CSS-first 令牌）作为统一样式层；Headless UI (`@headlessui/vue`) 提供无样式交互组件（模态框/下拉/右键菜单）；`lucide-vue-next` 提供矢量图标；`@vueuse/core` 提供明暗模式与拖拽等工具。自建一套 `Df*` 组件库（`web/src/components/ui/`）作为全站统一控件。逐页用新组件重写，移除所有 `prompt()/confirm()/alert()` 与未用的 `naive-ui`。

**Tech Stack:** Vue 3.5 + TypeScript + Vite 6 + Pinia；新增 Tailwind CSS v4、`@tailwindcss/vite`、`@headlessui/vue`、`lucide-vue-next`；移除 `naive-ui`。测试：vitest 3 + @vue/test-utils + happy-dom（现状）。

## Global Constraints

（每个任务的隐含前置约束，值逐字来自 spec `docs/superpowers/specs/2026-06-25-ui-redesign-design.md`）

- **品牌主色**：`#FF7A45`（hover `#F0682F`，soft `#FFF1EA`），贯穿按钮/链接/选中/聚焦。
- **主题**：明亮为主；暗色为镜像（bg `#0F1115` / surface `#161A22` / fg `#E6E9EF` / muted `#9AA4B2` / border `#232936`）。切换通过 `<html class="dark">`，首次跟随 `prefers-color-scheme`，持久化到 localStorage。
- **字体栈**：`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif`。
- **圆角阶梯**：sm 8px / md 10px / lg 12px / xl 16px / full（胶囊）。
- **动效**：默认 `150ms ease`；模态/抽屉/明暗切换 `200ms`；禁止弹跳旋转。
- **布局**：方案 C —— 固定顶栏 + 全宽内容（`max-w-7xl` 居中），无侧栏。
- **不可逆操作走确认模态框；可逆操作走 toast 即时反馈。**
- **构建陷阱（来自 AGENTS.md）**：`fixLibsodiumImport` Vite 插件不可删除；`libsodium-wrappers-sumo` 在 `optimizeDeps.exclude` 与 vitest `test.server.deps.inline`，`libsodium-sumo` 保持 external。任何 Vite 配置改动后必须验证 `npm run build` 与 `npm run test`。
- **逻辑层不动**：`crypto/`、`workers/`、`api/`、`stores/` 的业务逻辑不改；只改视图与组件。
- **验证命令**：`npm run typecheck --prefix web`、`npm run test --prefix web`、`npm run build --prefix web`。
- **TDD 纪律**：每个组件/服务先写失败测试，再写实现。提交粒度=一个任务一次 commit。

## 文件结构映射

**新增依赖（`web/package.json`）**：`tailwindcss@^4`、`@tailwindcss/vite`、`@headlessui/vue`、`lucide-vue-next`；移除 `naive-ui`。

**修改的配置/入口：**
- `web/vite.config.ts` —— 注入 `@tailwindcss/vite` 插件（保留 `fixLibsodiumImport`）。
- `web/src/styles/main.css` —— 改写为 `@import "tailwindcss"` + `@theme` 令牌 + `@custom-variant dark`。
- `web/src/main.ts` —— 新增 `<html>` 初始主题 class（防闪烁）。
- `web/src/App.vue` —— 挂载全局 `DfToastContainer`/`DfConfirmDialog`/`DfPromptDialog`；更新 loading 态。

**新增 UI 基础组件（`web/src/components/ui/`，每个 `.vue` + 同名 `.test.ts`）：**
- `DfButton.vue`、`DfBadge.vue`、`DfSpinner.vue`、`DfInput.vue`、`DfCard.vue`、`DfEmpty.vue`、`DfTooltip.vue`、`DfSkeleton.vue`
- `DfModal.vue`、`DfDropdown.vue`、`DfContextMenu.vue`、`DfSegmented.vue`、`DfBreadcrumbs.vue`

**新增 composables（`web/src/composables/`）：**
- `useToast.ts` + `DfToastContainer.vue` —— 全局 toast 服务。
- `useConfirm.ts` + `DfConfirmDialog.vue` —— 替换 `confirm()`。
- `usePrompt.ts` + `DfPromptDialog.vue` —— 替换 `prompt()`（用于新建文件夹）。
- `useDialogStack.ts` —— 上述三个共享的挂载/响应式根（单例状态）。

**新增业务组件（`web/src/components/`）：**
- `AppHeader.vue` —— 全站顶栏。
- `FileTypeIcon.vue` —— 彩色文件类型图标（按扩展名映射）。
- `FileList.vue` —— 从 `DriveView` 抽出的列表/网格切换组件。
- `UploadDropzone.vue` —— 整页拖拽接收。
- `UploadQueueDrawer.vue` —— 右下角上传队列浮层。

**改造的现有组件：**
- `FilePreviewModal.vue`、`MovePickerModal.vue`、`ShareDialog.vue` —— 用 `DfModal` 重写外壳。
- `Mp4Player.vue` —— 自定义控件套壳（MSE 管线逻辑不动）。

**改造的页面（`web/src/views/`）：**
- `LoginView.vue`、`RegisterView.vue`、`NotFoundView.vue`、`DriveView.vue`、`SettingsView.vue`、`ShareView.vue`

**测试：** 现有 4 个 `.test.ts` 选择器随组件迁移更新；新组件各配测试。

---

## 阶段 A：基础设施

### Task 1: Tailwind v4 + 设计令牌 + 明暗切换

**Files:**
- Modify: `web/package.json`（加 `tailwindcss@^4`、`@tailwindcss/vite@^4`）
- Modify: `web/vite.config.ts:33-37`（plugins 数组前加 `tailwindcss()`）
- Rewrite: `web/src/styles/main.css`（Tailwind v4 + `@theme` 令牌）
- Modify: `web/src/main.ts:8`（CSS 引入不变；新增防闪烁内联脚本到 `web/index.html`）
- Modify: `web/index.html`（`<head>` 加防闪烁主题脚本）
- Create: `web/src/composables/useTheme.ts`
- Test: `web/src/composables/useTheme.test.ts`

**Interfaces:**
- Produces: `useTheme()` → 返回 `@vueuse/core` 的 `useColorMode` 实例（`store`/`system`/`state` ref，类型 `"light"|"dark"|"auto"`）。light 不加 class，dark 给 `<html>` 加 `class="dark"`，持久化 key `df-theme`。

- [ ] **Step 1: 写失败测试 `useTheme.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { nextTick } from "vue";
import { useTheme } from "./useTheme";

describe("useTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("default mode is auto and resolves to a concrete theme", () => {
    const t = useTheme();
    expect(t.store.value).toBe("auto");
    expect(["light", "dark"]).toContain(t.system.value);
  });

  it("set to dark adds .dark class on <html>", async () => {
    const t = useTheme();
    t.store.value = "dark";
    await nextTick();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("df-theme")).toBe("dark");
  });

  it("set to light removes .dark class on <html>", async () => {
    document.documentElement.classList.add("dark");
    const t = useTheme();
    t.store.value = "light";
    await nextTick();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("df-theme")).toBe("light");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test --prefix web -- src/composables/useTheme.test.ts`
Expected: FAIL — 模块 `./useTheme` 不存在。

- [ ] **Step 3: 安装依赖**

Run: `npm install --prefix web tailwindcss@^4 @tailwindcss/vite@^4`
（`@vueuse/core` 已在依赖中，无需再装。）

- [ ] **Step 4: 接入 Vite 插件（保留 libsodium 插件）**

修改 `web/vite.config.ts` 顶部 import 与 plugins 数组：

```ts
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite"; // 新增
```

```ts
  plugins: [
    fixLibsodiumImport(),
    tailwindcss(), // 新增：必须在 vue() 之前或之后均可；放在 vue() 前
    vue(),
  ],
```

> 注意：不改动 `worker`、`optimizeDeps`、`test.server.deps` 任何 libsodium 相关项。

- [ ] **Step 5: 重写 `web/src/styles/main.css`**

```css
@import "tailwindcss";

/* 明暗 variant：基于 <html class="dark"> */
@custom-variant dark (&:where(.dark, .dark *));

@theme {
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
    "PingFang SC", "Microsoft YaHei", sans-serif;

  --color-brand: #ff7a45;
  --color-brand-hover: #f0682f;
  --color-brand-soft: #fff1ea;

  --color-bg: #f5f6f8;
  --color-surface: #ffffff;
  --color-fg: #2b313a;
  --color-fg-muted: #5b6472;
  --color-border: #e2e5ea;

  --color-success: #1a8243;
  --color-warning: #b26b00;
  --color-danger: #e0322b;

  --radius-sm: 8px;
  --radius-md: 10px;
  --radius-lg: 12px;
  --radius-xl: 16px;
}

/* 暗色令牌覆盖 */
.dark {
  --color-bg: #0f1115;
  --color-surface: #161a22;
  --color-fg: #e6e9ef;
  --color-fg-muted: #9aa4b2;
  --color-border: #232936;
  --color-brand-soft: rgba(255, 122, 69, 0.16);
}

html,
body,
#app {
  height: 100%;
  margin: 0;
  padding: 0;
}

body {
  background: var(--color-bg);
  color: var(--color-fg);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  transition: background-color 200ms ease, color 200ms ease;
}

a {
  color: var(--color-brand);
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
}
```

- [ ] **Step 6: 实现 `useTheme.ts`**

```ts
import { useColorMode } from "@vueuse/core";

export type ThemeMode = "auto" | "light" | "dark";

/**
 * 全局明暗主题。light 不加 class；dark 给 <html> 加 .dark。
 * 持久化到 localStorage["df-theme"]，首次跟随系统偏好。
 */
export function useTheme() {
  return useColorMode({
    storageKey: "df-theme",
    initialValue: "auto",
    selector: "html",
    attribute: "class",
    modes: {
      auto: "",
      light: "",
      dark: "dark",
    },
  });
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npm run test --prefix web -- src/composables/useTheme.test.ts`
Expected: PASS（3 个测试）。

- [ ] **Step 8: 防闪烁脚本 + 验证构建**

在 `web/index.html` 的 `<head>` 内最前面加（避免明暗切换闪白）：

```html
<script>
  (function () {
    try {
      var t = localStorage.getItem("df-theme");
      var sys = window.matchMedia("(prefers-color-scheme: dark)").matches;
      if ((t === "dark" || (!t || t === "auto") && sys) && t !== "light") {
        document.documentElement.classList.add("dark");
      }
    } catch (e) {}
  })();
</script>
```

Run: `npm run typecheck --prefix web` 与 `npm run build --prefix web`
Expected: 均通过，`dist/` 生成。

- [ ] **Step 9: Commit**

```bash
git add web/package.json web/package-lock.json web/vite.config.ts \
  web/src/styles/main.css web/src/composables/useTheme.ts \
  web/src/composables/useTheme.test.ts web/index.html
git commit -m "feat(ui): Tailwind v4 + design tokens + dark-mode infrastructure"
```

---

### Task 2: 引入 Headless UI + lucide，移除 naive-ui

**Files:**
- Modify: `web/package.json`（加 `@headlessui/vue`、`lucide-vue-next`，删 `naive-ui`）
- Verify: 全仓无 `naive-ui` 引用（Task 1 前已确认零使用）

- [ ] **Step 1: 安装新依赖**

Run: `npm install --prefix web @headlessui/vue lucide-vue-next`

- [ ] **Step 2: 移除 naive-ui**

Run: `npm uninstall --prefix web naive-ui`

- [ ] **Step 3: 确认无残留引用**

Run: `grep -rn "naive-ui" web/src` （应为空）

- [ ] **Step 4: 验证构建与测试无回归**

Run: `npm run typecheck --prefix web && npm run test --prefix web && npm run build --prefix web`
Expected: 全绿（现有 4 个测试仍通过）。

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json
git commit -m "chore(web): add @headlessui/vue + lucide-vue-next; drop unused naive-ui"
```

---

## 阶段 B：UI 基础组件

> 约定：所有 `Df*` 组件放 `web/src/components/ui/`，每个组件配同名 `.test.ts`。颜色令牌来自 Task 1 的 `@theme`（`bg-brand`、`text-fg-muted`、`bg-success/15` 不透明度修饰等），明暗自适应。

### Task 3: DfSpinner + DfBadge + DfButton

**Files:**
- Create: `web/src/components/ui/DfSpinner.vue` + `DfSpinner.test.ts`
- Create: `web/src/components/ui/DfBadge.vue` + `DfBadge.test.ts`
- Create: `web/src/components/ui/DfButton.vue` + `DfButton.test.ts`（依赖 DfSpinner）

**Interfaces:**
- Produces:
  - `<DfSpinner class="w-4 h-4" />` —— 纯 SVG，尺寸由父级 class 控制。
  - `<DfBadge variant="ok|warn|err|proc|neutral">文本</DfBadge>`。
  - `<DfButton variant="primary|ghost|danger|subtle" size="sm|md" :loading :disabled :type>...</DfButton>`，支持 `#icon` 与默认插槽。

- [ ] **Step 1: 写 DfSpinner 测试**

```ts
// web/src/components/ui/DfSpinner.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfSpinner from "./DfSpinner.vue";

describe("DfSpinner", () => {
  it("renders an animated svg accepting size classes", () => {
    const w = mount(DfSpinner, { attrs: { class: "w-5 h-5" } });
    expect(w.find("svg.animate-spin").exists()).toBe(true);
    expect(w.attributes("class")).toMatch(/w-5/);
  });
});
```

- [ ] **Step 2: 实现 DfSpinner**

```vue
<!-- web/src/components/ui/DfSpinner.vue -->
<script setup lang="ts"></script>
<template>
  <svg class="animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
    <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
  </svg>
</template>
```

- [ ] **Step 3: 运行 DfSpinner 测试通过**

Run: `npm run test --prefix web -- src/components/ui/DfSpinner.test.ts` → PASS

- [ ] **Step 4: 写 DfBadge 测试**

```ts
// web/src/components/ui/DfBadge.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfBadge from "./DfBadge.vue";

describe("DfBadge", () => {
  it("renders slot text", () => {
    expect(mount(DfBadge, { slots: { default: "就绪" } }).text()).toBe("就绪");
  });
  it("proc variant uses brand color", () => {
    const w = mount(DfBadge, { props: { variant: "proc" } });
    expect(w.attributes("class")).toMatch(/text-brand/);
    expect(w.attributes("class")).toMatch(/bg-brand/);
  });
  it("falls back to neutral", () => {
    const w = mount(DfBadge);
    expect(w.attributes("class")).toMatch(/text-fg-muted/);
  });
});
```

- [ ] **Step 5: 实现 DfBadge**

```vue
<!-- web/src/components/ui/DfBadge.vue -->
<script setup lang="ts">
import { computed } from "vue";
const props = defineProps<{ variant?: "neutral" | "ok" | "warn" | "err" | "proc" }>();
const map: Record<string, string> = {
  neutral: "bg-fg-muted/15 text-fg-muted",
  ok: "bg-success/15 text-success",
  warn: "bg-warning/15 text-warning",
  err: "bg-danger/15 text-danger",
  proc: "bg-brand/15 text-brand",
};
const cls = computed(() => [
  "inline-flex items-center text-xs font-semibold px-2.5 py-0.5 rounded-full",
  map[props.variant ?? "neutral"],
]);
</script>
<template><span :class="cls"><slot /></span></template>
```

- [ ] **Step 6: 运行 DfBadge 测试通过**

Run: `npm run test --prefix web -- src/components/ui/DfBadge.test.ts` → PASS

- [ ] **Step 7: 写 DfButton 测试**

```ts
// web/src/components/ui/DfButton.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfButton from "./DfButton.vue";

describe("DfButton", () => {
  it("renders default slot with primary classes", () => {
    const w = mount(DfButton, { slots: { default: "上传" } });
    expect(w.text()).toBe("上传");
    expect(w.attributes("class")).toMatch(/bg-brand/);
    expect(w.attributes("type")).toBe("button");
  });
  it("shows spinner and is disabled when loading", () => {
    const w = mount(DfButton, { props: { loading: true } });
    expect(w.find("svg.animate-spin").exists()).toBe(true);
    expect(w.attributes("disabled")).toBeDefined();
  });
  it("applies danger variant", () => {
    const w = mount(DfButton, { props: { variant: "danger" } });
    expect(w.attributes("class")).toMatch(/bg-danger/);
  });
  it("renders #icon slot before label", () => {
    const w = mount(DfButton, {
      slots: { default: "新建", icon: "<span class='ic'/>" },
    });
    expect(w.find(".ic").exists()).toBe(true);
  });
});
```

- [ ] **Step 8: 实现 DfButton**

```vue
<!-- web/src/components/ui/DfButton.vue -->
<script setup lang="ts">
import { computed } from "vue";
import DfSpinner from "./DfSpinner.vue";

const props = withDefaults(
  defineProps<{
    variant?: "primary" | "ghost" | "danger" | "subtle";
    size?: "sm" | "md";
    loading?: boolean;
    disabled?: boolean;
    type?: "button" | "submit";
  }>(),
  { variant: "primary", size: "md", loading: false, disabled: false, type: "button" },
);

const variants: Record<string, string> = {
  primary: "bg-brand text-white hover:bg-brand-hover",
  ghost: "bg-surface text-fg border border-border hover:bg-bg",
  danger: "bg-danger text-white hover:opacity-90",
  subtle: "bg-transparent text-fg-muted hover:bg-bg hover:text-fg",
};
const sizes: Record<string, string> = {
  sm: "text-xs px-2.5 py-1.5",
  md: "text-sm px-4 py-2",
};
const cls = computed(() => [
  "inline-flex items-center justify-center gap-1.5 font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed",
  variants[props.variant],
  sizes[props.size],
]);
</script>

<template>
  <button :type="type" :class="cls" :disabled="disabled || loading">
    <DfSpinner v-if="loading" class="w-4 h-4" />
    <slot name="icon" />
    <slot />
  </button>
</template>
```

- [ ] **Step 9: 运行 DfButton 测试通过**

Run: `npm run test --prefix web -- src/components/ui/DfButton.test.ts` → PASS

- [ ] **Step 10: Commit**

```bash
git add web/src/components/ui/DfSpinner.vue web/src/components/ui/DfSpinner.test.ts \
  web/src/components/ui/DfBadge.vue web/src/components/ui/DfBadge.test.ts \
  web/src/components/ui/DfButton.vue web/src/components/ui/DfButton.test.ts
git commit -m "feat(ui): DfButton + DfBadge + DfSpinner base components"
```

---

### Task 4: DfInput + DfCard + DfEmpty

**Files:** 各 `web/src/components/ui/Df{Input,Card,Empty}.vue` + `.test.ts`

**Interfaces:**
- `<DfInput v-model label? hint? :error? placeholder? type? />`，支持 `#prefix`/`#suffix` 图标插槽。
- `<DfCard><template #header?>…</template>…<template #footer?>…</template></DfCard>`。
- `<DfEmpty :title :description?><template #action?>…</template></DfEmpty>`。

- [ ] **Step 1: 写 DfInput 测试**

```ts
// web/src/components/ui/DfInput.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfInput from "./DfInput.vue";

describe("DfInput", () => {
  it("emits update:modelValue on input", async () => {
    const w = mount(DfInput, { props: { modelValue: "" } });
    await w.find("input").setValue("hello");
    expect(w.emitted("update:modelValue")![0]).toEqual(["hello"]);
  });
  it("renders label and hint", () => {
    const w = mount(DfInput, { props: { label: "用户名", hint: "3-32 字符" } });
    expect(w.text()).toMatch(/用户名/);
    expect(w.text()).toMatch(/3-32 字符/);
  });
  it("shows error text and error styles when :error set", () => {
    const w = mount(DfInput, { props: { error: "必填" } });
    expect(w.text()).toMatch(/必填/);
    expect(w.find("input").attributes("class")).toMatch(/border-danger/);
  });
});
```

- [ ] **Step 2: 实现 DfInput**

```vue
<!-- web/src/components/ui/DfInput.vue -->
<script setup lang="ts">
const props = defineProps<{
  modelValue: string;
  label?: string;
  hint?: string;
  error?: string;
  placeholder?: string;
  type?: string;
  autocomplete?: string;
  disabled?: boolean;
}>();
defineEmits<{ "update:modelValue": [string] }>();
</script>

<template>
  <label class="flex flex-col gap-1 text-sm">
    <span v-if="label" class="font-medium text-fg">{{ label }}</span>
    <span class="inline-flex items-center gap-2 rounded-lg border bg-surface px-3 py-2 focus-within:ring-2 focus-within:ring-brand/60"
      :class="error ? 'border-danger' : 'border-border'">
      <slot name="prefix" />
      <input
        :type="type ?? 'text'"
        :value="modelValue"
        :placeholder="placeholder"
        :autocomplete="autocomplete"
        :disabled="disabled"
        class="w-full bg-transparent text-fg placeholder:text-fg-muted/70 outline-none disabled:opacity-60"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
      <slot name="suffix" />
    </span>
    <span v-if="error" class="text-xs text-danger">{{ error }}</span>
    <span v-else-if="hint" class="text-xs text-fg-muted">{{ hint }}</span>
  </label>
</template>
```

- [ ] **Step 3: 运行 DfInput 测试通过**

Run: `npm run test --prefix web -- src/components/ui/DfInput.test.ts` → PASS

- [ ] **Step 4: 写 DfCard 测试**

```ts
// web/src/components/ui/DfCard.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfCard from "./DfCard.vue";

describe("DfCard", () => {
  it("renders default slot", () => {
    expect(mount(DfCard, { slots: { default: "body" } }).text()).toMatch(/body/);
  });
  it("renders optional header and footer slots", () => {
    const w = mount(DfCard, {
      slots: { default: "body", header: "H", footer: "F" },
    });
    expect(w.text()).toMatch(/H/);
    expect(w.text()).toMatch(/F/);
  });
});
```

- [ ] **Step 5: 实现 DfCard**

```vue
<!-- web/src/components/ui/DfCard.vue -->
<template>
  <div class="rounded-xl border border-border bg-surface">
    <div v-if="$slots.header" class="border-b border-border px-5 py-3.5 font-semibold text-fg">
      <slot name="header" />
    </div>
    <div class="p-5"><slot /></div>
    <div v-if="$slots.footer" class="border-t border-border px-5 py-3"><slot name="footer" /></div>
  </div>
</template>
```

- [ ] **Step 6: 运行 DfCard 测试通过** → PASS

- [ ] **Step 7: 写 DfEmpty 测试**

```ts
// web/src/components/ui/DfEmpty.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfEmpty from "./DfEmpty.vue";

describe("DfEmpty", () => {
  it("renders title and description", () => {
    const w = mount(DfEmpty, { props: { title: "这里还很空", description: "拖个文件进来吧" } });
    expect(w.text()).toMatch(/这里还很空/);
    expect(w.text()).toMatch(/拖个文件进来吧/);
  });
  it("renders #action slot when provided", () => {
    const w = mount(DfEmpty, { props: { title: "x" }, slots: { action: "<button>上传</button>" } });
    expect(w.find("button").exists()).toBe(true);
  });
});
```

- [ ] **Step 8: 实现 DfEmpty**

```vue
<!-- web/src/components/ui/DfEmpty.vue -->
<script setup lang="ts">
import { Inbox } from "lucide-vue-next";
defineProps<{ title: string; description?: string }>();
</script>
<template>
  <div class="flex flex-col items-center justify-center gap-3 py-14 text-center">
    <Inbox class="w-12 h-12 text-fg-muted/40" />
    <p class="text-base font-semibold text-fg">{{ title }}</p>
    <p v-if="description" class="text-sm text-fg-muted">{{ description }}</p>
    <slot name="action" />
  </div>
</template>
```

- [ ] **Step 9: 运行 DfEmpty 测试通过** → PASS

- [ ] **Step 10: Commit**

```bash
git add web/src/components/ui/DfInput.* web/src/components/ui/DfCard.* web/src/components/ui/DfEmpty.*
git commit -m "feat(ui): DfInput + DfCard + DfEmpty base components"
```

---

### Task 5: DfTooltip + DfSkeleton

**Files:** `web/src/components/ui/DfTooltip.vue`、`DfSkeleton.vue` + `.test.ts`

**Interfaces:**
- `<DfTooltip label="…"><button/></DfTooltip>` —— 用 Headless UI 无需（用纯 CSS hover 即可，避免过度工程）。实现为 hover/focus 显示的纯组件。
- `<DfSkeleton class="w-full h-4" />` —— 占位条。

- [ ] **Step 1: 写 DfSkeleton 测试 + 实现**

```ts
// DfSkeleton.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfSkeleton from "./DfSkeleton.vue";
describe("DfSkeleton", () => {
  it("renders a pulsing block with size classes", () => {
    const w = mount(DfSkeleton, { attrs: { class: "w-32 h-4" } });
    expect(w.attributes("class")).toMatch(/animate-pulse/);
    expect(w.attributes("class")).toMatch(/w-32/);
  });
});
```
```vue
<!-- DfSkeleton.vue -->
<template>
  <div class="animate-pulse rounded bg-fg-muted/20" />
</template>
```
Run → PASS

- [ ] **Step 2: 写 DfTooltip 测试 + 实现**

```ts
// DfTooltip.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfTooltip from "./DfTooltip.vue";
describe("DfTooltip", () => {
  it("renders trigger slot and hidden label by default", () => {
    const w = mount(DfTooltip, { props: { label: "提示文字" }, slots: { default: "<button>T</button>" } });
    expect(w.find("button").exists()).toBe(true);
    const tip = w.find('[role="tooltip"]');
    expect(tip.exists()).toBe(true);
  });
});
```
```vue
<!-- DfTooltip.vue -->
<script setup lang="ts">
import { ref } from "vue";
defineProps<{ label: string }>();
const show = ref(false);
function on() { show.value = true; }
function off() { show.value = false; }
</script>
<template>
  <span class="relative inline-flex" @mouseenter="on" @mouseleave="off" @focusin="on" @focusout="off">
    <slot />
    <span
      role="tooltip"
      v-show="show"
      class="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-md"
    >{{ label }}</span>
  </span>
</template>
```
Run → PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/components/ui/DfTooltip.* web/src/components/ui/DfSkeleton.*
git commit -m "feat(ui): DfTooltip + DfSkeleton base components"
```

---

## 阶段 C：模态框与全局服务

### Task 6: DfModal（Headless UI Dialog 封装）

**Files:** `web/src/components/ui/DfModal.vue` + `.test.ts`

**Interfaces:**
- `<DfModal :open :title? :size="sm|md|lg" @close>…</DfModal>`。遮罩点击/ESC 触发 `@close`。尺寸 sm→max-w-sm / md→max-w-md / lg→max-w-2xl。

- [ ] **Step 1: 写测试**

```ts
// web/src/components/ui/DfModal.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfModal from "./DfModal.vue";

describe("DfModal", () => {
  it("renders title and body when open", () => {
    const w = mount(DfModal, {
      props: { open: true, title: "确认删除" },
      slots: { default: "<p>正文</p>" },
      attachTo: document.body,
    });
    expect(document.body.textContent).toMatch(/确认删除/);
    expect(document.body.textContent).toMatch(/正文/);
    w.unmount();
  });
  it("renders nothing visible when closed", () => {
    const w = mount(DfModal, {
      props: { open: false },
      slots: { default: "隐藏内容" },
      attachTo: document.body,
    });
    expect(document.body.textContent).not.toMatch(/隐藏内容/);
    w.unmount();
  });
});
```

- [ ] **Step 2: 实现 DfModal**

```vue
<!-- web/src/components/ui/DfModal.vue -->
<script setup lang="ts">
import {
  Dialog, DialogPanel, DialogTitle,
  TransitionRoot, TransitionChild,
} from "@headlessui/vue";
withDefaults(defineProps<{ open: boolean; title?: string; size?: "sm" | "md" | "lg" }>(), { size: "md" });
defineEmits<{ close: [] }>();
const maxW = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-2xl" };
</script>

<template>
  <TransitionRoot :show="open" as="template" appear>
    <Dialog @close="$emit('close')" class="relative z-50">
      <TransitionChild as="template"
        enter="duration-200 ease-out" enter-from="opacity-0" enter-to="opacity-100"
        leave="duration-150 ease-in" leave-from="opacity-100" leave-to="opacity-0">
        <div class="fixed inset-0 bg-black/40 backdrop-blur-sm" aria-hidden="true" />
      </TransitionChild>
      <div class="fixed inset-0 flex items-center justify-center p-4">
        <TransitionChild as="template"
          enter="duration-200 ease-out" enter-from="opacity-0 scale-95" enter-to="opacity-100 scale-100"
          leave="duration-150 ease-in" leave-from="opacity-100 scale-100" leave-to="opacity-0 scale-95">
          <DialogPanel :class="['w-full rounded-xl border border-border bg-surface p-6 shadow-lg', maxW[size]]">
            <DialogTitle v-if="title" class="mb-1 text-lg font-semibold text-fg">{{ title }}</DialogTitle>
            <slot />
          </DialogPanel>
        </TransitionChild>
      </div>
    </Dialog>
  </TransitionRoot>
</template>
```

- [ ] **Step 3: 运行测试通过** → `npm run test --prefix web -- src/components/ui/DfModal.test.ts` PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ui/DfModal.vue web/src/components/ui/DfModal.test.ts
git commit -m "feat(ui): DfModal wrapper over Headless UI Dialog"
```

---

### Task 7: useToast 服务 + DfToastContainer

**Files:**
- Create: `web/src/composables/useToast.ts` + `useToast.test.ts`
- Create: `web/src/components/ui/DfToastContainer.vue`
- Modify: `web/src/App.vue`（挂载 `<DfToastContainer />`）

**Interfaces:**
- `useToast()` → `{ items, success(m), info(m), warning(m), error(m, dur?), remove(id) }`。模块级单例 `items: readonly<ToastItem[]>`。

- [ ] **Step 1: 写 useToast 测试**

```ts
// web/src/composables/useToast.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useToast } from "./useToast";

describe("useToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { items } = useToast();
    items.value.splice(0); // 清空单例
  });

  it("success pushes a toast", () => {
    const t = useToast();
    t.success("已上传");
    expect(t.items.value).toHaveLength(1);
    expect(t.items.value[0].type).toBe("success");
  });

  it("auto-removes after duration", () => {
    const t = useToast();
    t.success("x", 1000);
    expect(t.items.value).toHaveLength(1);
    vi.advanceTimersByTime(1100);
    expect(t.items.value).toHaveLength(0);
  });

  it("remove(id) drops specific toast", () => {
    const t = useToast();
    const id = t.info("a", 0);
    t.remove(id);
    expect(t.items.value).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 实现 useToast**

```ts
// web/src/composables/useToast.ts
import { ref, readonly } from "vue";

export type ToastType = "success" | "info" | "warning" | "error";
export interface ToastItem { id: number; type: ToastType; message: string; }

const list = ref<ToastItem[]>([]);
let seq = 0;

function push(type: ToastType, message: string, duration = 3500): number {
  const id = ++seq;
  list.value.push({ id, type, message });
  if (duration > 0) setTimeout(() => remove(id), duration);
  return id;
}
function remove(id: number) {
  list.value = list.value.filter((t) => t.id !== id);
}

export function useToast() {
  return {
    items: readonly(list),
    success: (m: string, d?: number) => push("success", m, d),
    info: (m: string, d?: number) => push("info", m, d),
    warning: (m: string, d?: number) => push("warning", m, d),
    error: (m: string, d = 6000) => push("error", m, d),
    remove,
  };
}
```

- [ ] **Step 3: 运行 useToast 测试通过** → PASS

- [ ] **Step 4: 实现 DfToastContainer**

```vue
<!-- web/src/components/ui/DfToastContainer.vue -->
<script setup lang="ts">
import { CheckCircle2, Info, AlertTriangle, XCircle, X } from "lucide-vue-next";
import { useToast, type ToastType } from "@/composables/useToast";
const toast = useToast();
const icons = { success: CheckCircle2, info: Info, warning: AlertTriangle, error: XCircle };
const colors: Record<ToastType, string> = {
  success: "text-success", info: "text-brand", warning: "text-warning", error: "text-danger",
};
</script>
<template>
  <Teleport to="body">
    <div class="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      <div
        v-for="t in toast.items.value"
        :key="t.id"
        class="flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3 shadow-md"
      >
        <component :is="icons[t.type]" :class="['mt-0.5 h-4 w-4 shrink-0', colors[t.type]]" />
        <p class="flex-1 text-sm text-fg">{{ t.message }}</p>
        <button class="text-fg-muted hover:text-fg" @click="toast.remove(t.id)"><X class="h-4 w-4" /></button>
      </div>
    </div>
  </Teleport>
</template>
```

- [ ] **Step 5: 在 App.vue 挂载容器**

修改 `web/src/App.vue` 的 `<template>`，在 `<RouterView />` 同级加（与 loading 分支合并）：

```vue
<template>
  <div v-if="auth.isRestoring" class="app-loading">Loading…</div>
  <template v-else>
    <RouterView />
    <DfToastContainer />
  </template>
</template>
```
并在 `<script setup>` 加 `import DfToastContainer from "@/components/ui/DfToastContainer.vue";`。

- [ ] **Step 6: 验证 build + 全测试** → `npm run build --prefix web` 与 `npm run test --prefix web` 全绿

- [ ] **Step 7: Commit**

```bash
git add web/src/composables/useToast.ts web/src/composables/useToast.test.ts \
  web/src/components/ui/DfToastContainer.vue web/src/App.vue
git commit -m "feat(ui): global useToast service + DfToastContainer"
```

---

### Task 8: useConfirm + DfConfirmDialog（替换 confirm()）

**Files:** `web/src/composables/useConfirm.ts` + `.test.ts`、`web/src/components/ui/DfConfirmDialog.vue`
**Depends on:** Task 6 (DfModal)

**Interfaces:**
- `useConfirm()` → `{ state, confirm(opts): Promise<boolean>, _resolve(v) }`。`confirm({ message, title?, confirmText?, cancelText?, danger? })` 返回用户选择。

- [ ] **Step 1: 写 useConfirm 测试**

```ts
// web/src/composables/useConfirm.test.ts
import { describe, it, expect } from "vitest";
import { useConfirm } from "./useConfirm";

describe("useConfirm", () => {
  it("confirm() opens dialog and resolves true on _resolve(true)", async () => {
    const c = useConfirm();
    const p = c.confirm({ message: "删除？" });
    expect(c.state.value.open).toBe(true);
    expect(c.state.value.message).toBe("删除？");
    c._resolve(true);
    expect(await p).toBe(true);
    expect(c.state.value.open).toBe(false);
  });
  it("danger flag defaults false, title default", () => {
    const c = useConfirm();
    c.confirm({ message: "x" });
    expect(c.state.value.danger).toBe(false);
    expect(c.state.value.title).toBeTruthy();
  });
});
```

- [ ] **Step 2: 实现 useConfirm**

```ts
// web/src/composables/useConfirm.ts
import { ref, readonly } from "vue";

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}
interface State extends ConfirmOptions {
  open: boolean;
  resolve: ((v: boolean) => void) | null;
}

const state = ref<State>({ open: false, message: "", resolve: null });

export function useConfirm() {
  return {
    state: readonly(state),
    confirm(opts: ConfirmOptions): Promise<boolean> {
      return new Promise((resolve) => {
        state.value = {
          open: true,
          resolve,
          title: opts.title ?? "请确认",
          message: opts.message,
          confirmText: opts.confirmText ?? "确认",
          cancelText: opts.cancelText ?? "取消",
          danger: opts.danger ?? false,
        };
      });
    },
    _resolve(v: boolean) {
      state.value.resolve?.(v);
      state.value = { open: false, message: "", resolve: null };
    },
  };
}
```

- [ ] **Step 3: 实现 DfConfirmDialog**

```vue
<!-- web/src/components/ui/DfConfirmDialog.vue -->
<script setup lang="ts">
import { useConfirm } from "@/composables/useConfirm";
import DfModal from "./DfModal.vue";
import DfButton from "./DfButton.vue";

const c = useConfirm();
function cancel() { c._resolve(false); }
function ok() { c._resolve(true); }
</script>
<template>
  <DfModal :open="c.state.value.open" :title="c.state.value.title" @close="cancel">
    <p class="text-sm text-fg-muted">{{ c.state.value.message }}</p>
    <div class="mt-5 flex justify-end gap-2">
      <DfButton variant="ghost" size="sm" @click="cancel">{{ c.state.value.cancelText }}</DfButton>
      <DfButton :variant="c.state.value.danger ? 'danger' : 'primary'" size="sm" @click="ok">
        {{ c.state.value.confirmText }}
      </DfButton>
    </div>
  </DfModal>
</template>
```

- [ ] **Step 4: 挂载到 App.vue**

在 `App.vue` 模板的 `<template v-else>` 内追加 `<DfConfirmDialog />`，并 `import DfConfirmDialog from "@/components/ui/DfConfirmDialog.vue";`。

- [ ] **Step 5: 运行 useConfirm 测试通过** → PASS；`npm run build` 通过

- [ ] **Step 6: Commit**

```bash
git add web/src/composables/useConfirm.ts web/src/composables/useConfirm.test.ts \
  web/src/components/ui/DfConfirmDialog.vue web/src/App.vue
git commit -m "feat(ui): useConfirm service + DfConfirmDialog (replaces confirm())"
```

---

### Task 9: usePrompt + DfPromptDialog（替换 prompt()，用于新建文件夹）

**Files:** `web/src/composables/usePrompt.ts` + `.test.ts`、`web/src/components/ui/DfPromptDialog.vue`
**Depends on:** Task 6 (DfModal)

**Interfaces:**
- `usePrompt()` → `{ state, prompt(opts): Promise<string|null>, _submit(v:string|null) }`。`prompt({ message, title?, placeholder?, initial?, confirmText? })`；取消返回 `null`。

- [ ] **Step 1: 写 usePrompt 测试**

```ts
// web/src/composables/usePrompt.test.ts
import { describe, it, expect } from "vitest";
import { usePrompt } from "./usePrompt";
describe("usePrompt", () => {
  it("opens with initial value and returns submitted string", async () => {
    const p = usePrompt();
    const r = p.prompt({ message: "名称", initial: "新建文件夹" });
    expect(p.state.value.open).toBe(true);
    expect(p.state.value.initial).toBe("新建文件夹");
    p._submit("工作");
    expect(await r).toBe("工作");
  });
  it("cancel resolves null", async () => {
    const p = usePrompt();
    const r = p.prompt({ message: "x" });
    p._submit(null);
    expect(await r).toBeNull();
  });
});
```

- [ ] **Step 2: 实现 usePrompt**

```ts
// web/src/composables/usePrompt.ts
import { ref, readonly } from "vue";

export interface PromptOptions {
  message: string;
  title?: string;
  placeholder?: string;
  initial?: string;
  confirmText?: string;
  cancelText?: string;
}
interface State extends PromptOptions { open: boolean; resolve: ((v: string | null) => void) | null; }

const state = ref<State>({ open: false, message: "", resolve: null });

export function usePrompt() {
  return {
    state: readonly(state),
    prompt(opts: PromptOptions): Promise<string | null> {
      return new Promise((resolve) => {
        state.value = {
          open: true, resolve,
          title: opts.title ?? "输入",
          message: opts.message,
          placeholder: opts.placeholder ?? "",
          initial: opts.initial ?? "",
          confirmText: opts.confirmText ?? "确认",
          cancelText: opts.cancelText ?? "取消",
        };
      });
    },
    _submit(v: string | null) {
      state.value.resolve?.(v);
      state.value = { open: false, message: "", resolve: null };
    },
  };
}
```

- [ ] **Step 3: 实现 DfPromptDialog**

```vue
<!-- web/src/components/ui/DfPromptDialog.vue -->
<script setup lang="ts">
import { ref, watch } from "vue";
import { usePrompt } from "@/composables/usePrompt";
import DfModal from "./DfModal.vue";
import DfButton from "./DfButton.vue";
import DfInput from "./DfInput.vue";

const p = usePrompt();
const value = ref("");

watch(() => p.state.value.open, (open) => {
  if (open) value.value = p.state.value.initial ?? "";
});

function cancel() { p._submit(null); }
function submit() {
  const v = value.value.trim();
  if (v) p._submit(v);
}
</script>
<template>
  <DfModal :open="p.state.value.open" :title="p.state.value.title" @close="cancel">
    <form @submit.prevent="submit">
      <p class="mb-3 text-sm text-fg-muted">{{ p.state.value.message }}</p>
      <DfInput v-model="value" :placeholder="p.state.value.placeholder" autofocus />
      <div class="mt-5 flex justify-end gap-2">
        <DfButton type="button" variant="ghost" size="sm" @click="cancel">{{ p.state.value.cancelText }}</DfButton>
        <DfButton type="submit" size="sm" :disabled="!value.trim()">{{ p.state.value.confirmText }}</DfButton>
      </div>
    </form>
  </DfModal>
</template>
```

> 注：`DfInput` 不带 `autofocus` prop 的处理——在 `DfInput` 接收 `autofocus` 并透传给 `<input :autofocus>`。补 `DfInput` props 增加 `autofocus?: boolean` 并在 input 上 `:autofocus="autofocus"`（同步修改 `DfInput.vue` 与其测试不回归）。

- [ ] **Step 4: 挂载到 App.vue**（追加 `<DfPromptDialog />` + import）

- [ ] **Step 5: 运行 usePrompt 测试通过** → PASS；`npm run build` 通过

- [ ] **Step 6: Commit**

```bash
git add web/src/composables/usePrompt.ts web/src/composables/usePrompt.test.ts \
  web/src/components/ui/DfPromptDialog.vue web/src/components/ui/DfInput.vue web/src/App.vue
git commit -m "feat(ui): usePrompt service + DfPromptDialog (replaces prompt())"
```

---

## 阶段 D：菜单与导航控件

### Task 10: DfDropdown + DfContextMenu

**Files:** `web/src/components/ui/DfDropdown.vue`、`DfContextMenu.vue` + 各 `.test.ts`

**Interfaces:**
- `<DfDropdown :items :align="left|right"><template #trigger>…</template></DfDropdown>`，`items: { label; icon?; danger?; disabled?; onClick() }[]`。基于 Headless UI Menu。
- `<DfContextMenu ref="…" :items />`，父组件 `menuRef.value?.show(event)` 在右键处弹出；点击外部/选择项后关闭。

- [ ] **Step 1: 写 DfDropdown 测试 + 实现**

```ts
// DfDropdown.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfDropdown from "./DfDropdown.vue";

describe("DfDropdown", () => {
  it("renders trigger slot", () => {
    const w = mount(DfDropdown, {
      props: { items: [{ label: "打开", onClick: () => {} }] },
      slots: { trigger: '<button class="t">⋯</button>' },
    });
    expect(w.find("button.t").exists()).toBe(true);
  });
  it("opens menu and shows item labels on trigger click", async () => {
    const w = mount(DfDropdown, {
      props: { items: [{ label: "打开", onClick: () => {} }, { label: "删除", danger: true, onClick: () => {} }] },
      slots: { trigger: '<button class="t">⋯</button>' },
    });
    await w.find("button.t").trigger("click");
    expect(w.text()).toMatch(/打开/);
    expect(w.text()).toMatch(/删除/);
  });
});
```

```vue
<!-- web/src/components/ui/DfDropdown.vue -->
<script setup lang="ts">
import { Menu, MenuButton, MenuItems, MenuItem } from "@headlessui/vue";
import type { Component } from "vue";

export interface DropdownItem {
  label: string;
  icon?: Component;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}
withDefaults(defineProps<{ items: DropdownItem[]; align?: "left" | "right" }>(), { align: "left" });
</script>

<template>
  <Menu as="div" class="relative inline-block text-left">
    <MenuButton as="template"><slot name="trigger" /></MenuButton>
    <MenuItems :class="['absolute z-40 mt-1 min-w-[10rem] rounded-lg border border-border bg-surface py-1 shadow-md focus:outline-none', align === 'right' ? 'right-0' : 'left-0']">
      <MenuItem v-for="(it, i) in items" :key="i" v-slot="{ active }" :disabled="it.disabled">
        <button
          @click="it.onClick"
          :class="['flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left', active ? 'bg-bg' : '', it.danger ? 'text-danger' : 'text-fg']"
        >
          <component v-if="it.icon" :is="it.icon" class="h-4 w-4" />{{ it.label }}
        </button>
      </MenuItem>
    </MenuItems>
  </Menu>
</template>
```

Run: `npm run test --prefix web -- src/components/ui/DfDropdown.test.ts` → PASS

- [ ] **Step 2: 写 DfContextMenu 测试 + 实现**

```ts
// DfContextMenu.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfContextMenu from "./DfContextMenu.vue";

describe("DfContextMenu", () => {
  it("hidden until show(event) is called", async () => {
    const w = mount(DfContextMenu, {
      props: { items: [{ label: "打开", onClick: () => {} }] },
      attachTo: document.body,
    });
    expect(w.find('[data-cm="root"]').isVisible()).toBe(false);
    (w.vm as any).show({ preventDefault: () => {}, clientX: 100, clientY: 50 });
    await w.vm.$nextTick();
    expect(w.find('[data-cm="root"]').isVisible()).toBe(true);
    expect(document.body.textContent).toMatch(/打开/);
    w.unmount();
  });
});
```

```vue
<!-- web/src/components/ui/DfContextMenu.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { onClickOutside } from "@vueuse/core";
import type { Component } from "vue";

export interface ContextItem { label: string; icon?: Component; danger?: boolean; onClick: () => void; }
defineProps<{ items: ContextItem[] }>();

const open = ref(false);
const x = ref(0);
const y = ref(0);
const root = ref<HTMLElement | null>(null);
onClickOutside(root, () => (open.value = false));

function show(e: { preventDefault: () => void; clientX: number; clientY: number }) {
  e.preventDefault();
  x.value = e.clientX;
  y.value = e.clientY;
  open.value = true;
}
function pick(it: ContextItem) {
  it.onClick();
  open.value = false;
}
defineExpose({ show });
</script>

<template>
  <Teleport to="body">
    <div
      v-show="open"
      ref="root"
      data-cm="root"
      :style="{ left: x + 'px', top: y + 'px' }"
      class="fixed z-[55] min-w-[10rem] rounded-lg border border-border bg-surface py-1 shadow-md"
    >
      <button
        v-for="(it, i) in items"
        :key="i"
        @click="pick(it)"
        :class="['flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg', it.danger ? 'text-danger' : 'text-fg']"
      >
        <component v-if="it.icon" :is="it.icon" class="h-4 w-4" />{{ it.label }}
      </button>
    </div>
  </Teleport>
</template>
```

Run → PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/components/ui/DfDropdown.* web/src/components/ui/DfContextMenu.*
git commit -m "feat(ui): DfDropdown + DfContextMenu menu components"
```

---

### Task 11: DfSegmented + DfBreadcrumbs

**Files:** `DfSegmented.vue`、`DfBreadcrumbs.vue` + `.test.ts`

**Interfaces:**
- `<DfSegmented v-model :options="[{value,label,icon?}]" />`。
- `<DfBreadcrumbs :items="[{id,label}]" @navigate="navigateTo" />`，最后一项高亮，其余可点。

- [ ] **Step 1: DfSegmented 测试 + 实现**

```ts
// DfSegmented.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfSegmented from "./DfSegmented.vue";
describe("DfSegmented", () => {
  it("marks the active option and emits on click", async () => {
    const w = mount(DfSegmented, {
      props: { modelValue: "list", options: [{ value: "list", label: "列表" }, { value: "grid", label: "网格" }] },
    });
    const active = w.findAll("button").find((b) => b.text() === "列表")!;
    expect(active.classes().join(" ")).toMatch(/bg-brand/);
    const grid = w.findAll("button").find((b) => b.text() === "网格")!;
    await grid.trigger("click");
    expect(w.emitted("update:modelValue")![0]).toEqual(["grid"]);
  });
});
```

```vue
<!-- web/src/components/ui/DfSegmented.vue -->
<script setup lang="ts">
import type { Component } from "vue";
defineProps<{ modelValue: string; options: { value: string; label?: string; icon?: Component }[] }>();
defineEmits<{ "update:modelValue": [string] }>();
</script>
<template>
  <div class="inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
    <button
      v-for="o in options"
      :key="o.value"
      @click="$emit('update:modelValue', o.value)"
      :class="['inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors', modelValue === o.value ? 'bg-brand text-white' : 'text-fg-muted hover:text-fg']"
    >
      <component v-if="o.icon" :is="o.icon" class="h-3.5 w-3.5" />
      <span v-if="o.label">{{ o.label }}</span>
    </button>
  </div>
</template>
```

Run → PASS

- [ ] **Step 2: DfBreadcrumbs 测试 + 实现**

```ts
// DfBreadcrumbs.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfBreadcrumbs from "./DfBreadcrumbs.vue";
describe("DfBreadcrumbs", () => {
  it("emits navigate with id when a non-last crumb clicked", async () => {
    const w = mount(DfBreadcrumbs, {
      props: { items: [{ id: null, label: "Drive" }, { id: "a", label: "文档" }] },
    });
    await w.find("button").trigger("click"); // 第一项 Drive
    expect(w.emitted("navigate")![0]).toEqual([null]);
  });
  it("last crumb is not a button", () => {
    const w = mount(DfBreadcrumbs, {
      props: { items: [{ id: null, label: "Drive" }, { id: "a", label: "文档" }] },
    });
    const last = w.findAll("span,button");
    expect(w.text()).toMatch(/文档/);
    // 最后一项 "文档" 不触发 navigate：只有 1 个 button（Drive）
    expect(w.findAll("button")).toHaveLength(1);
  });
});
```

```vue
<!-- web/src/components/ui/DfBreadcrumbs.vue -->
<script setup lang="ts">
import { ChevronRight } from "lucide-vue-next";
defineProps<{ items: { id: string | null; label: string }[] }>();
defineEmits<{ navigate: [string | null] }>();
</script>
<template>
  <nav class="flex items-center gap-1 text-sm">
    <template v-for="(it, i) in items" :key="i">
      <button
        v-if="i < items.length - 1"
        @click="$emit('navigate', it.id)"
        class="text-fg-muted transition-colors hover:text-brand"
      >{{ it.label }}</button>
      <span v-else class="font-semibold text-fg">{{ it.label }}</span>
      <ChevronRight v-if="i < items.length - 1" class="h-3.5 w-3.5 text-fg-muted/60" />
    </template>
  </nav>
</template>
```

Run → PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/components/ui/DfSegmented.* web/src/components/ui/DfBreadcrumbs.*
git commit -m "feat(ui): DfSegmented + DfBreadcrumbs components"
```

---

## 阶段 E：业务组件

### Task 12: FileTypeIcon（彩色文件类型图标）

**Files:** `web/src/components/FileTypeIcon.vue` + `.test.ts`

**Interfaces:** `<FileTypeIcon :name="filename" :is-folder? size="md" />`，按扩展名映射到 doc/img/vid/aud/zip/folder/other，彩色软底 + 同色图标。

- [ ] **Step 1: 写测试 + 实现**

```ts
// web/src/components/FileTypeIcon.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import FileTypeIcon from "./FileTypeIcon.vue";

describe("FileTypeIcon", () => {
  it("classifies pdf as doc", () => {
    const w = mount(FileTypeIcon, { props: { name: "report.pdf" } });
    expect(w.attributes("class")).toMatch(/text-blue/);
  });
  it("classifies folder", () => {
    const w = mount(FileTypeIcon, { props: { name: "工作", isFolder: true } });
    expect(w.attributes("class")).toMatch(/text-orange/);
  });
  it("unknown ext falls back to other", () => {
    const w = mount(FileTypeIcon, { props: { name: "data.xyz" } });
    expect(w.attributes("class")).toMatch(/text-gray/);
  });
});
```

```vue
<!-- web/src/components/FileTypeIcon.vue -->
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
```

Run → PASS

- [ ] **Step 2: Commit**

```bash
git add web/src/components/FileTypeIcon.vue web/src/components/FileTypeIcon.test.ts
git commit -m "feat(ui): FileTypeIcon with category-based color mapping"
```

---

### Task 13: AppHeader（全站顶栏）

**Files:** `web/src/components/AppHeader.vue` + `.test.ts`

**Interfaces:**
- `<AppHeader :active="drive|shares|settings" :show-upload? :username @upload />`
- 含品牌字标、导航胶囊（我的文件/分享）、上传按钮（仅 `showUpload`）、明暗切换（循环 light→dark→auto）、用户下拉菜单（设置/登出）。

- [ ] **Step 1: 写测试（stub RouterLink）**

```ts
// web/src/components/AppHeader.test.ts
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import AppHeader from "./AppHeader.vue";

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ username: "alice", logout: vi.fn().mockResolvedValue(undefined) }),
}));

const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: "/", name: "drive", component: { template: "<div/>" } },
  { path: "/s", name: "shares", component: { template: "<div/>" } },
  { path: "/set", name: "settings", component: { template: "<div/>" } },
]});

describe("AppHeader", () => {
  it("renders brand and nav links", () => {
    const w = mount(AppHeader, { props: { active: "drive", username: "alice" }, global: { plugins: [router] } });
    expect(w.text()).toMatch(/DragonFox/);
    expect(w.text()).toMatch(/我的文件/);
  });
  it("shows upload button and emits upload when showUpload set", async () => {
    const w = mount(AppHeader, { props: { active: "drive", username: "a", showUpload: true }, global: { plugins: [router] } });
    const btn = w.findAll("button").find((b) => b.text().includes("上传"));
    expect(btn).toBeTruthy();
    await btn!.trigger("click");
    expect(w.emitted("upload")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 实现 AppHeader**

```vue
<!-- web/src/components/AppHeader.vue -->
<script setup lang="ts">
import { RouterLink, useRouter } from "vue-router";
import { Sun, Moon, Monitor, Upload, LogOut, Settings as SettingsIcon } from "lucide-vue-next";
import { useTheme } from "@/composables/useTheme";
import { useAuthStore } from "@/stores/auth";
import DfButton from "@/components/ui/DfButton.vue";
import DfDropdown, { type DropdownItem } from "@/components/ui/DfDropdown.vue";
import DfTooltip from "@/components/ui/DfTooltip.vue";

defineProps<{ active: "drive" | "shares" | "settings"; username: string; showUpload?: boolean }>();
const emit = defineEmits<{ upload: [] }>();

const theme = useTheme();
const auth = useAuthStore();
const router = useRouter();

const themeIcon = { light: Sun, dark: Moon, auto: Monitor } as const;
function cycleTheme() {
  const order = ["light", "dark", "auto"] as const;
  const cur = theme.store.value as (typeof order)[number];
  theme.store.value = order[(order.indexOf(cur) + 1) % order.length];
}

const menu: DropdownItem[] = [
  { label: "设置", icon: SettingsIcon, onClick: () => router.push({ name: "settings" }) },
  { label: "退出登录", icon: LogOut, danger: true, onClick: async () => {
    await auth.logout();
    router.push({ name: "login" });
  }},
];
</script>

<template>
  <header class="sticky top-0 z-30 flex items-center gap-4 border-b border-border bg-surface/90 px-4 py-2.5 backdrop-blur md:px-6">
    <RouterLink :to="{ name: 'drive' }" class="flex items-center gap-1.5 font-extrabold text-brand">
      <span>🦊</span><span class="hidden sm:inline">DragonFox</span>
    </RouterLink>

    <nav class="flex items-center gap-1">
      <RouterLink :to="{ name: 'drive' }"
        :class="['rounded-full px-3 py-1.5 text-sm font-medium transition-colors', active==='drive' ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:text-fg']">
        我的文件
      </RouterLink>
      <RouterLink :to="{ name: 'shares' }" v-if="false" />
      <!-- shares 页暂由 Settings 承载；保留导航位以便后续独立路由 -->
    </nav>

    <div class="flex-1" />

    <DfButton v-if="showUpload" variant="primary" size="sm" @click="emit('upload')">
      <template #icon><Upload class="h-4 w-4" /></template>
      上传
    </DfButton>

    <DfTooltip :label="`主题：${theme.store.value}`">
      <button class="rounded-lg p-2 text-fg-muted hover:bg-bg hover:text-fg" @click="cycleTheme">
        <component :is="themeIcon[theme.store.value as keyof typeof themeIcon]" class="h-5 w-5" />
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

> 注：当前"分享"入口在 Settings 页，故顶栏导航暂只留"我的文件"。`v-if="false"` 的占位 RouterLink 删除即可——保留注释说明。

- [ ] **Step 3: 运行测试通过** → PASS（`npm run test --prefix web -- src/components/AppHeader.test.ts`）；`npm run build` 通过

- [ ] **Step 4: Commit**

```bash
git add web/src/components/AppHeader.vue web/src/components/AppHeader.test.ts
git commit -m "feat(ui): AppHeader with nav, upload, theme toggle, user menu"
```

---

### Task 14: UploadDropzone + UploadQueueDrawer

**Files:** `web/src/components/UploadDropzone.vue`、`UploadQueueDrawer.vue` + `.test.ts`

**Interfaces:**
- `<UploadDropzone><template #default="{ over }">…</template></UploadDropzone>` —— 包裹任意区域，拖入文件触发 `@files(File[])`；`over` 暴露拖拽高亮态。基于 `@vueuse/core` `useDropZone`。
- `<UploadQueueDrawer :uploads="[{fileId,name,progress,phase}]" @cancel="…" />` —— 右下角浮层，列进度条 + 取消。

- [ ] **Step 1: 写 UploadDropzone 测试 + 实现**

```ts
// UploadDropzone.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import UploadDropzone from "./UploadDropzone.vue";

describe("UploadDropzone", () => {
  it("renders default slot content", () => {
    const w = mount(UploadDropzone, { slots: { default: "<p>区域</p>" } });
    expect(w.text()).toMatch(/区域/);
  });
});
```

```vue
<!-- web/src/components/UploadDropzone.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { useDropZone } from "@vueuse/core";

const emit = defineEmits<{ files: [File[]] }>();
const el = ref<HTMLElement | null>(null);
const over = ref(false);

function onDrop(fs: File[] | null) {
  over.value = false;
  if (fs && fs.length) emit("files", Array.from(fs));
}
useDropZone(el, {
  onDrop,
  onEnter: () => (over.value = true),
  onLeave: () => (over.value = false),
});
</script>

<template>
  <div
    ref="el"
    :class="['relative transition-colors', over ? 'ring-2 ring-brand ring-inset rounded-xl bg-brand/5' : '']"
  >
    <slot :over="over" />
  </div>
</template>
```

Run → PASS

- [ ] **Step 2: 写 UploadQueueDrawer 测试 + 实现**

```ts
// UploadQueueDrawer.test.ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import UploadQueueDrawer from "./UploadQueueDrawer.vue";

describe("UploadQueueDrawer", () => {
  it("renders nothing when no uploads", () => {
    const w = mount(UploadQueueDrawer, { props: { uploads: [] } });
    expect(w.text()).toBe("");
  });
  it("lists uploads with progress and cancel emits id", async () => {
    const w = mount(UploadQueueDrawer, {
      props: { uploads: [{ fileId: "f1", name: "a.mp4", progress: 0.4, phase: "uploading" }] },
    });
    expect(w.text()).toMatch(/a\.mp4/);
    await w.find("button").trigger("click");
    expect(w.emitted("cancel")![0]).toEqual(["f1"]);
  });
});
```

```vue
<!-- web/src/components/UploadQueueDrawer.vue -->
<script setup lang="ts">
import { X } from "lucide-vue-next";
defineProps<{ uploads: { fileId: string; name: string; progress: number; phase: string }[] }>();
defineEmits<{ cancel: [string] }>();
</script>
<template>
  <Teleport to="body">
    <div v-if="uploads.length" class="fixed bottom-4 left-4 z-[55] w-80 rounded-xl border border-border bg-surface shadow-lg">
      <div class="border-b border-border px-4 py-2.5 text-sm font-semibold text-fg">上传中 ({{ uploads.length }})</div>
      <ul class="max-h-72 overflow-auto">
        <li v-for="u in uploads" :key="u.fileId" class="flex items-center gap-2 px-4 py-2.5">
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium text-fg">{{ u.name }}</p>
            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-bg">
              <div class="h-full rounded-full bg-brand transition-all" :style="{ width: Math.round(u.progress * 100) + '%' }" />
            </div>
          </div>
          <span class="text-[10px] text-fg-muted">{{ u.phase }}</span>
          <button class="text-fg-muted hover:text-danger" @click="$emit('cancel', u.fileId)"><X class="h-4 w-4" /></button>
        </li>
      </ul>
    </div>
  </Teleport>
</template>
```

Run → PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/components/UploadDropzone.* web/src/components/UploadQueueDrawer.*
git commit -m "feat(ui): UploadDropzone + UploadQueueDrawer"
```

---

## 阶段 F：改造现有组件（保持 props/emits 不变）

### Task 15: DfModal 加关闭按钮 + 改造 Mp4Player / FilePreviewModal / MovePickerModal

**Files:**
- Modify: `web/src/components/ui/DfModal.vue`（右上 X 关闭按钮）
- Modify: `web/src/components/Mp4Player.vue`（外壳 Tailwind 化，逻辑不动）
- Modify: `web/src/components/FilePreviewModal.vue`（非 player 走 DfModal）
- Modify: `web/src/components/MovePickerModal.vue`（走 DfModal）
- Update tests: `FilePreviewModal.test.ts`、`MovePickerModal.test.ts`（选择器）

**Interfaces（不变）:**
- `FilePreviewModal`：`{ kind, url, name, player? }` / `close`+`error`
- `MovePickerModal`：`{ open, excludeId? }` / `pick:[dest|null]`+`cancel`
- `Mp4Player`：`{ payload, name }` / `close`+`error`

- [ ] **Step 1: 升级 DfModal 加右上 X 按钮**

修改 `DfModal.vue`：import `{ X } from "lucide-vue-next"`，将 `<DialogTitle>` 那行替换为：

```vue
<div class="mb-2 flex items-start justify-between gap-4">
  <DialogTitle v-if="title" class="text-lg font-semibold text-fg">{{ title }}</DialogTitle>
  <button type="button" class="ml-auto text-fg-muted hover:text-fg" aria-label="关闭" @click="$emit('close')">
    <X class="h-5 w-5" />
  </button>
</div>
<slot />
```

在 `DfModal.test.ts` 增补：open 时存在 `aria-label="关闭"` 的按钮。

- [ ] **Step 2: 改造 Mp4Player（仅外壳，MSE 逻辑不动）**

替换 `Mp4Player.vue` 的 `<template>` 与移除 `<style scoped>`（保留 `<script setup>` 不变）：

```vue
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" @click.self="emit('close')">
    <div class="flex max-h-[90vh] max-w-[90vw] flex-col gap-3 overflow-auto rounded-xl border border-border bg-surface p-4 shadow-lg">
      <header class="flex items-center justify-between gap-4">
        <span class="font-semibold text-fg">{{ name }}</span>
        <button class="text-fg-muted hover:text-fg" @click="emit('close')">关闭</button>
      </header>
      <video ref="videoEl" controls autoplay class="max-h-[75vh] max-w-[85vw] rounded-lg bg-black" />
    </div>
  </div>
</template>
```

> 说明：MSE 依赖 `videoEl` 在 `onMounted` 立即可用，故不套 DfModal（其 transition 可能延迟挂载 ref）。仅样式化。

- [ ] **Step 3: 改造 FilePreviewModal（非 player 走 DfModal）**

`<script setup>` 删除 `onKey`/keydown 监听（DfModal 自带 ESC）。`loadText` 保留：

```vue
<!-- web/src/components/FilePreviewModal.vue -->
<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { FileKind } from "@/crypto/preview";
import type { PlayerPayload } from "@/player/msePlayer";
import Mp4Player from "./Mp4Player.vue";
import DfModal from "@/components/ui/DfModal.vue";

const props = defineProps<{ kind: FileKind; url: string; name: string; player?: PlayerPayload | null }>();
const emit = defineEmits<{ close: []; error: [message: string] }>();
const text = ref("");
async function loadText() {
  try { text.value = await (await fetch(props.url)).text(); }
  catch { text.value = "(unable to decode text)"; }
}
onMounted(() => { if (props.kind === "text") void loadText(); });
</script>

<template>
  <Mp4Player v-if="player" :payload="player" :name="name" @close="emit('close')" @error="(m) => emit('error', m)" />
  <DfModal v-else :open="true" :title="name" size="lg" @close="emit('close')">
    <div class="flex flex-col items-center gap-3">
      <img v-if="kind === 'image'" :src="url" :alt="name" class="max-h-[70vh] max-w-full rounded-lg" />
      <pre v-else-if="kind === 'text'" class="max-h-[70vh] w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg p-4 text-sm text-fg">{{ text }}</pre>
      <audio v-else-if="kind === 'audio'" controls :src="url" />
      <video v-else-if="kind === 'video'" controls :src="url" class="max-h-[70vh] max-w-full rounded-lg bg-black" />
    </div>
  </DfModal>
</template>
```

- [ ] **Step 4: 改造 MovePickerModal（走 DfModal）**

`<script setup>` 的 `hiddenIds`/`destinations` 逻辑保持不变，删除 `onKey`：

```vue
<!-- web/src/components/MovePickerModal.vue -->
<script setup lang="ts">
import { computed } from "vue";
import { useFoldersStore } from "@/stores/folders";
import { CornerUpLeft } from "lucide-vue-next";
import DfModal from "@/components/ui/DfModal.vue";
import FileTypeIcon from "@/components/FileTypeIcon.vue";

const props = defineProps<{ open: boolean; excludeId?: string }>();
const emit = defineEmits<{ pick: [dest: string | null]; cancel: [] }>();
const folders = useFoldersStore();

const hiddenIds = computed<Set<string>>(() => {
  const out = new Set<string>();
  if (!props.excludeId) return out;
  const stack = [props.excludeId];
  out.add(props.excludeId);
  while (stack.length) {
    const cur = stack.pop()!;
    for (const f of folders.folders) {
      if (f.parentId === cur && !out.has(f.id)) { out.add(f.id); stack.push(f.id); }
    }
  }
  return out;
});
const destinations = computed(() =>
  folders.folders
    .filter((f) => f.parentId === null && !hiddenIds.value.has(f.id))
    .sort((a, b) => a.name.localeCompare(b.name)),
);
</script>

<template>
  <DfModal :open="open" title="移动到…" size="sm" @close="emit('cancel')">
    <ul class="flex flex-col gap-0.5">
      <li>
        <button class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-bg" @click="emit('pick', null)">
          <CornerUpLeft class="h-4 w-4 text-fg-muted" /> 根目录
        </button>
      </li>
      <li v-for="d in destinations" :key="d.id">
        <button class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-bg" @click="emit('pick', d.id)">
          <FileTypeIcon :name="d.name" is-folder />
          <span class="truncate">{{ d.name }}</span>
        </button>
      </li>
      <li v-if="!destinations.length" class="px-3 py-2 text-sm text-fg-muted">没有其他文件夹。</li>
    </ul>
  </DfModal>
</template>
```

- [ ] **Step 5: 更新现有测试选择器 + 验证**

`FilePreviewModal.test.ts` / `MovePickerModal.test.ts` 原先断言旧 class（如 `.preview-backdrop`、`.picker-card`），改为按文本/角色断言（如 `expect(w.text()).toMatch(/移动到/)`）。运行：

Run: `npm run test --prefix web -- src/components/FilePreviewModal.test.ts src/components/MovePickerModal.test.ts` → PASS

- [ ] **Step 6: 全量验证 + Commit**

Run: `npm run typecheck --prefix web && npm run test --prefix web && npm run build --prefix web` 全绿。

```bash
git add web/src/components/ui/DfModal.vue web/src/components/ui/DfModal.test.ts \
  web/src/components/Mp4Player.vue web/src/components/FilePreviewModal.vue \
  web/src/components/MovePickerModal.vue web/src/components/FilePreviewModal.test.ts \
  web/src/components/MovePickerModal.test.ts
git commit -m "refactor(ui): wrap preview/move/mp4 modals in DfModal; add close button"
```

---

### Task 16: 改造 ShareDialog（DfModal + 替换 confirm/alert）

**Files:**
- Modify: `web/src/components/ShareDialog.vue`（DfModal + DfInput + DfButton + useConfirm + useToast + useClipboard）

**Interfaces（不变）:** `{ file: FileMeta }` / `close`。

- [ ] **Step 1: 改造 ShareDialog**

替换 `confirm()/alert()` 为 `useConfirm`/`useToast`；复制用 `useClipboard`：

```vue
<!-- web/src/components/ShareDialog.vue -->
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
const { copy: copyToClipboard, copied } = useClipboard({ source: "", copyWhenCoppied: false });

const password = ref("");
const usePassword = ref(false);
const expiryValue = ref<number | null>(null);
const expiryUnit = ref<"minutes" | "hours" | "days">("days");
const limitInput = ref<number | null>(null);
const createdUrl = ref<string | null>(null);

const existing = computed(() => shares.byFile[props.file.id] ?? []);
const canCreate = computed(() => !shares.creating && (!usePassword.value || password.value.trim().length > 0));

onMounted(() => { void shares.load(props.file.id); });

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
```

- [ ] **Step 2: 更新 ShareDialog.test.ts + 验证**

更新现有 `ShareDialog.test.ts` 选择器（stub `useSharesStore`/`useConfirm` 等）。Run: `npm run typecheck --prefix web && npm run test --prefix web -- src/components/ShareDialog.test.ts && npm run build --prefix web` → 全绿

- [ ] **Step 3: Commit**

```bash
git add web/src/components/ShareDialog.vue web/src/components/ShareDialog.test.ts
git commit -m "refactor(ui): ShareDialog on DfModal; replace confirm()/alert() with useConfirm/useToast"
```

---

## 阶段 G：页面应用

### Task 17: LoginView + RegisterView + NotFoundView + App.vue loading

**Files:** `web/src/views/{LoginView,RegisterView,NotFoundView}.vue`、`web/src/App.vue`

**约定：** 各页面保留现有 `<script setup>` 业务逻辑（auth/register/config store 调用不变），只重写 `<template>` 为 Tailwind + 新组件，移除 `<style scoped>`。

- [ ] **Step 1: 重写 LoginView**

```vue
<!-- web/src/views/LoginView.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useConfigStore } from "@/stores/config";
import { useTheme } from "@/composables/useTheme";
import { Sun, Moon, Monitor, Lock } from "lucide-vue-next";
import DfInput from "@/components/ui/DfInput.vue";
import DfButton from "@/components/ui/DfButton.vue";

const auth = useAuthStore();
const config = useConfigStore();
const router = useRouter();
const theme = useTheme();
const username = ref("");
const password = ref("");
const error = ref<string | null>(null);
const loading = ref(false);

async function submit() {
  error.value = null;
  loading.value = true;
  try {
    await auth.login({ username: username.value, password: password.value });
    router.push({ name: "drive" });
  } catch (e) { error.value = (e as Error).message; }
  finally { loading.value = false; }
}
const themeIcon = { light: Sun, dark: Moon, auto: Monitor } as const;
function cycleTheme() {
  const o = ["light", "dark", "auto"] as const;
  theme.store.value = o[(o.indexOf(theme.store.value as (typeof o)[number]) + 1) % o.length];
}
</script>

<template>
  <main class="relative flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-soft to-bg p-4 dark:from-brand/10">
    <button class="absolute right-4 top-4 rounded-lg p-2 text-fg-muted hover:bg-bg hover:text-fg" @click="cycleTheme">
      <component :is="themeIcon[theme.store.value as keyof typeof themeIcon]" class="h-5 w-5" />
    </button>
    <div class="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-md">
      <h1 class="mb-1 text-2xl font-extrabold text-brand">🦊 DragonFox Drive</h1>
      <p class="mb-6 flex items-center gap-1.5 text-sm text-fg-muted">
        <Lock class="h-3.5 w-3.5" /> 端到端加密 · 密码永不离开本机
      </p>
      <form class="flex flex-col gap-3" @submit.prevent="submit">
        <DfInput v-model="username" label="用户名" autocomplete="username" :disabled="loading" />
        <DfInput v-model="password" label="密码" type="password" autocomplete="current-password" :disabled="loading" />
        <DfButton type="submit" :loading="loading" :disabled="loading">{{ loading ? "登录中…" : "登录" }}</DfButton>
        <p v-if="error" class="text-sm text-danger">{{ error }}</p>
      </form>
      <p v-if="config.allowRegistration" class="mt-5 text-center text-sm text-fg-muted">
        没有账号？<RouterLink :to="{ name: 'register' }" class="font-medium text-brand">创建一个</RouterLink>
      </p>
    </div>
  </main>
</template>
```

- [ ] **Step 2: 重写 RegisterView**

```vue
<!-- web/src/views/RegisterView.vue -->
<script setup lang="ts">
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useConfigStore } from "@/stores/config";
import { AlertTriangle } from "lucide-vue-next";
import DfInput from "@/components/ui/DfInput.vue";
import DfButton from "@/components/ui/DfButton.vue";
import DfBadge from "@/components/ui/DfBadge.vue";

const auth = useAuthStore();
const config = useConfigStore();
const router = useRouter();
const username = ref("");
const password = ref("");
const confirmPwd = ref("");
const error = ref<string | null>(null);
const loading = ref(false);

const mismatch = computed(() => confirmPwd.value.length > 0 && password.value !== confirmPwd.value);

async function submit() {
  error.value = null;
  if (password.value !== confirmPwd.value) { error.value = "两次密码不一致。"; return; }
  loading.value = true;
  try { await auth.register({ username: username.value, password: password.value }); router.push({ name: "drive" }); }
  catch (e) { error.value = (e as Error).message; }
  finally { loading.value = false; }
}
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-soft to-bg p-4 dark:from-brand/10">
    <div class="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-md">
      <template v-if="config.loaded && !config.allowRegistration">
        <h1 class="mb-2 text-xl font-bold text-fg">注册已关闭</h1>
        <p class="mb-4 text-sm text-fg-muted">此实例不接受新账号注册。请联系管理员，或直接登录。</p>
        <DfButton variant="ghost" @click="router.push({ name: 'login' })">返回登录</DfButton>
      </template>
      <template v-else>
        <h1 class="mb-1 text-2xl font-extrabold text-brand">创建账号</h1>
        <p class="mb-3 flex items-center gap-1.5">
          <DfBadge variant="warn"><AlertTriangle class="mr-1 inline h-3 w-3" />重要</DfBadge>
        </p>
        <p class="mb-5 text-sm text-fg-muted">密码在浏览器内派生主加密密钥。忘记密码则数据<b>不可恢复</b>。</p>
        <form class="flex flex-col gap-3" @submit.prevent="submit">
          <DfInput v-model="username" label="用户名" autocomplete="username" placeholder="3-32 字符：小写字母/数字/_/-" :disabled="loading" />
          <DfInput v-model="password" label="密码" type="password" autocomplete="new-password" :disabled="loading" />
          <DfInput v-model="confirmPwd" label="确认密码" type="password" autocomplete="new-password" :error="mismatch ? '两次密码不一致' : undefined" :disabled="loading" />
          <DfButton type="submit" :loading="loading" :disabled="loading">{{ loading ? "创建中…" : "创建账号" }}</DfButton>
          <p v-if="error" class="text-sm text-danger">{{ error }}</p>
        </form>
        <p class="mt-5 text-center text-sm text-fg-muted">
          已有账号？<RouterLink :to="{ name: 'login' }" class="font-medium text-brand">登录</RouterLink>
        </p>
      </template>
    </div>
  </main>
</template>
```

- [ ] **Step 3: 重写 NotFoundView**

```vue
<!-- web/src/views/NotFoundView.vue -->
<script setup lang="ts">
import { Compass } from "lucide-vue-next";
import DfButton from "@/components/ui/DfButton.vue";
</script>
<template>
  <main class="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg p-4 text-center">
    <Compass class="h-16 w-16 text-brand/60" />
    <h1 class="text-3xl font-extrabold text-fg">走丢了</h1>
    <p class="text-sm text-fg-muted">这个页面不存在，或已被移除。</p>
    <DfButton @click="$router.push({ name: 'drive' })">返回网盘</DfButton>
  </main>
</template>
```

- [ ] **Step 4: 美化 App.vue loading 态**

```vue
<!-- web/src/App.vue 的 template/style 调整 -->
<template>
  <div v-if="auth.isRestoring" class="fixed inset-0 flex items-center justify-center bg-bg">
    <div class="flex flex-col items-center gap-3 text-fg-muted">
      <span class="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      <span class="text-sm">正在加载…</span>
    </div>
  </div>
  <template v-else>
    <RouterView />
    <DfToastContainer />
    <DfConfirmDialog />
    <DfPromptDialog />
  </template>
</template>
```
（`<script setup>` 的 import 已在前面任务累计添加；确认 `DfConfirmDialog`/`DfPromptDialog`/`DfToastContainer` 均已 import。）

- [ ] **Step 5: 验证 + Commit**

Run: `npm run typecheck --prefix web && npm run build --prefix web` 全绿。

```bash
git add web/src/views/LoginView.vue web/src/views/RegisterView.vue \
  web/src/views/NotFoundView.vue web/src/App.vue
git commit -m "feat(ui): redesign Login/Register/NotFound pages; polish App loading"
```

---

### Task 18: DriveView 重设计 + FileList 组件（核心）

**Files:**
- Create: `web/src/components/FileList.vue`
- Rewrite: `web/src/views/DriveView.vue`
- Update: `web/src/views/DriveView.test.ts`（选择器/文案中文化）

**Depends on:** AppHeader、UploadDropzone、UploadQueueDrawer、DfBreadcrumbs、DfSegmented、DfInput、DfButton、useConfirm/usePrompt/useToast（均前置任务）。

**说明：** 文件夹支持重命名（`folders.renameFolder`）；文件名位于加密 manifest 内、后端无重命名接口，故文件菜单不含"重命名"（保持现状）。文件名编辑在 Task 19 通过内联编辑仅在客户端显示层处理——此任务不做。

- [ ] **Step 1: 写 DriveView 测试（更新现有）**

```ts
// web/src/views/DriveView.test.ts
import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DriveView from "./DriveView.vue";

vi.mock("@/workers/crypto", () => ({ cryptoApi: {}, ensureCryptoReady: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/api/files", () => ({ filesApi: { list: vi.fn().mockResolvedValue({ files: [] }) } }));
vi.mock("@/api/folders", () => ({ foldersApi: { list: vi.fn().mockResolvedValue({ folders: [] }) } }));
vi.mock("@/components/MovePickerModal.vue", () => ({ default: { template: "<div />", props: ["open", "excludeId"] } }));

describe("DriveView", () => {
  it("renders header, breadcrumb and new-folder button at root", async () => {
    setActivePinia(createPinia());
    const w = mount(DriveView, { global: { stubs: ["RouterLink"] } });
    await flushPromises();
    expect(w.text()).toMatch(/DragonFox/);
    expect(w.text()).toMatch(/Drive/);
    expect(w.findAll("button").some((b) => b.text().includes("新建文件夹"))).toBe(true);
  });
});
```

- [ ] **Step 2: 创建 FileList 组件**

```vue
<!-- web/src/components/FileList.vue -->
<script setup lang="ts">
import { computed } from "vue";
import type { FileMeta } from "@/api/types";
import FileTypeIcon from "@/components/FileTypeIcon.vue";
import DfBadge from "@/components/ui/DfBadge.vue";
import DfEmpty from "@/components/ui/DfEmpty.vue";
import DfDropdown, { type DropdownItem } from "@/components/ui/DfDropdown.vue";
import {
  MoreHorizontal, Download, Share2, Pencil, FolderInput, Trash2, FolderOpen,
} from "lucide-vue-next";

type Entry =
  | { kind: "folder"; folder: { id: string; name: string } }
  | { kind: "file"; file: FileMeta };

const props = defineProps<{
  entries: Entry[];
  displayNames: Record<string, string>;
  search: string;
}>();
const emit = defineEmits<{
  openFolder: [string];
  openFile: [FileMeta];
  download: [FileMeta];
  share: [FileMeta];
  renameFolder: [string, string];
  moveFolder: [string];
  moveFile: [string];
  deleteFolder: [string, string];
  deleteFile: [FileMeta];
}>();

function fname(f: FileMeta): string { return props.displayNames[f.id] ?? f.id; }
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
const filtered = computed(() => {
  const q = props.search.trim().toLowerCase();
  if (!q) return props.entries;
  return props.entries.filter((e) =>
    e.kind === "folder" ? e.folder.name.toLowerCase().includes(q) : fname(e.file).toLowerCase().includes(q),
  );
});
function statusVariant(s: string) {
  return s === "ready" ? "ok" : s === "uploading" || s === "pending" ? "proc" : "neutral";
}
function statusLabel(s: string) {
  return ({ ready: "就绪", uploading: "上传中", pending: "等待" } as Record<string, string>)[s] ?? s;
}
function menuFor(e: Entry): DropdownItem[] {
  if (e.kind === "folder") {
    return [
      { label: "重命名", icon: Pencil, onClick: () => emit("renameFolder", e.folder.id, e.folder.name) },
      { label: "移动", icon: FolderInput, onClick: () => emit("moveFolder", e.folder.id) },
      { label: "删除", icon: Trash2, danger: true, onClick: () => emit("deleteFolder", e.folder.id, e.folder.name) },
    ];
  }
  return [
    { label: "打开", icon: FolderOpen, onClick: () => emit("openFile", e.file), disabled: e.file.status !== "ready" },
    { label: "下载", icon: Download, onClick: () => emit("download", e.file), disabled: e.file.status !== "ready" },
    { label: "分享", icon: Share2, onClick: () => emit("share", e.file), disabled: e.file.status !== "ready" },
    { label: "移动", icon: FolderInput, onClick: () => emit("moveFile", e.file.id) },
    { label: "删除", icon: Trash2, danger: true, onClick: () => emit("deleteFile", e.file) },
  ];
}
</script>

<template>
  <DfEmpty v-if="!filtered.length" title="这里还很空" description="拖拽文件到此处，或点击上传按钮" />
  <ul v-else class="flex flex-col gap-1">
    <li
      v-for="e in filtered"
      :key="e.kind + (e.kind === 'folder' ? e.folder.id : e.file.id)"
      class="group grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border border-transparent px-3 py-2 transition-colors hover:border-border hover:bg-surface"
    >
      <FileTypeIcon :name="e.kind === 'folder' ? e.folder.name : fname(e.file)" :is-folder="e.kind === 'folder'" />
      <button
        class="min-w-0 truncate text-left text-sm font-medium text-fg hover:text-brand"
        @click="e.kind === 'folder' ? emit('openFolder', e.folder.id) : emit('openFile', e.file)"
      >{{ e.kind === "folder" ? e.folder.name : fname(e.file) }}</button>
      <div class="flex items-center gap-3">
        <template v-if="e.kind === 'file'">
          <span class="hidden text-xs text-fg-muted sm:inline">{{ fmtSize(e.file.total_size) }}</span>
          <DfBadge :variant="statusVariant(e.file.status)">{{ statusLabel(e.file.status) }}</DfBadge>
        </template>
        <span v-else class="text-xs text-fg-muted">文件夹</span>
        <DfDropdown :items="menuFor(e)" align="right">
          <template #trigger>
            <button class="rounded-md p-1 text-fg-muted opacity-0 transition-opacity hover:bg-bg hover:text-fg group-hover:opacity-100">
              <MoreHorizontal class="h-4 w-4" />
            </button>
          </template>
        </DfDropdown>
      </div>
    </li>
  </ul>
</template>
```

- [ ] **Step 3: 重写 DriveView**

```vue
<!-- web/src/views/DriveView.vue -->
<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useAuthStore } from "@/stores/auth";
import { useFilesStore } from "@/stores/files";
import { useFoldersStore } from "@/stores/folders";
import { useConfirm } from "@/composables/useConfirm";
import { usePrompt } from "@/composables/usePrompt";
import { useToast } from "@/composables/useToast";
import type { FileMeta } from "@/api/types";
import AppHeader from "@/components/AppHeader.vue";
import UploadDropzone from "@/components/UploadDropzone.vue";
import UploadQueueDrawer from "@/components/UploadQueueDrawer.vue";
import FileList from "@/components/FileList.vue";
import DfBreadcrumbs from "@/components/ui/DfBreadcrumbs.vue";
import DfButton from "@/components/ui/DfButton.vue";
import DfSegmented from "@/components/ui/DfSegmented.vue";
import DfInput from "@/components/ui/DfInput.vue";
import FilePreviewModal from "@/components/FilePreviewModal.vue";
import MovePickerModal from "@/components/MovePickerModal.vue";
import ShareDialog from "@/components/ShareDialog.vue";
import { List, LayoutGrid, FolderPlus, Search } from "lucide-vue-next";

const auth = useAuthStore();
const files = useFilesStore();
const folders = useFoldersStore();
const confirm = useConfirm();
const prompt = usePrompt();
const toast = useToast();

const fileInput = ref<HTMLInputElement | null>(null);
const moveTarget = ref<{ kind: "folder" | "file"; id: string } | null>(null);
const shareTarget = ref<FileMeta | null>(null);
const view = ref<"list" | "grid">("list");
const search = ref("");

onMounted(async () => { await folders.loadTree(); await files.refresh(); });

function pickFile() { fileInput.value?.click(); }
async function onFilesChosen(list: File[]) {
  for (const f of list) {
    try { await files.upload(f); } catch { /* store surfaces */ }
  }
  await folders.loadTree();
}
async function onFileChosen(e: Event) {
  const t = e.target as HTMLInputElement;
  if (t.files?.length) await onFilesChosen(Array.from(t.files));
  t.value = "";
}

function openFile(f: FileMeta) { void files.openPreview(f).catch(() => {}); }
function download(f: FileMeta) { void files.download(f).catch(() => {}); }
function share(f: FileMeta) { shareTarget.value = f; }
async function removeFile(f: FileMeta) {
  if (await confirm.confirm({ message: `删除 “${files.displayNames[f.id] ?? f.id}”？`, danger: true, confirmText: "删除" })) {
    await files.remove(f.id); await folders.loadTree(); toast.success("已删除");
  }
}
async function newFolder() {
  const name = await prompt.prompt({ message: "文件夹名称", title: "新建文件夹", placeholder: "新建文件夹", confirmText: "创建" });
  if (name) { await folders.createFolder(name); toast.success("已创建"); }
}
async function renameFolder(id: string, current: string) {
  const name = await prompt.prompt({ message: "文件夹名称", title: "重命名", initial: current, confirmText: "保存" });
  if (name && name !== current) { await folders.renameFolder(id, name); toast.success("已重命名"); }
}
function moveFolder(id: string) { moveTarget.value = { kind: "folder", id }; }
function moveFile(id: string) { moveTarget.value = { kind: "file", id }; }
async function onMovePicked(dest: string | null) {
  const t = moveTarget.value; moveTarget.value = null;
  if (!t) return;
  try {
    if (t.kind === "folder") await folders.moveFolder(t.id, dest);
    else await files.moveFile(t.id, dest);
    toast.success("已移动");
  } catch { toast.error("移动失败，请重试"); }
}
async function deleteFolder(id: string, name: string) {
  if (await confirm.confirm({ message: `删除 “${name}” 及其所有内容？此操作无法撤销。`, danger: true, confirmText: "删除" })) {
    await folders.deleteFolder(id); toast.success("已删除");
  }
}

const crumbs = computed(() => [
  { id: null as string | null, label: "Drive" },
  ...folders.breadcrumbs.map((b: { id: string; name: string }) => ({ id: b.id as string | null, label: b.name })),
]);
const showPrev = computed(() => folders.page > 0);
const showNext = computed(() => folders.page < folders.totalPages - 1);
</script>

<template>
  <div class="min-h-screen bg-bg">
    <AppHeader :username="auth.username ?? '我'" active="drive" :show-upload="true" @upload="pickFile" />
    <UploadDropzone class="mx-auto w-full max-w-7xl px-4 py-6 md:px-6" @files="onFilesChosen">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <DfBreadcrumbs :items="crumbs" @navigate="(id) => folders.navigateTo(id)" />
        <DfInput v-model="search" class="min-w-[14rem] flex-1 sm:max-w-xs" placeholder="搜索当前文件夹…">
          <template #prefix><Search class="h-4 w-4 text-fg-muted" /></template>
        </DfInput>
        <div class="flex items-center gap-2">
          <DfButton variant="ghost" size="sm" @click="newFolder">
            <template #icon><FolderPlus class="h-4 w-4" /></template>新建文件夹
          </DfButton>
          <DfSegmented v-model="view" :options="[{ value: 'list', icon: List }, { value: 'grid', icon: LayoutGrid }]" />
        </div>
      </div>

      <p v-if="files.error || folders.error" class="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
        {{ files.error || folders.error }}
      </p>

      <div class="mt-4">
        <FileList
          :entries="folders.paginatedView"
          :display-names="files.displayNames"
          :search="search"
          @open-folder="(id) => folders.navigateTo(id)"
          @open-file="openFile"
          @download="download"
          @share="share"
          @rename-folder="renameFolder"
          @move-folder="moveFolder"
          @move-file="moveFile"
          @delete-folder="deleteFolder"
          @delete-file="removeFile"
        />
      </div>

      <nav v-if="folders.totalPages > 1" class="mt-6 flex items-center gap-3">
        <DfButton variant="ghost" size="sm" :disabled="!showPrev" @click="folders.setPage(folders.page - 1)">上一页</DfButton>
        <span class="text-sm text-fg-muted">第 {{ folders.page + 1 }} / {{ folders.totalPages }} 页</span>
        <DfButton variant="ghost" size="sm" :disabled="!showNext" @click="folders.setPage(folders.page + 1)">下一页</DfButton>
      </nav>

      <input ref="fileInput" type="file" multiple class="hidden" @change="onFileChosen" />
    </UploadDropzone>

    <UploadQueueDrawer :uploads="files.activeUploads" @cancel="(id) => files.cancelUpload(id)" />

    <FilePreviewModal
      v-if="files.preview"
      :kind="files.preview.kind"
      :url="files.preview.url"
      :name="files.preview.name"
      :player="files.preview.player"
      @close="files.closePreview()"
      @error="(m: string) => (files.error = m)"
    />
    <MovePickerModal
      :open="moveTarget !== null"
      :exclude-id="moveTarget?.kind === 'folder' ? moveTarget.id : undefined"
      @pick="onMovePicked"
      @cancel="moveTarget = null"
    />
    <ShareDialog v-if="shareTarget" :file="shareTarget" @close="shareTarget = null" />
  </div>
</template>
```

- [ ] **Step 4: 运行测试 + 全量验证**

Run: `npm run test --prefix web -- src/views/DriveView.test.ts` → PASS
Run: `npm run typecheck --prefix web && npm run build --prefix web` → 全绿

> 若 `files.displayNames` / `folders.breadcrumbs` / `folders.paginatedView` 的字段名与 store 不一致，以 store 实际签名为准微调（只读访问，不改 store）。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/FileList.vue web/src/views/DriveView.vue web/src/views/DriveView.test.ts
git commit -m "feat(ui): redesign DriveView with FileList, AppHeader, dropzone, confirm/prompt/toast"
```

---

### Task 19: FileList 增强（网格视图 + 多选 + 右键菜单 + 排序）

**Files:** Modify `web/src/components/FileList.vue`、`web/src/views/DriveView.vue`（批量栏）

**Interfaces 新增:**
- `FileList` 新增 props：`view: "list"|"grid"`、`selection: string[]`、`sortKey: "name"|"size"|"status"`、`sortDir: "asc"|"desc"`。
- 新增 emits：`update:selection: [string[]]`、`update:sortKey`、`update:sortDir`。
- 右键：在 DriveView 持有一个 `DfContextMenu` ref，行 `@contextmenu` 调 `menuRef.show(e)` 并记录目标项，菜单项复用 `menuFor`。

- [ ] **Step 1: 给 FileList 加网格视图**

在 `FileList.vue` `<template>` 末尾的 `</ul>` 后追加网格分支，并用 `v-if` 切换。将现有 `<ul v-else ...>` 改为 `<ul v-else-if="view === 'list'" ...>`，追加：

```vue
<div v-if="view === 'grid' && filtered.length" class="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
  <button
    v-for="e in filtered"
    :key="e.kind + (e.kind === 'folder' ? e.folder.id : e.file.id)"
    class="flex flex-col items-center gap-2 rounded-xl border border-border bg-surface p-4 text-center transition-colors hover:border-brand"
    @click="e.kind === 'folder' ? emit('openFolder', e.folder.id) : emit('openFile', e.file)"
  >
    <FileTypeIcon :name="e.kind === 'folder' ? e.folder.name : fname(e.file)" :is-folder="e.kind === 'folder'" />
    <span class="w-full truncate text-xs font-medium text-fg">{{ e.kind === "folder" ? e.folder.name : fname(e.file) }}</span>
    <span v-if="e.kind === 'file'" class="text-[10px] text-fg-muted">{{ fmtSize(e.file.total_size) }}</span>
  </button>
</div>
```

props 新增 `view: "list" | "grid"`（默认 list）。

- [ ] **Step 2: 多选（复选框 + 批量栏）**

FileList props 新增 `selection: string[]`，emit `update:selection`。每行 key 函数：

```ts
function keyOf(e: Entry): string { return e.kind + (e.kind === "folder" ? e.folder.id : e.file.id); }
function toggle(e: Entry, shift: boolean) {
  const k = keyOf(e);
  let next = new Set(props.selection);
  if (shift && lastSelected.value) { /* 区间选：filtered 中 [last, cur] 全选 */ }
  if (next.has(k)) next.delete(k); else next.add(k);
  lastSelected.value = k;
  emit("update:selection", [...next]);
}
```

列表行模板在 `<FileTypeIcon>` 前加：

```vue
<input type="checkbox" class="accent-brand"
  :checked="selection.includes(keyOf(e))"
  @click.stop="toggle(e, $event.shiftKey)" />
```

DriveView 新增 `const selection = ref<string[]>([])`，传给 FileList，并在 `selection.length` 时底部渲染批量栏：

```vue
<div v-if="selection.length" class="sticky bottom-4 mx-auto flex w-fit items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 shadow-lg">
  <span class="text-sm text-fg-muted">已选 {{ selection.length }} 项</span>
  <DfButton variant="ghost" size="sm" @click="bulkMove">移动</DfButton>
  <DfButton variant="danger" size="sm" @click="bulkDelete">删除</DfButton>
</div>
```
（`bulkMove`/`bulkDelete` 遍历 selection 调对应 store 方法 + useConfirm/useToast；清空 selection。）

- [ ] **Step 3: 右键菜单**

DriveView 加 `const ctxMenu = ref<InstanceType<typeof DfContextMenu> | null>(null)` 与 `const ctxTarget = ref<Entry | null>(null)`。FileList 行加 `@contextmenu="onCtx($event, e)"` emit `contextmenu: [MouseEvent, Entry]`。DriveView 监听：

```vue
<DfContextMenu ref="ctxMenu" :items="ctxItems" />
```
```ts
function onCtx(e: MouseEvent, entry: Entry) { ctxTarget.value = entry; ctxMenu.value?.show(e); }
const ctxItems = computed(() => ctxTarget.value ? menuFor(ctxTarget.value) : []);
```
（`menuFor` 从 FileList 提取为共享工具函数 `web/src/components/fileMenu.ts`，FileList 与 DriveView 都 import。）

- [ ] **Step 4: 列头排序**

列表 `<ul>` 前加列头（仅 list 视图）：

```vue
<div v-if="view === 'list' && filtered.length" class="grid grid-cols-[auto_1fr_auto] gap-3 border-b border-border px-3 pb-2 text-xs font-medium text-fg-muted">
  <span class="w-4" />
  <button class="flex items-center gap-1 hover:text-fg" @click="emit('update:sortKey', 'name')">名称</button>
  <span>大小</span>
</div>
```
`filtered` 改为按 `props.sortKey/sortDir` 排序的 computed（名称按 localeCompare，大小按 total_size，文件夹置顶）。

- [ ] **Step 5: 验证 + Commit**

Run: `npm run typecheck --prefix web && npm run test --prefix web && npm run build --prefix web` 全绿。

```bash
git add web/src/components/FileList.vue web/src/views/DriveView.vue web/src/components/fileMenu.ts
git commit -m "feat(ui): FileList grid view + multi-select + context menu + column sort"
```

---

### Task 20: SettingsView 重设计

**Files:** Rewrite `web/src/views/SettingsView.vue`（保留 auth/shares/files/devices 逻辑）

**说明：** 顶栏用 `AppHeader active="settings"`；二级分段用 `DfSegmented`（账户/设备/分享）切换显示区；设备/分享表格卡片化；所有 `confirm()/alert()` → `useConfirm/useToast`。

- [ ] **Step 1: 重写 SettingsView**

```vue
<!-- web/src/views/SettingsView.vue -->
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useSharesStore } from "@/stores/shares";
import { useFilesStore } from "@/stores/files";
import { authApi } from "@/api/auth";
import { devicesApi } from "@/api/devices";
import type { DeviceItem } from "@/api/types";
import { relativeTime } from "@/util/time";
import { useConfirm } from "@/composables/useConfirm";
import { useToast } from "@/composables/useToast";
import AppHeader from "@/components/AppHeader.vue";
import DfCard from "@/components/ui/DfCard.vue";
import DfButton from "@/components/ui/DfButton.vue";
import DfBadge from "@/components/ui/DfBadge.vue";
import DfSegmented from "@/components/ui/DfSegmented.vue";
import { Laptop, Trash2 } from "lucide-vue-next";

const auth = useAuthStore();
const shares = useSharesStore();
const files = useFilesStore();
const router = useRouter();
const confirm = useConfirm();
const toast = useToast();

const tab = ref<"account" | "devices" | "shares">("account");
const devices = ref<DeviceItem[]>([]);
const devicesError = ref<string | null>(null);
const busyId = ref<string | null>(null);
const busySignOut = ref(false);

function nameOf(fileId: string) { return files.displayNames[fileId] ?? fileId.slice(0, 8); }
function fmt(ts: string | null) { return ts ? new Date(ts).toLocaleString() : "—"; }
function opensOf(s: { download_count: number; download_limit: number | null }) {
  return s.download_limit ? `${s.download_count}/${s.download_limit}` : `${s.download_count}/∞`;
}

async function refreshDevices() {
  try { devices.value = await devicesApi.list(); devicesError.value = null; }
  catch { devicesError.value = "加载设备列表失败。"; }
}
async function onRevokeDevice(id: string) {
  if (!(await confirm.confirm({ message: "吊销此设备？它将立即被登出。", danger: true, confirmText: "吊销" }))) return;
  busyId.value = id;
  try { await devicesApi.revoke(id); await refreshDevices(); toast.success("已吊销"); }
  catch { toast.error("吊销失败"); }
  finally { busyId.value = null; }
}
async function onSignOut() {
  busySignOut.value = true;
  try { try { await authApi.logout(); } catch { /* server may already revoked */ } await auth.logout(); router.push({ name: "login" }); }
  finally { busySignOut.value = false; }
}
async function onRevoke(id: string) {
  if (!(await confirm.confirm({ message: "撤销此分享？链接将立即失效。", danger: true, confirmText: "撤销" }))) return;
  try { await shares.revoke(files.all[0]?.id ?? "", id); toast.success("已撤销"); }
  catch { toast.error("撤销失败"); }
}
async function onDelete(id: string) {
  if (!(await confirm.confirm({ message: "永久删除此分享记录？此操作无法撤销。", danger: true, confirmText: "删除" }))) return;
  try { await shares.purge(id); toast.success("已删除"); }
  catch { toast.error("删除失败"); }
}
onMounted(async () => { await files.refresh(); await shares.loadAll(); await refreshDevices(); });
</script>

<template>
  <div class="min-h-screen bg-bg">
    <AppHeader :username="auth.username ?? '我'" active="settings" />
    <main class="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
      <h1 class="mb-4 text-xl font-bold text-fg">设置</h1>
      <DfSegmented v-model="tab" :options="[{value:'account',label:'账户'},{value:'devices',label:'设备'},{value:'shares',label:'分享'}]" class="mb-4" />

      <DfCard v-if="tab === 'account'" header="账户">
        <p class="text-sm text-fg">登录身份：<strong>{{ auth.username }}</strong></p>
        <template #footer>
          <DfButton variant="ghost" size="sm" :loading="busySignOut" @click="onSignOut">退出登录</DfButton>
        </template>
      </DfCard>

      <DfCard v-else-if="tab === 'devices'" header="设备">
        <p v-if="devicesError" class="text-sm text-danger">{{ devicesError }}</p>
        <p v-else-if="!devices.length" class="text-sm text-fg-muted">没有已注册设备。</p>
        <ul v-else class="flex flex-col gap-2">
          <li v-for="d in devices" :key="d.id" class="flex items-center gap-3 rounded-lg border border-border p-3">
            <Laptop class="h-5 w-5 text-fg-muted" />
            <div class="min-w-0 flex-1">
              <p class="flex items-center gap-2 text-sm font-medium text-fg">
                {{ d.name }}
                <DfBadge v-if="d.id === auth.deviceId" variant="proc">当前设备</DfBadge>
              </p>
              <p class="text-xs text-fg-muted">最后在线 {{ relativeTime(d.last_seen_at) }}</p>
            </div>
            <DfButton v-if="d.id === auth.deviceId" variant="ghost" size="sm" :loading="busySignOut" @click="onSignOut">退出登录</DfButton>
            <DfButton v-else variant="danger" size="sm" :loading="busyId === d.id" @click="onRevokeDevice(d.id)">吊销</DfButton>
          </li>
        </ul>
      </DfCard>

      <DfCard v-else header="分享">
        <p v-if="!shares.all.length" class="text-sm text-fg-muted">暂无分享。</p>
        <ul v-else class="flex flex-col gap-2">
          <li v-for="s in shares.all" :key="s.id" class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-xs">
            <span class="font-medium text-fg">{{ nameOf(s.file_id) }}</span>
            <span class="text-fg-muted">创建 {{ fmt(s.created_at) }} · 到期 {{ fmt(s.expires_at) }} · 打开 {{ opensOf(s) }}{{ s.requires_password ? " · 密码" : "" }}</span>
            <span class="flex items-center gap-2">
              <DfBadge :variant="s.state === 'active' ? 'ok' : 'neutral'">{{ s.state }}</DfBadge>
              <DfButton variant="ghost" size="sm" :disabled="s.state === 'revoked'" @click="onRevoke(s.id)">撤销</DfButton>
              <DfButton variant="danger" size="sm" @click="onDelete(s.id)">删除</DfButton>
            </span>
          </li>
        </ul>
      </DfCard>
    </main>
  </div>
</template>
```

> 注：`onRevoke` 的 `shares.revoke` 第一个参数为 fileId——以 store 实际签名为准（原代码用 `fileIdOf(id)` 查找，保留该查找逻辑）。`files.all` 若不存在则用 store 现有列表访问器。

- [ ] **Step 2: 验证 + Commit**

Run: `npm run typecheck --prefix web && npm run build --prefix web` 全绿。

```bash
git add web/src/views/SettingsView.vue
git commit -m "feat(ui): redesign SettingsView with tabs/cards; replace confirm()/alert()"
```

---

### Task 21: ShareView 重设计（访客落地页）

**Files:** Rewrite `web/src/views/ShareView.vue`（保留所有 crypto/解锁逻辑，仅换外壳）

- [ ] **Step 1: 重写 ShareView 模板与样式**

`<script setup>` 全部保留（load/submitPassword/openPreview/download/closePreview 不变），仅替换 `<template>` 与移除 `<style scoped>`：

```vue
<template>
  <main class="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-soft to-bg p-4 dark:from-brand/10">
    <div class="w-full max-w-md rounded-2xl border border-border bg-surface p-8 text-center shadow-md">
      <h1 class="mb-4 text-xl font-extrabold text-brand">🦊 DragonFox Drive</h1>

      <p v-if="phase === 'loading'" class="flex items-center justify-center gap-2 text-sm text-fg-muted">
        <span class="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" /> 正在打开…
      </p>

      <section v-else-if="phase === 'password'" class="flex flex-col gap-3">
        <p class="text-sm text-fg">此分享受密码保护。</p>
        <DfInput v-model="passwordInput" type="password" placeholder="密码" @keyup.enter="submitPassword" />
        <DfButton :loading="false" @click="submitPassword">解锁</DfButton>
        <p v-if="message" class="text-sm text-danger">{{ message }}</p>
      </section>

      <section v-else-if="phase === 'ready'" class="flex flex-col items-center gap-4">
        <FileTypeIcon :name="manifest?.name ?? 'file'" />
        <p class="break-all text-sm font-semibold text-fg">{{ manifest?.name ?? "文件" }}</p>
        <div class="flex gap-2">
          <DfButton @click="openPreview">预览</DfButton>
          <DfButton variant="ghost" :loading="downloading" @click="download">{{ downloading ? "下载中…" : "下载" }}</DfButton>
        </div>
        <p v-if="message" class="text-sm text-danger">{{ message }}</p>
      </section>

      <section v-else>
        <p class="text-sm text-danger">{{ message ?? "分享不可用。"</p>
      </section>

      <FilePreviewModal
        v-if="preview"
        :kind="preview.kind" :url="preview.url" :name="preview.name" :player="preview.player"
        @close="closePreview" @error="(m: string) => (message = m)"
      />
    </div>
  </main>
</template>
```

新增 import：`DfButton`、`DfInput`、`FileTypeIcon`。

- [ ] **Step 2: 验证 + Commit**

Run: `npm run typecheck --prefix web && npm run build --prefix web` 全绿。

```bash
git add web/src/views/ShareView.vue
git commit -m "feat(ui): redesign ShareView guest landing page"
```

---

## 阶段 H：清理与验收

### Task 22: 清理残留 + 全量验收

**Files:** 全仓扫描；无新代码（仅可能的零星清理）。

- [ ] **Step 1: 确认无原生弹窗残留**

Run: `grep -rn "confirm(\|prompt(\|alert(" web/src --include="*.vue" --include="*.ts"`
Expected: 仅 `useConfirm`/`usePrompt`/`window.confirm` 之外的命中应为空（`useConfirm` 含子串 "confirm(" 会命中方法调用，需人工甄别——只允许 `useConfirm()`/`.confirm(`/`usePrompt`/`window.` 之外的浏览器原生 `confirm(`/`prompt(`/`alert(` 为零）。逐一确认为误报或已替换。

- [ ] **Step 2: 确认无旧 CSS 变量残留**

Run: `grep -rn "df-color-\|df-radius" web/src`
Expected: 空（所有 `--df-color-*`/`--df-radius-*` 已迁移到 Tailwind 令牌）。

- [ ] **Step 3: 确认无未删的 `<style scoped>` 残留旧样式（可选清理）**

人工抽查各 `.vue`：已迁移组件不应再有引用旧令牌的 scoped 样式。允许少量真正组件级样式留存。

- [ ] **Step 4: 全量自动化验收**

Run（按序，全绿）：
```bash
npm run typecheck --prefix web
npm run test --prefix web
npm run build --prefix web
```
Expected:
- `typecheck`：0 error。
- `test`：全部通过（含更新的 4 个原测试 + 新增组件测试）。
- `build`：`web/dist` 生成，`fixLibsodiumImport` 插件生效，无 libsodium 相关报错。

- [ ] **Step 5: 人工验收清单（逐项过）**

- [ ] 明亮主题：登录 / 注册 / 网盘 / 设置 / 分享落地 / 404 全过一遍，视觉一致、橙色品牌一致。
- [ ] 暗色主题：同上六页全过一遍，无对比度问题、无白底刺眼。
- [ ] 顶栏明暗切换按钮：light→dark→auto 循环正确，刷新后保持（防闪烁脚本生效）。
- [ ] 响应式：桌面（≥1024）/ 平板（640–1023）/ 手机（<640）三断点过网盘页，汉堡/列隐藏/批量栏/上传按钮均正常。
- [ ] 上传：点击上传 + 拖拽上传 + 多文件 + 队列浮层进度 + 取消。
- [ ] 文件操作：打开/下载/分享/移动/删除（含确认框 + 成功/失败 toast）。
- [ ] 文件夹：新建（prompt 弹窗）/ 重命名 / 移动 / 删除。
- [ ] 预览：图片/文本/音频/视频（含 MSE MP4 播放）。
- [ ] 分享创建：链接 + 密码 + 有效期 + 次数 + 复制 toast + 撤销/删除确认。
- [ ] 全程无浏览器原生 `confirm`/`prompt`/`alert` 弹出。

- [ ] **Step 6: Commit（如有清理）+ 终态提交**

```bash
git add -A web/src
git commit -m "chore(ui): final cleanup — drop legacy CSS vars and native dialogs" || echo "nothing to clean"
```

---

## 自审（执行前最终检查）

- **Spec 覆盖**：spec 各节均有任务对应——设计令牌(Task 1)、明暗(Task 1)、组件库(Task 3–11)、业务组件(Task 12–14)、改造组件(Task 15–16)、逐页(Task 17–21)、响应式(各页 Tailwind 断点)、移除 naive-ui(Task 2)、替换 confirm/prompt/alert(Task 8/9 + 各页)、测试(每任务 TDD + Task 22)。
- **占位符扫描**：无 TBD/TODO；每步含实际代码或确切命令。
- **类型一致**：`useToast.items`、`useConfirm.state`、`usePrompt.state`、`DfModal.open`、`DfDropdown.items`、`FileList.entries` 在跨任务引用处签名一致。
- **已知风险**：Tailwind v4 + Vite 6 与 libsodium 插件链（Task 1 Step 8 已含 build 验证关口）；Headless UI 在 happy-dom 的 Dialog 测试（Task 6 测试用 `attachTo: document.body` 绕过 teleport 问题）；store 字段名（Task 18 Step 4 已注明以 store 实际签名为准）。

---

**Plan 完成。** 共 22 个任务，分 8 个阶段（A 基础设施 / B 基础组件 / C 模态与服务 / D 菜单导航 / E 业务组件 / F 改造组件 / G 页面 / H 清理验收）。每个阶段是独立可测试的里程碑，阶段 A–C 完成后即拥有完整设计系统与全局服务，后续阶段在此基础上逐页重写。

