# DragonFox Drive UI 重设计

- **日期**：2026-06-25
- **范围**：前端全站（`web/`）视觉与交互重设计
- **状态**：待评审

## 1. 概述

对 DragonFox Drive 前端进行一次全站视觉与交互重设计，从当前"功能化极简"的原生 HTML/CSS 界面，升级为**友好活泼、优雅、便捷、美观**的现代网盘产品体验。

当前痛点（基于 `web/src/views/*` 与 `web/src/components/*` 实测）：

- `naive-ui` 在 `package.json` 依赖中但**全项目零使用**，所有控件为原生 HTML + 手写 CSS 变量。
- 全站交互依赖 `prompt()` / `confirm()` / `alert()`（见 `DriveView.vue:96-98,108-110,121-124`、`SettingsView.vue:45,69-83`），粗糙且不可定制。
- 用 emoji（📁📄🎬）充当文件类型图标，无统一图标体系。
- 仅暗色主题，无明暗切换；CSS 变量 `--df-color-*` 仅 6 个令牌，表达力不足。
- 列表项是文字堆叠 + 一排 `.link` 文字按钮，无视觉层次、无悬浮态、无批量操作、无右键菜单。
- 无响应式断点，移动端不可用。
- 上传区为虚线框，上传进度原始（原生 `<progress>`）。

## 2. 设计目标

| 目标 | 含义 | 验收信号 |
|------|------|----------|
| 友好活泼 | 明亮配色、圆润形状、轻松文案、彩色文件类型标识 | 第一眼有 Proton/Dropbox 既视感 |
| 优雅 | 克制的留白、精致的排版与阴影、流畅过渡 | 视觉层次清晰，无毛糙感 |
| 便捷 | 批量操作、右键菜单、拖拽、快捷键、内联重命名 | 常用操作点击数 ≤ 竞品 |
| 美观 | 统一的设计令牌、一致的组件、明暗双主题 | 全站无视觉违和 |

**非目标（YAGNI）**：不做实时协作、不做版本历史、不做 OCR/全文搜索、不做自定义主题色、不做 PWA 离线（保持范围聚焦）。

## 3. 设计原则

1. **内容优先**：文件是主角， chrome（顶栏/工具条）克制，让文件列表呼吸。
2. **明亮为主，暗色为镜像**：默认明亮主题，暗色一键切换，两套均为一等公民。
3. **橙色为魂**：`#FF7A45` 作为唯一品牌强调色，贯穿按钮、链接、选中、聚焦。
4. **圆角柔和**：卡片 12–16px、控件 8–10px、徽章/胶囊全圆，避免锐利直角。
5. **一致性胜过创意**：同类操作永远走同一个组件、同一个位置、同一个动效。
6. **可逆操作静默，不可逆操作确认**：删除等走确认模态框；切主题、切视图走即时反馈。

## 4. 技术栈变更

| 用途 | 当前 | 目标 | 说明 |
|------|------|------|------|
| 样式 | 手写 CSS 变量 | **Tailwind CSS v4** | CSS-first 配置（`@import "tailwindcss"`），令牌用 `@theme` 定义 |
| 复杂交互控件 | 无 | **Headless UI (`@headlessui/vue`)** | 模态框、下拉菜单、右键菜单、切换组、Tooltip |
| 图标 | emoji | **`lucide-vue-next`** | 矢量、线性、统一粗细，与 Tailwind 风格契合 |
| 工具函数 | 部分 `@vueuse/core` | 继续用 `@vueuse/core` | 明暗模式用 `useColorMode`、拖拽用 `useDropZone` 等 |
| 移除 | `naive-ui` | **删除依赖** | 确认无引用后从 `package.json` 移除，减小包体 |

**Tailwind v4 集成方式**：通过官方 `@tailwindcss/vite` 插件（Vite 6 兼容），在 `web/src/styles/main.css` 顶部 `@import "tailwindcss"`，用 `@theme` 块声明设计令牌，明暗用 `@custom-variant dark` 配合 `.dark` class 切换。

## 5. 设计令牌（Design Tokens）

全部在 `web/src/styles/main.css` 的 `@theme` 中声明，明暗两套。

### 5.1 色板

**明亮主题**

| 令牌 | 值 | 用途 |
|------|------|------|
| `--color-brand` | `#FF7A45` | 主色：主按钮、链接、选中、聚焦环 |
| `--color-brand-hover` | `#F0682F` | 主色悬浮 |
| `--color-brand-soft` | `#FFF1EA` | 主色软背景（徽章、胶囊导航激活） |
| `--color-bg` | `#F5F6F8` | 页面背景 |
| `--color-surface` | `#FFFFFF` | 卡片/顶栏/模态框表面 |
| `--color-fg` | `#2B313A` | 主文字 |
| `--color-fg-muted` | `#5B6472` | 次文字、元信息 |
| `--color-border` | `#E2E5EA` | 边框、分隔线 |
| `--color-success` | `#1A8243` | 成功 |
| `--color-warning` | `#B26B00` | 警告（配 `#FFF4D6` 软底） |
| `--color-danger` | `#E0322B` | 错误/删除（配 `#FEE` 软底） |

文件类型色块（软底 + 同色系深色图标）：

| 类型 | 软底 | 用于 |
|------|------|------|
| 文档 | `#E8F0FE` | pdf/doc/docx/txt |
| 图片 | `#FCE8F0` | png/jpg/jpeg/gif/webp/svg |
| 视频 | `#FFF1EA`（品牌系） | mp4/mov/m4v/webm |
| 音频 | `#EEEAF6` | mp3/wav/flac |
| 压缩 | `#E7F5EC` | zip/tar/gz/rar |
| 文件夹 | `#FFF1EA` | folders |
| 其他 | `#F0F1F4` | 兜底 |

**暗色主题**（镜像，保持橙色不变）

| 令牌 | 值 |
|------|------|
| `--color-bg` | `#0F1115` |
| `--color-surface` | `#161A22` |
| `--color-fg` | `#E6E9EF` |
| `--color-fg-muted` | `#9AA4B2` |
| `--color-border` | `#232936` |
| `--color-brand-soft` | `rgba(255,122,69,.16)` |
| 文件类型软底 | 对应明亮色的 ~20% 不透明度叠加 |

### 5.2 字体与字号

- **字体栈**：`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif`（系统字体优先，零网络成本，中英文均佳）。
- **字号阶梯**：`xs` 12px（元信息）/ `sm` 13px（次级）/ `base` 14px（正文）/ `lg` 16px（标题）/ `xl` 20px（页标题）/ `2xl` 28px（空状态/品牌）。
- **字重**：regular 400 / medium 500 / semibold 600 / bold 700（品牌字）。

### 5.3 圆角、阴影、间距、动效

- **圆角**：`sm` 8px（按钮/输入）/ `md` 10px（小卡片）/ `lg` 12px（卡片/模态框）/ `xl` 16px（大面板）/ `full`（胶囊/徽章/头像）。
- **阴影**：`sm`（卡片静态）/ `md`（悬浮/下拉）/ `lg`（模态框）。暗色主题阴影降为接近黑色的边框 + 微弱发光。
- **间距**：沿用 4px 基线网格（Tailwind 默认刻度）。
- **动效**：过渡默认 `150ms ease`；模态框/抽屉 `200ms`；明暗切换 `200ms` 颜色过渡（`transition-colors`）。禁止弹跳/旋转等分散注意力的动效。

## 6. 应用骨架（方案 C：顶栏 + 全宽）

```
┌─────────────────────────────────────────────────────┐
│ 🦊 DragonFox   [我的文件] [分享]   🔍   ↑上传  🌙/☀ │ ← 固定顶栏
├─────────────────────────────────────────────────────┤
│  Drive / 文档 / 子目录                  [▦] [☰] ⋯  │ ← 面包屑 + 视图切换
│                                                      │
│  ☑ 名称              大小    修改      状态      ⋯  │ ← 列头（可排序）
│  ☑ 📁 工作目录        —      今天                  │
│  ☑ 📄 季度报告.pdf   2.4 MB  今天      就绪       ⋯ │ ← 文件行
│  ...                                                 │
│                                                      │
│  ← 1 2 3 … →                  已选 2 项 [下载][删除]│ ← 分页 + 批量栏
└─────────────────────────────────────────────────────┘
```

**顶栏（全站共享 `<AppHeader>`）**：

- 左：品牌（🦊 + "DragonFox" 字标，brand 色）
- 中：主导航胶囊（当前页高亮，brand-soft 底）；含"我的文件""分享"。设置改为右侧用户菜单内。
- 右：全局搜索框（中宽，可折叠）、上传按钮（brand 主按钮）、明暗切换图标按钮、用户头像下拉菜单（用户名 / 设置 / 登出）。
- 移动端：导航与搜索收进汉堡菜单，上传按钮保留。

**内容区**：全宽，最大宽度 `max-w-7xl` 居中，左右内边距响应式。无侧栏。

**空状态/加载态/错误态**：每个列表均实现三态（友好插画 + 文案 + 行动按钮）。

## 7. 组件库设计

### 7.1 基础组件（Tailwind 手写，放 `web/src/components/ui/`）

| 组件 | 说明 |
|------|------|
| `DfButton` | variant: `primary` / `ghost` / `danger` / `subtle`；size: `sm`/`md`；loading 态；icon 插槽 |
| `DfInput` / `DfTextarea` | label、hint、error、前后置图标槽 |
| `DfBadge` | variant: `ok`/`warn`/`err`/`proc`/`neutral` |
| `DfCard` | surface 底 + 圆角 lg + 边框，可带 header/footer 插槽 |
| `DfSpinner` | brand 色环形 loader |
| `DfEmpty` | 插画 + 标题 + 副文案 + CTA |
| `DfTooltip` | Headless UI Tooltip 封装 |

### 7.2 复合组件（Headless UI 驱动）

| 组件 | 替换当前 | 说明 |
|------|----------|------|
| `DfModal` | 自写 modal | Headless UI `Dialog`，居中，支持 `danger`，ESC/遮罩关闭，focus trap |
| `DfConfirmDialog` | `confirm()` 全部调用 | 标题 + 正文 + 取消/确认（danger），异步 Promise |
| `DfPromptDialog` | `prompt()` 全部调用（新建文件夹） | 输入校验、预填、回车确认。文件/文件夹**重命名**走内联编辑，不用此组件 |
| `DfToast` / `useToast()` | `alert()` + 内联 `.error` | 右下角堆叠，success/info/warning/error，自动消失 |
| `DfDropdown` / `DfContextMenu` | `.link` 按钮堆叠 | 文件右键菜单 + 行内 ⋯ 菜单：打开/下载/分享/重命名/移动/删除 |
| `DfSegmented` | 视图切换 | 列表/网格切换组 |
| `DfBreadcrumbs` | 自写面包屑 | 带分隔图标，过长省略中段 |

### 7.3 业务组件（升级现有）

| 组件 | 改造 |
|------|------|
| `FilePreviewModal` | 用 `DfModal` 重写外壳；图片/视频/音频/文档预览统一带顶栏（文件名 + 下载 + 关闭）；保留 MSE 播放管线 |
| `MovePickerModal` | 用 `DfModal` + 树形列表，支持新建子文件夹 |
| `ShareDialog` | 用 `DfModal`；链接/密码/有效期/下载次数表单，复制按钮带 toast |
| `Mp4Player` | 自定义控件套壳（播放条 + 品牌 progress），其余逻辑不动 |
| `FileList`（新拆分） | 从 `DriveView` 抽出，支持列表/网格、多选、排序、右键 |
| `UploadDropzone`（新） | 整页拖拽接收 + 上传队列浮层（右下角，多文件并行进度） |

## 8. 逐页设计

### 8.1 登录页 `LoginView`
- 全屏 brand 渐变/插画背景（明亮：浅橙→米白；暗色：深石板）。
- 居中白色卡片：品牌字标 + "端到端加密 · 密码永不离开本机" 副文案 + 用户名/密码 + 主按钮"登录" + 错误内联红。
- 卡片下方：注册链接（若 `config.allowRegistration`）。
- 右上角小明暗切换图标（预登录也可换肤）。

### 8.2 注册页 `RegisterView`
- 复用登录页骨架，卡片更窄标题"创建账户"。
- 警示文案用 `DfBadge warn` 高亮："忘记密码则数据不可恢复"。
- 密码确认实时校验（不匹配内联提示），用户名带 pattern 提示。
- 注册禁用时显示友好空卡 + 返回登录。

### 8.3 网盘主页 `DriveView`（核心）
- 顶栏（见 §6）。
- 工具行：面包屑（左）+ 视图切换 + 排序 + 新建文件夹（右）。
- **上传**：整页 `UploadDropzone`（拖文件到任意位置触发），顶栏上传按钮，上传队列浮层在右下。
- **文件列表**：
  - 列头：复选框（全选）、名称（图标+名）、大小、修改时间、状态徽章、操作 ⋯。
  - 点击列头排序；行悬浮高亮 + 显示 ⋯；行双击打开/进入。
  - 多选：复选框 + Shift 范围选；选中后底部浮出批量栏（下载/移动/删除）。
  - 右键菜单（`DfContextMenu`）：上下文操作。
  - 重命名：双击文件名进入内联编辑（替换 `prompt()`）。
- **空状态**：`DfEmpty` 插画"这里还很空，拖个文件进来吧" + 上传按钮。
- **分页**：保留现有分页机制，样式升级为带页码的组件；新增"每页条数"选择器（默认与现状一致）。

### 8.4 设置页 `SettingsView`
- 顶栏 + 左侧粘性二级导航（锚点）：账户 / 设备 / 分享。右侧分段卡片。
- **账户**：用户名展示 + 登出 + 主题偏好（明/暗/跟随系统）。
- **设备**：卡片列表替代 `<table>`，每项含设备图标、名称、"当前设备"徽章、最后在线、吊销按钮（danger，走 `DfConfirmDialog`）。
- **分享**：表格升级（响应式卡片化），操作走下拉菜单 + 确认框，`alert()` 改 toast。

### 8.5 分享落地页 `ShareView`（访客）
- 居中卡片：品牌字标 + 文件图标 + 文件名 + 大小。
- 加载/密码/就绪/错误四态各友好设计；密码态用 `DfInput` + 解锁按钮，错误内联。
- 就绪态：预览 + 下载主按钮。
- 此页**不计入主顶栏**，独立极简顶栏（仅品牌 + 明暗切换）。

### 8.6 404 `NotFoundView`
- 居中友好插画 + "走丢了" 文案 + 返回网盘按钮（brand）。

## 9. 交互细节

- **明暗切换**：`useColorMode`（@vueuse），存 localStorage，class 策略挂 `<html class="dark">`；首次访问跟随 `prefers-color-scheme`；全站 `transition-colors`。
- **拖拽上传**：`useDropZone` 监听整个 `DriveView`，拖入时整页 brand-soft 蒙层提示；支持多文件。
- **批量操作**：复选 + Shift 区间；选中后底部 sticky 批量栏。
- **快捷键**（桌面端）：`/` 聚焦搜索、`N` 新建文件夹、`Delete` 删除选中、`Ctrl+A` 全选、`?` 展示快捷键面板（YAGNI 可后置）。
- **复制反馈**：所有"复制链接"用 `useClipboard` + toast"已复制"。
- **加载态**：列表骨架屏（skeleton）替代纯文字"Loading…"。

## 10. 响应式策略

| 断点 | 行为 |
|------|------|
| ≥ 1024px（桌面） | 完整顶栏 + 列表所有列 |
| 640–1023px（平板） | 顶栏导航收汉堡；列表隐藏"修改时间"次列 |
| < 640px（手机） | 汉堡菜单；列表简化为图标+名+菜单；批量栏底部；上传走 + 按钮；模态框全屏 |

## 11. 迁移与清理

1. **新增依赖**：`tailwindcss@^4`、`@tailwindcss/vite`、`@headlessui/vue`、`lucide-vue-next`。
2. **删除依赖**：`naive-ui`（确认无引用）。
3. **令牌迁移**：`web/src/styles/main.css` 从手写变量改为 Tailwind `@theme`；全站 `--df-color-*` 引用替换为 Tailwind 类。
4. **`<style scoped>` 清理**：各 `.vue` 的 scoped 样式逐步迁移到 Tailwind 工具类；保留极少数真正组件级的样式。
5. **替换原生弹窗**：全项目搜索 `confirm(`/`prompt(`/`alert(`，逐一替换为 `DfConfirmDialog`/`DfPromptDialog`/`useToast`。
6. **保留不动**：`crypto/`、`workers/`、`api/`、`stores/` 逻辑层不动；`Mp4Player` 的 MSE 管线逻辑不动，只换控件外壳。

## 12. 测试与验收

- **保留并迁移现有 vitest 测试**：`DriveView.test.ts`、`FilePreviewModal.test.ts`、`MovePickerModal.test.ts`、`ShareDialog.test.ts` 中的选择器会因 class→Tailwind 变化而需更新；行为断言保持。
- **新增测试**：`DfConfirmDialog`/`DfPromptDialog`/`useToast` 的基础交互测试；明暗 class 切换测试。
- **typecheck**：`npm run typecheck --prefix web` 必须通过。
- **构建**：`npm run build --prefix web` 必须通过（注意 `AGENTS.md` 中 libsodium 构建陷阱不受影响）。
- **人工验收**：明/暗两套主题逐页过一遍；桌面/平板/手机三断点过一遍；所有原 `confirm/prompt/alert` 路径走一遍。

## 13. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Tailwind v4 + Vite 6 + libsodium 插件链冲突 | 先在隔离分支跑通 `npm run build`，确认 `fixLibsodiumImport` 插件仍生效 |
| `vue-virtual-scroller`（大列表虚拟滚动）与自定义列表行样式兼容 | 列表行用 Tailwind 类，保持该库所需 DOM 结构 |
| 暗色主题下文件类型软底对比度不足 | 暗色用 20% 不透明叠加而非实色，图标改同色系亮色 |
| 范围蔓延（协作/搜索等） | 严格守住 §2 非目标 |
