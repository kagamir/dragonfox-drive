# 设备管理与吊销设计 (Device Management & Revocation)

- 日期: 2026-06-25
- 状态: Draft → 待评审
- 关联: P4 (`README.md`), P1 E2EE auth (`docs/crypto-design.md`)

## 1. 目标

1. **刷新不退登**：浏览器持有"时效认证"后，刷新页面 / 关闭再打开浏览器（在同一服务器进程未重启期间）保持登录。
2. **设备注册**：每次登录自动在服务端登记一台设备（从 User-Agent 解析名），access/refresh token 绑定该 device_id。
3. **即时吊销**：在设备管理页可秒级吊销任意其他设备，下一次受保护请求立即 401。

**非目标**:
- 跨服务器重启的会话保持（用户已明确接受"重启即失效"——当前 JWT 签名密钥每次启动随机生成的逻辑保留不动）。
- 服务端存储 `device_wrap`（分析后确认无意义，每浏览器 device_key 本地化）。
- 设备重命名（设备名仅由 User-Agent 自动生成）。
- "Panic button"（一键吊销所有其他设备）——留作 YAGNI。

## 2. 关键决策记录

| 决策点 | 选择 | 备注 |
|--------|------|------|
| 吊销即时性 | 真正即时（秒级） | 每请求查 `devices.revoked_at` |
| JWT secret 持久化 | 不动（重启即失效） | 用户接受此约束 |
| 设备命名 | 自动从 User-Agent 生成 | 服务端解析为 `"Browser · OS"` |
| 自吊销 | 禁止；当前设备只能 Sign out | API 层也加防御 |
| logout 副作用 | 一并软吊销 devices 行 | 简化状态机：active / revoked 两种 |
| 服务端 device_wrap | 不存；列从 `devices` 表删除 | 开发期，无数据需迁移 |
| per-request 检查成本 | SQLite 主键查询 ~10-100µs | 可忽略，不加缓存 |

## 3. 数据模型变更

### 3.1 新 migration `20260101000004_devices_revocation.sql`

```sql
-- 删除 devices 表中开发期未使用、且本设计确认不需要的列
ALTER TABLE devices DROP COLUMN pubkey;
ALTER TABLE devices DROP COLUMN device_wrap;
ALTER TABLE devices DROP COLUMN device_wrap_nonce;
```

> SQLite 3.35+ 支持 `ALTER TABLE ... DROP COLUMN`（项目用 sqlx + bundled SQLite，符合）。

### 3.2 `devices` 表最终形态

```
id              TEXT PRIMARY KEY        -- UUID v4，写入 JWT dev claim
user_id         TEXT NOT NULL FK users CASCADE
name            TEXT NOT NULL           -- "Chrome 120 · macOS"，由 UA 解析
last_seen_at    TEXT                    -- extractor 节流更新（>60s 才写）
revoked_at      TEXT                    -- NULL=active；非空=已吊销
created_at      TEXT NOT NULL default now
```

`refresh_tokens.device_id`：已有 `REFERENCES devices(id) ON DELETE CASCADE`；改为始终填充。我们不 `DELETE` 设备行（保留审计），所以级联实际不触发，显式 `UPDATE refresh_tokens SET revoked_at` 来连带撤销会话。

### 3.3 JWT claim 变更

```rust
// server/src/auth/mod.rs
pub struct AccessClaims {
    pub sub: String,         // user id
    pub dev: String,         // ⚠ 从 Option<String> 改为 String（必填）
    pub exp: i64,
    pub jti: String,
}
```

`issue_token_pair(state, user_id, device_id: &str)` —— `device_id` 必填。

## 4. 后端 (`server/src/`)

### 4.1 User-Agent 解析 (`server/src/util/ua.rs`，新文件)

最小手写 parser，零外部依赖：
- 浏览器：按优先级匹配 `Firefox/(\d+)` → `Chrome/(\d+)`（排除 Edg/OPR 前缀的特例）→ `Safari/`（无 Chrome）→ `Unknown browser`
- OS：`Windows NT 10.0` → `Windows`；`Mac OS X` → `macOS`；`iPhone`/`iPad` → `iOS`；`Android` → `Android`；`Linux` → `Linux`；其余 → `Unknown OS`
- 输出 `"{browser} {major} · {os}"`；解析失败 fallback `"Unknown browser · Unknown OS"`
- 函数签名：`pub fn parse_user_agent(ua: Option<&str>) -> String`

### 4.2 `AuthUser` 抽取器改造 (`server/src/auth/mod.rs`)

```
1. Authorization: Bearer <jwt>
2. verify_access_token → claims
3. claims.dev 为空 → 401
4. SELECT revoked_at FROM devices WHERE id = ? AND user_id = claims.sub
5. 行缺失 OR revoked_at IS NOT NULL → 401
6. AuthUser { user_id, device_id } 通过
7. 节流更新 last_seen_at（见 4.3）
```

### 4.3 `last_seen_at` 节流 (`AppState` 内)

进程内 `RwLock<HashMap<String, Instant>>`，key=device_id。extractor 流程第 7 步：
```
let now = Instant::now();
let should_update = {
  let cache = last_seen.read().await;
  cache.get(&device_id).map_or(true, |last| now.duration_since(*last) > Duration::from_secs(60))
};
if should_update {
  UPDATE devices SET last_seen_at = ? WHERE id = ?
  last_seen.write().await.insert(device_id.clone(), now);
}
```

### 4.4 login / register 流程 (`server/src/api/auth.rs`)

```
1. （已有）校验账号 / verifier
2. let device_id = Uuid::new_v4().to_string()
3. let device_name = parse_user_agent(请求头 UA)
4. INSERT INTO devices (id, user_id, name) VALUES (...)
5. issue_token_pair(state, user_id, &device_id)
6. persist refresh_tokens 行（已有），新增 bind device_id
7. AuthResponse 增加 device_id 字段
```

### 4.5 refresh 流程

旧 refresh token 解码出 `dev` → 查 `devices.revoked_at`（已吊销则 401）→ 查 `refresh_tokens.revoked_at` → UPDATE 旧行 → 签发新对，**新 refresh 行复用同一 device_id**。

### 4.6 新端点

| 方法 · 路径 | 行为 |
|-------------|------|
| `GET /api/devices` | 列出 `user_id = 当前用户` 的所有 devices 行（含已吊销，按 `created_at DESC`） |
| `DELETE /api/devices/:id` | 软吊销：`UPDATE devices SET revoked_at = now`；`UPDATE refresh_tokens SET revoked_at = now WHERE device_id = ? AND revoked_at IS NULL`。若 `:id == claims.dev` → 400（禁止自吊销）。`:id` 不是你的 → 404 |
| `POST /api/auth/logout` | 撤销当前 device 的 refresh tokens + 软吊销 devices 行（同 DELETE 逻辑，但作用对象是 token 的 dev） |

**`GET /api/devices` 响应**：
```json
{ "devices": [
  { "id": "uuid", "name": "Chrome 120 · macOS",
    "last_seen_at": "2026-06-25T10:00:00Z",
    "created_at": "2026-06-20T08:00:00Z",
    "revoked_at": null }
] }
```

### 4.7 测试 (`server/src/api/auth.rs` `#[cfg(test)]`)

| 测试名 |
|---|
| `login_creates_a_device_row_with_parsed_ua` |
| `register_also_creates_a_device_row` |
| `access_token_carries_dev_claim_matching_device_id` |
| `protected_request_401s_after_device_revoked` |
| `refresh_rejected_after_device_revoked` |
| `revoke_does_not_touch_other_devices` |
| `cannot_revoke_current_device_via_api` |
| `revoke_unknown_device_returns_404` |
| `logout_soft_revokes_device_and_refresh_token` |
| `last_seen_throttle_does_not_update_on_every_request` |
| `list_devices_returns_all_including_revoked` |
| `ua_parser_handles_unknown_agent` |

## 5. 前端 (`web/src/`)

### 5.1 IndexedDB 新增 (`web/src/crypto/keys.ts`)

```ts
const KEY_DEVICE_ID = "device_id";
persistDeviceId(userId, deviceId)
loadDeviceId(userId): Promise<string | null>
clearDeviceId()
```

`logout()` 时 `clearDeviceId()` 一并清除。

### 5.2 类型 & store

- `AuthResponse` (`web/src/api/types.ts`) 增加 `device_id: string`。
- `authStore` (`web/src/stores/auth.ts`)：
  - 增加 `const deviceId = ref<string | null>(null)`
  - `login` / `register`：收到响应后 `persistDeviceId(userId, deviceId)` + 写 ref
  - `tryRestoreSession`：`loadDeviceId` 写 ref
  - `logout`：`clearDeviceId()` + ref 置空

### 5.3 新 API 模块 (`web/src/api/devices.ts`)

```ts
devicesApi.list():   GET    /api/devices
devicesApi.revoke(): DELETE /api/devices/:id
authApi.logout():    POST   /api/auth/logout
```

### 5.4 401 处理改造 (`web/src/api/client.ts`)

`refreshAndRetry` 失败时（refresh 返回 401）：
- 调用 `useAuthStore().logout()` 清 IndexedDB（避免循环依赖：用动态 import 或在事件回调内取 store）
- 路由守卫自然 bounce 到 `/login`
- 设置一次性 flag（`revoked`）让 LoginView 显示 toast "This device was revoked"（通过 query 参数或 sessionStorage 简单实现，不引入 toast 库）

### 5.5 SettingsView 设备卡 (`web/src/views/SettingsView.vue`)

替换现有占位：
```
┌─ Devices ──────────────────────────────────┐
│ Chrome 120 · macOS                          │
│ Current device · Last seen just now         │
│                          [ Sign out ]       │  ← 当前设备：只 Sign out
├─────────────────────────────────────────────┤
│ Firefox · Windows                           │
│ Last seen 2 hours ago                       │
│                          [ Revoke ]         │  ← 其他设备
├─────────────────────────────────────────────┤
│ Safari · iOS  (greyed out)                  │
│ Revoked · 2026-06-20                        │
│                                             │  ← 已吊销：无按钮
└─────────────────────────────────────────────┘
```

- "Current device" 判定：`authStore.deviceId === device.id`
- 时间相对格式：`Intl.RelativeTimeFormat`；已吊销显示绝对时间 + "Revoked"
- 吊销 / 登出按钮：disabled + spinner；操作后重新 `devicesApi.list()`

### 5.6 恢复期 race 修复 (`web/src/App.vue`)

`<router-view v-if="!auth.isRestoring" />`，恢复期间显示极简 loading（已有 `isRestoring` ref，零额外 store 代码）。

### 5.7 前端测试 (`web/src/__tests__/`，vitest)

| 测试 |
|---|
| `authStore_persists_and_restores_device_id` |
| `client_clears_session_on_refresh_failure_due_to_revocation`（扩展现有 `client.test.ts`） |
| `SettingsView_renders_current_other_revoked_devices` |
| `SettingsView_revoke_triggers_refetch` |
| `relativeTime_formats_correctly` |

## 6. 边界条件

| 场景 | 行为 |
|------|------|
| access token 仍有效，设备被吊销 | 下一次请求 → 401 → refresh → 401 → logout + /login + toast |
| 服务器重启 | 所有 token 失效；下一次请求 401 → refresh 失败 → logout → /login（接受） |
| IndexedDB 有 device_id，DB 行被外部删 | extractor 返回 401，等同自然吊销 |
| 并发 refresh 中设备被吊销 | refresh 顺序：①验签 ②查 device.revoked_at ③查 refresh_tokens.revoked_at；任一失败即 401 |
| 浏览器清 IndexedDB 但有 refresh token | `tryRestoreSession`：`loadDeviceWrap()` null → masterKey 缺失 → 跳过 refresh 直接走 /login 重输密码 |

## 7. 验收标准（手动 QA）

1. 刷新页面：登录态保留（同一服务器进程未重启时）
2. 设备 A 登录 → 设备 B 登录 → 设备 B 上看到设备 A → 点 Revoke → 设备 A 下一次请求立即被踢到 /login，并看到 "This device was revoked" 提示
3. 自身 Sign out：清 IndexedDB + 跳 /login；再输密码可登入（创建新 device 行）
4. 服务器重启：所有设备被踢到 /login（接受的行为）
5. 已吊销设备在设备列表中灰显、无操作按钮，按 `created_at DESC` 排序

## 8. 文档同步

- `docs/api.md`：新增 `/api/devices`、`/api/auth/logout` 章节；更新 auth 响应增加 `device_id` 字段；标注 `AuthUser` 现执行 per-request 设备吊销检查。
- `docs/crypto-design.md`：删除"Wrapping variants for master_key"中关于 server-side `device_wrap` 的描述（保留 IndexedDB device_wrap 路径）；威胁模型表新增"被吊销设备"行。
- `README.md`：P4 状态从 `⏳ planned` → `✅ complete`。
