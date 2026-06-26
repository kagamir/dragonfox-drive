# DragonFox Drive UI 增量：i18n / 分享 Tab / 列分离 / 下载进度

- **日期**：2026-06-26
- **范围**：前端增量（`web/`），基于 2026-06-25 UI 重设计
- **状态**：待评审
- **关联**：`docs/superpowers/specs/2026-06-25-ui-redesign-design.md`

## 1. 概述

在已完成的 UI 重设计基础上，交付 4 项用户反馈驱动的改进：

1. **i18n 国际化**：英文为主 + 中文，按浏览器语言自动选择，可手动切换并持久化。
2. **分享独立成顶栏 tab**：从设置页移出，作为 `/shares` 路由，顶栏"我的文件"右侧新增"分享"胶囊。
3. **文件列表 3 列**：文件名 / 大小 / 状态 分列（当前大小与状态挤在同一 auto 列）。
4. **下载进度条**：下载像上传一样有队列浮层 + 进度 + 取消。

## 2. i18n 国际化

### 2.1 技术栈
- 引入 **`vue-i18n`**（Composition API 模式，`legacy: false`），在 `main.ts` 通过 `app.use(i18n)` 挂载。
- 新增 `web/src/locales/index.ts`（创建 i18n 实例 + 自动探测 + 持久化）与消息包 `web/src/locales/en.ts`、`web/src/locales/zh.ts`。

### 2.2 语言决策
- **支持语言**：`en`（默认）、`zh`。
- **自动探测**：启动时读 `navigator.language`；以 `zh` 开头（`zh`、`zh-CN`、`zh-TW`…）→ `zh`，其余 → `en`。
- **手动切换**：AppHeader 语言切换器（DfDropdown：English / 中文）；选择写入 `localStorage["df-lang"]`，立即生效。
- **优先级**：`localStorage["df-lang"]` > `navigator.language` > `en`。
- **防闪烁**：`web/index.html` 现有主题防闪脚本扩展，同步读取 `df-lang` 并设 `<html lang>`（仅标记，不阻塞渲染；i18n 在 bootstrap 内同步初始化避免文案闪烁）。

### 2.3 消息包结构（按域分组）
```
locales/en.ts / zh.ts 导出:
{
  common: { appName, cancel, confirm, delete, close, copy, copied, loading, … }
  auth:   { signIn, createAccount, username, password, confirmPassword, … }
  drive:  { myFiles, newFolder, search, upload, uploadHint, empty, name, size, status, … }
  share:  { share, shares, createLink, passwordProtect, expiry, maxOpens, existing, revoke, … }
  settings:{ settings, account, devices, signOut, revoke, currentDevice, lastSeen, … }
  toast:  { uploaded, deleted, moved, renamed, created, copyFailed, … }
  dialog: { confirmTitle, deleteConfirm, revokeConfirm, … }
  status: { ready, uploading, pending, folder }
}
```
缺失 key 回退到 `en`；vue-i18n 配 `fallbackLocale: "en"`、`missingWarn: false`（生产）/ 开发可开。

### 2.4 文案提取范围
- 全部 `web/src/views/*.vue`、`web/src/components/**/*.vue` 的硬编码中文/英文文案。
- `useToast`/`useConfirm`/`usePrompt` 的**默认**标题与按钮文案（如"请确认"/"取消"/"确认"）走 i18n；调用方传入的 `message`/`title`/`confirmText` 仍可覆盖（调用方自行 `t()` 后传入）。
- 后端 API 报错（`ApiError.message`）**不翻译**（来自服务器原文），仅在前端构造的提示里翻译前缀/后缀。
- 文件类型名（如"文件夹"）走 `status.folder`。

### 2.5 切换器
- AppHeader 主题按钮旁加语言按钮（lucide `Languages` 图标 + 当前语言短码），DfDropdown 选 English/中文。

## 3. 分享独立 tab

### 3.1 路由
- 新增 `web/src/router/index.ts`：`{ path: "/shares", name: "shares", component: () => import("@/views/SharesView.vue"), meta: { requiresAuth: true } }`。

### 3.2 SharesView（新）
- 新建 `web/src/views/SharesView.vue`：AppHeader（`active="shares"`）+ 标题 + 分享卡片列表。
- **迁移**：把现 `SettingsView` 的"分享"卡片整体迁来——`shares.all` 渲染、`onRevoke(id)`（`fileIdOf` 查 file_id → `shares.revoke`）、`onDelete(id)`（`shares.purge`）、`useConfirm` + `useToast`、`onMounted` 调 `files.refresh()` + `shares.loadAll()`。
- `nameOf(fileId)` 复用 `files.displayNames`。

### 3.3 SettingsView 收敛
- 移除"分享" tab；DfSegmented 选项收敛为 账户 / 设备；删除分享相关代码（`onRevoke`/`onDelete`/`nameOf`/`opensOf`/`existing` 渲染）。

### 3.4 AppHeader 导航
- `active` prop 类型扩展为 `"drive" | "shares" | "settings"`。
- 在"我的文件"胶囊后加"分享"胶囊（`<RouterLink :to="{ name: 'shares' }">`），active 时 `bg-brand-soft text-brand`。

## 4. 文件列表 3 列

### 4.1 列结构
- `FileList.vue` 列表 grid 从 `grid-cols-[auto_1fr_auto]` → `grid-cols-[auto_1fr_auto_auto]`：checkbox | 名称 | 大小 | 状态。
- 大小 span 独占第 3 列；状态徽章 + ⋯ 菜单 共占第 4 列。
- 文件夹行：第 3 列空、第 4 列显示"文件夹"文字（`status.folder`）。
- 列头：名称 / 大小 / 状态 三个 sortable 按钮（第 4 列头为空，对齐菜单）。

### 4.2 状态排序
- 新增 `sortKey: "name" | "size" | "status"`；`status` 排序按级别映射 `ready=0 < uploading=1 < pending=2 < deleted=3`（文件夹视为 `-1` 置顶），同 `sortDir` 翻转。

### 4.3 响应式
- `<sm`：隐藏"大小"列（`hidden sm:table-cell` 等效 Tailwind），保留 名称 / 状态。
- 网格视图不变（已是卡片）。

## 5. 下载进度

### 5.1 store 扩展（`web/src/stores/files.ts`）
- 新增接口 `DownloadSession { fileId: string; name: string; progress: number; phase: "downloading" | "done" | "error"; abort: AbortController }`。
- 新增 state `activeDownloads = ref<DownloadSession[]>([])`。
- 改造 `download(meta)`：
  1. 推入会话（`phase:"downloading"`, `progress:0`）。
  2. `asyncPool` 内每个 chunk 完成后 `session.progress = done/total`。
  3. 成功 → `phase:"done"` → `saveBlob` → 短延迟后从 `activeDownloads` 移除；失败 → `phase:"error"` → 抛出 + 留在列表（带错误态）供用户查看，可手动移除。
  4. 保留 `downloading` ref（任一会话进行中为 true）以兼容。
- 新增 `cancelDownload(fileId)`：`abort.abort()` + 从列表移除（下载的 getChunk 请求需透传 `abort.signal`，`filesApi.getChunk` 已支持或加 signal 参数）。

### 5.2 DownloadQueueDrawer（新）
- `web/src/components/DownloadQueueDrawer.vue`：镜像 `UploadQueueDrawer`，**右下角** Teleport 浮层，列进度条（brand 色）+ phase 文案 + 取消按钮（emit `cancel: [fileId]`）。
- DriveView 挂载 `<DownloadQueueDrawer :downloads="files.activeDownloads" @cancel="(id) => files.cancelDownload(id)" />`。

### 5.3 API
- `filesApi.getChunk(id, idx)` 若不支持 signal，加可选第三参 `signal?: AbortSignal` 透传 fetch。

## 6. 全局约束（沿用 2026-06-25 spec）

- 品牌色 `#FF7A45`；明亮为主 + 暗色镜像；Tailwind v4 令牌；`Df*` 组件库；Headless UI。
- 不改 crypto/MSE/libsodium；`fixLibsodiumImport` 等配置不动。
- 验证命令：`npm run typecheck --prefix web`、`npm run test --prefix web`、`npm run build --prefix web`。
- TDD 纪律；每任务一次 commit；master + auto-commit（用户既定）。

## 7. 测试与验收

- **i18n**：`locales/index.ts` 探测逻辑单测（`zh-CN`→zh、`en-US`→en、localStorage 覆盖）；关键视图至少一处 `t()` 渲染断言（中英切换）。
- **分享 tab**：`/shares` 路由可达；SharesView 渲染分享列表；SettingsView 无分享 tab；AppHeader active 状态正确。
- **列**：FileList 3 列渲染；状态列排序生效（单测 sortKey=status）。
- **下载**：store `download` 推入 activeDownloads + progress 递增（单测，mock asyncPool 或 getChunk）；DownloadQueueDrawer 渲染 + cancel emit。
- **回归**：现有 223 测试保持绿（选择器因 i18n 文案变化需同步更新——优先按 `data-testid` 或 i18n key 断言，避免硬编码中文字面量）。
- typecheck / build 必须通过。

## 8. 非目标（YAGNI）

- 不做服务端 i18n（API 报错原文不译）。
- 不引入更多语言（仅 en/zh）。
- 不做 SSR / 语言路由前缀（`/zh/drive`）。
- 不改上传队列（仅新增对称的下载队列）。
- 不重构现有 Df* 组件库内部。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| i18n 提取面广，遗漏文案 | 按 views→components→services 顺序提取；grep 中英文面量查漏；缺失 key 回退 en |
| 现有测试硬编码中文字面量（如 `/Drive/`、`/新建文件夹/`） | 改用 `data-testid` 或 `t(key)` 断言；i18n 测试用例显式切语言验证 |
| 下载 abort 需 getChunk 支持 signal | 实现前先确认 `filesApi.getChunk` 签名，按需加参 |
| vue-i18n 与 Vite 的 locale 动态导入 | 直接静态 import en/zh（体积小，仅 2 语言），避免动态 import 复杂度 |
