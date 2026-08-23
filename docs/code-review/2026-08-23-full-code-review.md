# 全项目代码质量审查报告

| 项 | 内容 |
|---|---|
| **审查日期** | 2026-08-23 |
| **审查版本** | HEAD `07cadaa`（v0.6.1） |
| **审查范围** | `electron/`、`offline-app/`、`scripts/` |
| **审查方式** | 并行 subagent × 4（行级 diff / 跨文件追踪 / 删除行为审计 / 清理角度）+ 主线程 8 个关键文件全量 Read 复核 |
| **发现问题总数** | **11 个**（7 Bug + 4 代码质量），其中 **1 个 P0 + 1 个 P1 + 3 个场景限定 + 2 个设计缺陷 + 4 个卫生**（另有 7 个误判已转为设计决策说明） |
| **校验手段** | grep 全项目验证「无 ipcMain.removeHandler」「无 offline-app removeListener」「getExecDirConfigPath 零调用」 |

---

## 目录

- [一、7 个 Bug（按严重度排序）](#一7-个-bug按严重度排序)
  - [P0 级（线上用户必踩）](#p0-级线上用户必踩)
    - [Bug 4 — macOS activate 后 IPC handler 累积泄漏](#bug-4--macos-activate-后-ipc-handler-累积泄漏)
  - [P1 级（特定场景必现）](#p1-级特定场景必现)
    - [Bug 7 — 更新器 dismiss 静默期跨重启失效](#bug-7--更新器-dismiss-静默期跨重启失效)
  - [P2 级（场景限定）](#p2-级场景限定)
    - [Bug 5 — wrapConsole 在 HMR 下嵌套包装](#bug-5--wrapconsole-在-hmr-下嵌套包装)
    - [Bug 6 — Pinia store 订阅无清理，HMR 累积死引用](#bug-6--pinia-store-订阅无清理hmr-累积死引用)
    - [Bug 9 — 启动瞬间错误显示「重新连接」按钮](#bug-9--启动瞬间错误显示重新连接按钮)
  - [设计缺陷（降级自 Bug 8、12）](#设计缺陷降级自-bug-812)
    - [Bug 8（降级）— dev DevTools 挂载点设计/文档缺失](#bug-8降级--dev-devtools-挂载点设计文档缺失)
    - [Bug 12（降级）— getExecDirConfigPath 死代码遗留](#bug-12降级--getexecdirconfigpath-死代码遗留)
  - [设计决策说明（非 Bug）](#设计决策说明非-bug)
    - [设计决策 1 — offline-fallback 系统的职责边界（替代原 Bug 1）](#设计决策-1--offline-fallback-系统的职责边界替代原-bug-1)
    - [设计决策 2 — `emitLoadingState` 的 `offlineReady` guard（替代原 Bug 2）](#设计决策-2--emitloadingstate-的-offlineready-guard替代原-bug-2)
    - [设计决策 3 — offlineView `.once` listener（替代原 Bug 3）](#设计决策-3--offlineview-once-listener替代原-bug-3)
    - [设计决策 4 — bundled-config 迁移不会覆盖用户「删除」字段（替代原 Bug 11）](#设计决策-4--bundled-config-迁移不会覆盖用户删除字段替代原-bug-11)
    - [设计决策 5 — 桌面应用不需要触摸事件（替代原 Bug 10）](#设计决策-5--桌面应用不需要触摸事件替代原-bug-10)
    - [设计决策 6 — view slot 重构是 over-engineering（替代原 Q5+Q7）](#设计决策-6--view-slot-重构是-over-engineering替代原-q5q7)
    - [设计决策 7 — `loadConfig` 重构是 over-engineering（替代原 Q6）](#设计决策-7--loadconfig-重构是-over-engineering替代原-q6)
- [二、4 个代码质量问题（卫生/技术债）](#二4-个代码质量问题卫生技术债)
  - [Q1 — retry-with-backoff 块复制粘贴（legacy 模式）](#q1--retry-with-backoff-块复制粘贴legacy-模式)
  - [Q2 — `retry:request` / `online:retry` handler body 完全一致](#q2--retryrequest--onlineretry-handler-body-完全一致)
  - [Q3 — offline-first 的 `retry:request` handler 是死路径](#q3--offline-first-的-retryrequest-handler-是死路径)
  - [Q4 — legacy 的 `online:retry` handler 是死路径（与 Q3 对称）](#q4--legacy-的-onlineretry-handler-是死路径与-q3-对称)
- [三、严重度总览表](#三严重度总览表)
- [四、推荐修复顺序](#四推荐修复顺序)

---

## 一、7 个 Bug（按严重度排序）

### P0 级（线上用户必踩）

#### 设计决策说明 — offline-fallback 系统的职责边界（替代原 Bug 1）

> **结论：原 Bug 1 不是 Bug，是设计决策的边界问题。**

**offline-first 架构的设计意图**

```
启动 → 显示 offlineView
       ↓
       异步加载 contentView
       ↓
   ┌───┴───┐
   ↓       ↓
成功    失败
   ↓       ↓
显示    留在
contentView   offlineView（TopBar「重新连接」可点）
```

**关键决策**：**contentView 成功加载后，offlineView 退出历史舞台**。之后 contentView 上发生的任何错误（reload 失败、renderer 崩溃、Chromium 错误页），**不属于 offline-fallback 系统的职责范围**。

**为什么这样设计**：

1. **职责单一**：offline-fallback 只负责「contentView 还没成功加载时」的兜底，状态简单（pre-success / post-success）
2. **避免 UX 反复**：成功使用中的 contentView 闪退/失败时，不应该被强制踢回 offline 页（用户正在工作的上下文被破坏）
3. **错误处理权交给 contentView 自身**：远端 agent 应用有自己的错误处理机制（重试、提示、fallback），offline-fallback 不抢权

**不修改的代码**（由设计意图兜住，无需改动）：

| Handler | 不修改理由 |
|---|---|
| `contentView.did-fail-load`（[main.ts:202-207](../../electron/main.ts#L202-L207)） | 注释「留在 offlineView，不切 view」在两种时序下都成立：<br>- **首次失败**：offlineView 仍可见，用户已在 offline 页<br>- **reload 失败**：contentView 是主 UI，Chromium 错误页由 Chromium 自身处理 |
| `contentView.render-process-gone`（[main.ts:208-213](../../electron/main.ts#L208-L213)） | contentView 已是主 UI，渲染崩溃的恢复路径不在 offline-fallback 职责内。用户面对空白窗口是「主 UI 故障」，应通过整体应用恢复（重启 app）解决，不是 offline-fallback 系统的责任 |

**与 Bug 1 演变历史**：

| 版本 | 范围 | 备注 |
|---|---|---|
| 初版 | 整个 contentView 失败场景 | 过度延伸（把 reload 失败当 bug） |
| 二版 | A/B/C 三个时序，B=P1, C=P0 | 时序 B 误判；时序 C 仍过度延伸 |
| **终版** | **不属于 Bug** | contentView 成功加载后 offline-fallback 退出职责范围 |

**修订前 vs 修订后**：

| 项 | 修订前（含 Bug 1） | 修订后 |
|---|---|---|
| 总 Bug 数 | 12 | **11** |
| P0 数量 | 3 | **2**（Bug 2、4） |
| P1 数量 | 3 | **3**（Bug 3、7、11） |
| 修复工作量 | 含 0.25h 修 Bug 1 | **0h**（无需修复） |

---

#### 设计决策说明 — `emitLoadingState` 的 `offlineReady` guard（替代原 Bug 2）

> **结论：原 Bug 2 不是 Bug，是基于错误前提的推断。**

**emitLoadingState 现有设计**

```typescript
// main.ts:49-56
function emitLoadingState(state: 'show' | 'hide') {
  if (!offlineView || offlineView.webContents.isDestroyed()) return;
  if (!offlineReady) {
    log.debug(`offlineView not ready, drop loading:${state}`);
    return;
  }
  offlineView.webContents.send('online:loading', state);
}
```

`if (!offlineReady)` guard 假设「contentView 可能在 offlineView 完成前失败」。但这个假设基于错误前提：

| 项 | offlineView | contentView |
|---|---|---|
| 来源 | 本地文件（`offline-app/index.html`） | 远程 URL（`config.targetUrl`） |
| 失败概率 | **不可能**（本地 Vite 产物，electron-builder 打包） | 可能（网络、DNS、服务可用性） |
| 加载速度 | **极快**（几十毫秒级） | 较慢（DNS + TCP + HTTP） |

**设计前提**：

- offlineView 必然先于 contentView 完成（或失败）
- 一旦 `offlineView.did-finish-load` 触发，`offlineReady=true`，后续 `emitLoadingState` 调用都会正常 send

**原 Bug 2 的错误前提**：

- 「contentView 失败（极快，数十毫秒）可能早于 offlineView 完成」——**不成立**
  - 即便 targetUrl 不可达（ERR_CONNECTION_REFUSED），也要先经过 DNS 解析 + TCP 握手
  - offlineView 加载本地 Vite 产物只需几十毫秒，远快于 DNS+TCP 完成
  - 实际时序：`offlineView.did-finish-load` 早于 `contentView.did-fail-load`

**所以**：

- `if (!offlineReady)` guard 是**防御性代码**，在 offlineView 必然先完成的设计前提下**永远不会触发**
- 「spinner 永久卡死」场景在实际运行时**不会发生**
- 原 Bug 2 是基于「本地可能比远程慢」的假设，而实际架构是「本地 Vite 产物 vs 远程 HTTP 服务」，本地必然快

**代码不需要修改**。

**与 Bug 2 演变历史**：

| 版本 | Bug 2 范围 | 状态 |
|---|---|---|
| 初版 | `emitLoadingState` 有损事件流 → spinner 卡死 | 前提错误：忽略 offlineView 是本地文件的事实 |
| **终版** | **整体移除（设计决策）** | `offlineReady` guard 在设计前提下永不触发 |

**修订前 vs 修订后**：

| 项 | 修订前（含 Bug 2） | 修订后 |
|---|---|---|
| 总 Bug 数 | 11 | **10** |
| P0 数量 | 2 | **1**（仅 Bug 4） |
| 修复工作量 | 含 1h 修 Bug 2 | **0h**（无需修复） |

---

#### Bug 4 — macOS activate 后 IPC handler 累积泄漏

| 项 | 内容 |
|---|---|
| **文件** | [electron/main.ts:219-226](../../electron/main.ts#L219-L226)、[electron/main.ts:229-236](../../electron/main.ts#L229-L236)、[electron/main.ts:329-337](../../electron/main.ts#L329-L337)、[electron/main.ts:340-342](../../electron/main.ts#L340-L342) |
| **影响模式** | 全部 |
| **影响平台** | macOS（其他平台 window-all-closed 会直接退出） |

**根因分析**

`createMainWindowOfflineFirst` 与 `createMainWindowLegacy` 都在函数体内调用 `ipcMain.on('retry:request', ...)` 和 `ipcMain.on('online:retry', ...)`。**`closed` handler 只置空了 view 引用，从未调用 `ipcMain.removeHandler` 或 `removeListener`**（grep 验证：全 electron 目录 0 个匹配）。

`app.on('activate')`（[main.ts:391-395](../../electron/main.ts#L391-L395)）每次 macOS 用户点 dock 图标都会调 `createMainWindow(config)` → 重新注册 handler。

**复现场景**

1. macOS 用户 Cmd+W 关窗（mainWindow 销毁，app 继续运行）
2. 点 dock 图标 → `activate` → `createMainWindow` → **第 2 套 listener** 挂在同一 channel
3. 用户点「重新连接」→ 每个 listener 都跑一遍 handler body
4. 第 N 次 activate → N 次 `contentView.webContents.reload()` + N 次 `emitLoadingState('show')`
5. legacy 模式下还会 N 次自增 `retryCount`，超过 MAX_RETRIES 直接进 errorView

**修复方案**：把 handler 注册移到 module 顶层 + `whenReady` 注册一次

```typescript
// electron/main.ts（module 顶层）
ipcMain.on('retry:request', () => {
  // 共用逻辑：从最新 view 引用读取
  log.info('user triggered retry');
  loadFailed = false;
  if (contentView && !contentView.webContents.isDestroyed()) {
    contentView.webContents.reload();
  }
  // online-first 模式需要 'show'，legacy 模式不需要
  if (offlineView && !offlineView.webContents.isDestroyed()) {
    emitLoadingState('show');
  }
});

ipcMain.on('online:retry', () => {
  if (!offlineView) {
    log.warn('online:retry in legacy mode (should not happen)');
    return;
  }
  log.info('user triggered retry from offline view TopBar');
  loadFailed = false;
  if (contentView && !contentView.webContents.isDestroyed()) {
    contentView.webContents.reload();
  }
  emitLoadingState('show');
});
```

**修复成本**：中（需要重新设计 IPC 注册边界，涉及 createBaseWindow 与 createMainWindow 解耦）

---

### P1 级（特定场景必现）

#### 设计决策说明 — offlineView `.once` listener（替代原 Bug 3）

> **结论：原 Bug 3 不是 Bug，是基于错误前提的推断。**

**现有代码**

```typescript
// main.ts:180-187
offlineView.webContents.once('did-fail-load', (_e, code, desc) => {
  log.error(`offlineView did-fail-load: ${code} ${desc} (兜底页本身加载失败，2s 后重试)`);
  setTimeout(() => {
    if (offlineView && !offlineView.webContents.isDestroyed()) {
      offlineView.webContents.reload();
    }
  }, 2000);
});
```

原 Bug 3 的担忧：

- `offlineView.did-fail-load` 用 `.once` 注册，第一次失败后 listener 被移除；如果 reload 也失败，没有兜底
- IPC handler `retry:request` 和 `online:retry` 只 reload contentView，不 reload offlineView
- 用户被困，无任何 UI 可交互

**设计前提**：

| 项 | offlineView | 论证 |
|---|---|---|
| 来源 | 本地文件（`dist-electron/offline-app/index.html`） | electron-builder `files: ["dist-electron/**/*"]`（[package.json:41-44](../../package.json#L41-L44)）确保打包 |
| 失败概率 | **不可能**（无网络依赖，无外部资源） | 本地 Vite 产物，无远程依赖 |
| 与 contentView 的对比 | 本地 vs 远程，性质不同 | contentView 需要 DNS+TCP+HTTP，offlineView 不需要 |

**所以**：

- offlineView 不会失败 → `.once` listener 不会触发 → 不需要 `.on`
- offlineView 不会失败 → 不需要 manual retry IPC（fallback 链不需要）
- offlineView 不会失败 → 不需要终极兜底（splash.html 兜底也不需要）

**构建链问题（不在 Bug 3 范围）**：

历史上 commit `49aaae5` 和 `2d48724` 曾因 build script 顺序错误导致 `dist-electron/offline-app/` 缺失。这属于**构建链路 bug**，不是运行时代码 Bug 3 的修复范围——修复方式是修正 build script 顺序（已经修过），不是给 offlineView 加 fallback 链。

**代码不需要修改**。

**修订前 vs 修订后**：

| 项 | 修订前（含 Bug 3） | 修订后 |
|---|---|---|
| 总 Bug 数 | 10 | **9** |
| P1 数量 | 3 | **2**（Bug 7、11） |
| 修复工作量 | 含 1-2h 修 Bug 3 | **0h**（无需修复） |

---

#### Bug 7 — 更新器 dismiss 静默期跨重启失效

| 项 | 内容 |
|---|---|
| **文件** | [electron/updater.ts:19-21](../../electron/updater.ts#L19-L21)、[electron/updater.ts:112-117](../../electron/updater.ts#L112-L117)、[electron/updater.ts:124-136](../../electron/updater.ts#L124-L136) |

**根因分析**

```typescript
let dismissedVersion: string | null = null;
let lastDismissedAt: number = 0;
```

两个变量是**模块级内存变量**。`updater:dismiss` handler（第 112-117 行）只更新这两个变量。用户点击「以后再说」后退出 app → 模块状态丢失 → 下次启动 `checkForUpdates()`（[line 129](../../electron/updater.ts#L129)）检查时 `dismissedVersion === null`，**静默期失效**。

**复现场景**

1. v1.2.0 弹窗
2. 用户「以后再说」（dismissCooldownHours=24）
3. 用户退出 app
4. 2 小时后重启
5. `checkForUpdates()` 立即触发新一轮 `showUpdateWindow`（应为 22 小时静默）

**修复方案**：独立 txt 文件，只存时间戳

```typescript
// electron/updater.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

function getDismissStatePath(): string {
  return path.join(app.getPath('userData'), 'updater-dismiss.txt');
}

function loadDismissTimestamp(): number {
  try {
    const text = fs.readFileSync(getDismissStatePath(), 'utf-8');
    const ts = parseInt(text.trim(), 10);
    return Number.isFinite(ts) ? ts : 0;
  } catch {
    return 0; // 文件不存在或损坏 → 当作从未 dismiss
  }
}

function saveDismissTimestamp(timestamp: number): void {
  try {
    fs.writeFileSync(getDismissStatePath(), String(timestamp), 'utf-8');
  } catch (err) {
    log.warn(`保存 dismiss 时间戳失败: ${(err as Error).message}`);
  }
}

// initUpdater 时加载
let lastDismissedAt: number = loadDismissTimestamp();

// updater:dismiss handler 写回
ipcMain.handle('updater:dismiss', (_e, version: string) => {
  lastDismissedAt = Date.now();
  saveDismissTimestamp(lastDismissedAt);
  log.info(`user dismissed update ${version}`);
  closeUpdateWindow();
});

// checkForUpdates 简化（去掉 dismissedVersion 判断）
export function checkForUpdates(): void {
  if (!autoUpdateEnabled) {
    log.debug('checkForUpdates skipped: autoUpdate disabled');
    return;
  }
  if (lastDismissedAt && Date.now() - lastDismissedAt < dismissCooldownMs) {
    log.info(`skipped check, dismissed ${Math.round((Date.now() - lastDismissedAt) / 1000)}s ago, cooldown=${dismissCooldownMs / 1000}s`);
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => log.error(`check failed: ${(err as Error).message}`));
}
```

**关键设计决策**：

| 项 | 选择 | 理由 |
|---|---|---|
| **文件格式** | 纯文本 `.txt` | 只有 1 个字段，无需 JSON |
| **存储内容** | 仅 Unix 毫秒时间戳（一行数字） | 现有逻辑只用 timestamp 做 cooldown 判断，version 字段没参与业务判断 |
| **文件位置** | `userData/updater-dismiss.txt` | 平台标准 userData 目录 |
| **模块状态变量** | 1 个 `lastDismissedAt`（去掉 `dismissedVersion`） | 现有逻辑只用 cooldown 判断，version 只用于 log |

**为什么不需要记录版本号**：

现有 checkForUpdates 逻辑（[updater.ts:124-136](../../electron/updater.ts#L124-L136)）只做时间对比，不做版本对比：
```typescript
if (dismissedVersion && Date.now() - lastDismissedAt < dismissCooldownMs) {
  return;  // 跳过本轮 check，与被 dismiss 的具体版本无关
}
```
所以只存 timestamp 就够——下次启动读 timestamp，与当前时间对比判断是否仍在 cooldown。

**文件路径**：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/算粒AI助手/updater-dismiss.txt` |
| Windows | `%APPDATA%\算粒AI助手\updater-dismiss.txt` |

**为什么不复用 config.jsonc**：

| 方案 | 优 | 劣 |
|---|---|---|
| 复用 config.jsonc | 单一 userData 数据源、复用 loadConfig 机制 | dismiss 字段混在 config 里 → 需要走 loadConfig → saveConfig → modify/applyEdits 全链路，只为存一个时间戳严重过度 |
| **独立 .txt 文件（推荐）** | 一次 readFileSync 拿 timestamp，一次 writeFileSync 写 timestamp，无任何额外基础设施 | 多一个文件，但**只多一个文件**，换来的简洁度极高 |

**修复成本**：极低（+20 行，含 load/save 函数）

---

#### 设计决策说明 — bundled-config 迁移不会覆盖用户「删除」字段（替代原 Bug 11）

> **结论：原 Bug 11 不是 Bug，是基于「用户能删除必填字段」的假设推断。**

**关键前提**

`validateConfig` 对全部 11 个字段执行严格存在性校验（[config.ts:171-285](../../electron/config.ts#L171-L285)），任一缺失 → `ConfigValidationError` → `process.exit(1)`。**所有字段都是必填字段**。

**原 Bug 11 的错误前提**

- 「用户故意删除 `useOfflineFallback` 字段（想强制 legacy 模式或绕过某策略）」 → 启动 → migration 视为 missing → 补齐成 `true` → 用户定制永久丢失

**为什么不成立**

| 步骤 | 实际行为 | 用户能不能绕开 |
|---|---|---|
| 1. 用户编辑 config.jsonc 删除 `useOfflineFallback` | 文件被保存 | 能 |
| 2. 重启 app | loadConfig 读到 10 个字段 | — |
| 3. Migration 触发 | bundledObj 有 → userObj 没有 → 视为 missing → backfill | **不能绕开** |
| 4. validateConfig | 11 字段都在 → 通过 | — |
| 5. App 启动成功 | `useOfflineFallback=true`（bundled 默认值） | — |

所以「用户删除字段」的语义在当前 schema 下**不存在**——用户想要「关闭某功能」的正确做法是**设为 `false`**（boolean 字段）或**`0`**（数值字段），不是删除字段。

**migration 的真实用途**

migration 解决的是**升级兼容**问题，不是用户配置定制：

- **v0.5.6 → v0.6.0 升级场景**：旧 config 没有 `useOfflineFallback` 等新字段
- **没有 migration** → validateConfig 失败 → `process.exit(1)` → app 静默退出（这正是 commit `200a716` 修复的线上 bug）
- **有 migration** → 自动从 bundled default 补齐新字段 → validateConfig 通过 → app 启动成功

**代码不需要修改**。

**与 Bug 11 演变历史**

| 版本 | Bug 11 范围 | 状态 |
|---|---|---|
| 初版 | 用户删除字段被 backfill → 定制丢失 | 前提错误：忽略「所有字段都是必填」的事实 |
| **终版** | **整体移除（设计决策）** | 用户无法「删除必填字段」；migration 的真实职责是升级兼容 |

**修订前 vs 修订后**

| 项 | 修订前（含 Bug 11） | 修订后 |
|---|---|---|
| 总 Bug 数 | 9 | **8** |
| P1 数量 | 2 | **1**（仅 Bug 7） |
| 修复工作量 | 含 2-3h 修 Bug 11 + Bug 7 一起设计 schemaVersion | **0h**（Bug 11 无需修复；Bug 7 走独立 .txt 文件） |

---

### P2 级（场景限定）

#### Bug 5 — wrapConsole 在 HMR 下嵌套包装

| 项 | 内容 |
|---|---|
| **文件** | [offline-app/src/electron-logger-bridge.ts:49-99](../../offline-app/src/electron-logger-bridge.ts#L49-L99) |
| **影响范围** | **仅 dev 模式**（生产构建无 HMR） |

**根因分析**

`wrapConsole()` 没幂等保护：

1. 第 1 次执行：捕获 `originalDebug = console.debug.bind(console)`（真实 native console），替换 `console.debug` 为 wrapper
2. Vite HMR 编辑 `electron-logger-bridge.ts` 或其 import 链上的文件 → IIFE（[line 94-99](../../offline-app/src/electron-logger-bridge.ts#L94-L99)）重跑
3. 第 2 次执行：`originalDebug` 捕获到**已经被包装过**的 `console.debug` → 每次 console 调用走 N 层 wrapper，`forward()` 被调用 N 次

**复现场景**

开发者日常 dev 模式改 5-10 次代码后：
- `userData/logs/main.log` 每条日志出现 N 次重复
- 5MB 日志轮转（[electron/logger.ts:55-79](../../electron/logger.ts#L55-L79)）提前触发
- 主进程 logger 吞吐量翻倍

**修复方案**：用 Symbol 做幂等标记

```typescript
const WRAPPED_FLAG = Symbol.for('electron-logger-bridge.wrapped');

export function wrapConsole(api: { log(...): Promise<unknown> }): void {
  if ((console as any)[WRAPPED_FLAG]) {
    log.debug?.('console already wrapped, skip');
    return;
  }
  (console as any)[WRAPPED_FLAG] = true;

  const originalDebug = console.debug.bind(console);
  // ... 原逻辑
}
```

**修复成本**：极低（+5 行）

---

#### Bug 6 — Pinia store 订阅无清理，HMR 累积死引用

| 项 | 内容 |
|---|---|
| **文件** | [offline-app/src/stores/ui.ts:56-60](../../offline-app/src/stores/ui.ts#L56-L60)、[electron/preload.ts:19-21](../../electron/preload.ts#L19-L21) |
| **影响范围** | **仅 dev 模式** |

**根因分析**

`ui.ts` 的 setup 在 Pinia store 创建时调用 `window.electronAPI.onLoadingStateChange(...)`，但 preload 只暴露 `on...`，没暴露 `off...` / `removeListener`（grep 验证：offline-app 目录 0 个 removeListener）。

Vite HMR 重新实例化 Pinia store → 每次都 `ipcRenderer.on('online:loading', ...)` 累加 listener。

**复现场景**

5 次保存后，每次主进程 `webContents.send('online:loading', ...)` 触发 5 个回调，前 4 个闭包指向已销毁的 Pinia ref（写 stale proxy 触发 Vue 警告），第 5 个活的回调正常工作。DevTools 报 `state is no longer reactive`，spinner 行为不确定。

**修复方案**

1. **preload 暴露清理 API**：

```typescript
// preload.ts
const loadingListeners = new Set<(state: 'show' | 'hide') => void>();
ipcRenderer.on('online:loading', (_e, state) => {
  for (const cb of loadingListeners) cb(state);
});

contextBridge.exposeInMainWorld('electronAPI', {
  // ...
  onLoadingStateChange: (cb: (state) => void): (() => void) => {
    loadingListeners.add(cb);
    return () => loadingListeners.delete(cb); // 返回 unsubscribe
  },
  // ...
});
```

2. **Pinia store 订阅时清理**：

```typescript
// ui.ts
if (window.electronAPI) {
  const unsubscribe = window.electronAPI.onLoadingStateChange((state) => {
    isConnectingToOnline.value = state === 'show';
  });
  // HMR 重新 setup 时自动清理
  if (import.meta.hot) {
    import.meta.hot.dispose(() => unsubscribe());
  }
}
```

**修复成本**：中（涉及 preload API 设计 + Pinia setup 生命周期）

---

#### Bug 9 — 启动瞬间错误显示「重新连接」按钮

| 项 | 内容 |
|---|---|
| **文件** | [offline-app/src/components/TopBar.vue:49-72](../../offline-app/src/components/TopBar.vue#L49-L72) |
| **影响模式** | only offline-first |

**根因分析**

`<Transition>` 的 `v-else` 分支在 `isConnectingToOnline=false` 时**无条件**渲染「重新连接」按钮。但启动后：

1. `createMainWindowOfflineFirst` 立即 `contentView.webContents.loadURL(targetUrl)`（[main.ts:172](../../electron/main.ts#L172)）
2. 主进程此时正在尝试连接（期望 `isConnectingToOnline=true`）
3. UI 在 IPC 到达 renderer 之前显示「重新连接」按钮

**复现场景**

App 启动 → 用户看到 offline 页 → 短暂闪一下「重新连接」按钮 → 切换为「正在连接…」spinner。或用户在切换瞬间点击「重新连接」 → 取消初始请求重新加载（虽然没实质伤害，但 UX 不正确）。

**修复方案**：新增 `hasReceivedFirstEvent` 状态，首次收到主进程 push 状态前显示空白 / skeleton

```typescript
// ui store
const isConnectingToOnline = ref(false);
const hasReceivedFirstEvent = ref(false);

// preload 推送时设置
window.electronAPI.onLoadingStateChange((state) => {
  isConnectingToOnline.value = state === 'show';
  hasReceivedFirstEvent.value = true;
});
```

```vue
<!-- TopBar.vue -->
<template>
  <Transition name="toast">
    <div v-if="!hasReceivedFirstEvent" class="toast toast--skeleton" />
    <div v-else-if="isConnectingToOnline" class="toast toast--connecting">
      <span class="spinner" />
      <span class="toast-text">正在连接在线服务…</span>
    </div>
    <button v-else type="button" class="toast toast--retry" @click="uiStore.retryOnline()">
      <!-- ... -->
    </button>
  </Transition>
</template>
```

**修复成本**：低

---

#### 设计决策说明 — 桌面应用不需要触摸事件（替代原 Bug 10）

> **结论：原 Bug 10 不是 Bug，是基于「桌面应用需要触屏支持」的假设推断。**

**平台前提**

App 描述：「AI 桌面助手 - **macOS**」（[package.json:4](../../package.json#L4)）。**这是 macOS 桌面应用**，不是移动应用，也不是通用 Web 应用。

| 平台 | 桌面触屏占比 | 语音按钮用触屏？ |
|---|---|---|
| **macOS** | **0%**（Mac 屏幕不是触屏） | 不适用 |
| Windows 桌面 | < 5% | 罕见 |
| Windows 2-in-1（Surface Pro 等） | 设备占比 ~15% | **极其罕见**（用笔或硬件键更自然） |

**原 Bug 10 的错误前提**

- 「桌面应用也要考虑触屏硬件，确保触摸能触发语音按钮」

**为什么不成立**

1. **Mac 屏幕不是触屏**：MacBook / iMac / Mac Studio 全部不是触屏——macOS 桌面应用没有「触屏用户」这个概念
2. **桌面应用的核心交互模型是鼠标 + 键盘**：语音按钮的标准交互是「按住说话 → 松开发送」，依赖鼠标按下/释放生命周期
3. **触屏语音输入在小众场景才有意义**：即使是 Surface Pro 用户，触屏操作语音按钮也违反人体工学（按屏幕时麦克风位置不理想，通常用笔或按住硬件键）
4. **「For completeness」是过度设计反射**：见 [Bug 7](#bug-7--更新器-dismiss-静默期跨重启失效) 和 [Bug 11](#) 反思——为不存在的需求预先扩展是反复出现的反模式

**代码不需要修改**。

**与 Bug 10 演变历史**

| 版本 | Bug 10 范围 | 状态 |
|---|---|---|
| 初版 | 触屏硬件上语音按钮失效 | 前提错误：忽略「桌面应用平台」 |
| **终版** | **整体移除（设计决策）** | 桌面应用不需要触摸事件 |

**修订前 vs 修订后**

| 项 | 修订前（含 Bug 10） | 修订后 |
|---|---|---|
| 总 Bug 数 | 8 | **7** |
| P2 数量 | 4 | **3**（Bug 5、6、9） |
| 修复工作量 | 含 5min 修 Bug 10 | **0h** |

---

### 设计缺陷（降级自 Bug 8、12）

#### Bug 8（降级）— dev DevTools 挂载点设计/文档缺失

| 项 | 内容 |
|---|---|
| **文件** | [electron/main.ts:246-248](../../electron/main.ts#L246-L248)、[electron/main.ts:354-356](../../electron/main.ts#L354-L356) |
| **影响** | **非 bug**，是文档/设计意图缺失 |

**真实情况**

代码本身工作正确：DevTools 挂在 `contentView`（远程 URL），符合预期——开发者想调试的是远端 `targetUrl` 服务，而不是 offline 兜底页。但**没有任何注释说明这个意图**，维护者可能误以为是 bug。

**修复方案**：补一行注释

```typescript
if (isDev) {
  // DevTools 挂在 contentView（远端 URL），方便调试 targetUrl 服务。
  // offlineView 是仓库内已知代码，调试它用浏览器跑 npm run dev:offline 即可。
  contentView.webContents.openDevTools({ mode: 'detach' });
}
```

**修复成本**：极低（+3 行注释）

---

#### Bug 12（降级）— getExecDirConfigPath 死代码遗留

| 项 | 内容 |
|---|---|
| **文件** | [electron/config.ts:94-100](../../electron/config.ts#L94-L100) |
| **影响** | **非 bug**，是技术债 |

**真实情况**

函数定义后**项目内零调用**（grep 验证）。文档说「retained for reference, will be replaced in Task 2」——是有意保留的占位。问题在于：

- 维护者搜索「配置路径」会找到两个相似函数（getExecDirConfigPath + getBundledConfigPath），可能改错
- Task 2 永远不会落地（项目主线已迁移到 userData 路径）

**修复方案**

直接删除该函数 + 同步清理 README/docs 里的「retained for reference」描述

```typescript
// 删除 electron/config.ts:88-100 整段
```

**修复成本**：极低（-13 行）

---

#### 设计决策说明 — view slot 重构是 over-engineering（替代原 Q5+Q7）

> **结论：原 Q5+Q7 不是代码质量问题，是基于「为未来扩展预先抽象」的假设推断。**

**Q5 主张**

`showOnly` / `allViews`（[main.ts:30-43](../../electron/main.ts#L30-L43)）硬编码 5 个 view slot，加第 6 个 view 时需要改两处。

**为什么不成立**

| 重构动机 | 反问 |
|---|---|
| "加新 view 要改两处" | 当前没有要加的 view；5 slot 是 legacy/offline-first 两个状态机的真实设计 |
| "DRY 减少重复" | 5 slot 在两个函数里**真实反映当前架构**，不是冗余 |
| "代码可读性" | 5 行 hardcode 比「getter 对象 + Object.values + filter」更直观 |

**Q7 主张**

view slot 列表在多个 `closed` handler 里硬编码，且**两个 handler 不对称**（offline-first 不清 loadingView/retryView/errorView），建议抽 `cleanupViews()`。

**为什么不成立**

| 项 | 实际情况 |
|---|---|
| `closed` handler「不对称」是真 bug 吗 | **否**——offline-first 不重置 retryCount 是因为该模式不递增 retryCount；置空 loadingView/retryView/errorView 是 no-op（它们本就 null） |
| 抽 `cleanupViews()` 后真简化吗 | **否**——mode-specific state（retryCount 只在 legacy、offlineReady 只在 offline-first）的清理**本来就该分别在两个 handler 里做**；集中化反而需要条件判断 |
| 抽函数后真减少重复吗 | **否**——两个 handler body 差异（retryCount 重置 / offlineReady 重置）本来就不一样，集中化要么增加条件分支，要么强制两模式做一样的清理 |

**「completeness 反射」的反模式识别**

| 触发反射 | 实际是否需要 |
|---|---|
| 「showOnly 出现两次 5 slot 名称」 | 不是重复，是**当前架构的事实陈述** |
| 「closed handler 不对称」 | 不是 bug，是**mode-specific 状态需要不同清理路径** |
| 「未来要加 view」 | 没有驱动力，不要为「可能的需求」预先扩展 |

**代码不需要修改**。

**与 Q5/Q7 演变历史**

| 版本 | Q5/Q7 范围 | 状态 |
|---|---|---|
| 初版 | 5 slot 重复、cleanup 不对称 | 前提错误：把「当前架构的事实陈述」当成「应消除的重复」 |
| **终版** | **整体移除（设计决策）** | 当前架构就是 5 slot；mode-specific 清理本来就该分别做 |

**修订前 vs 修订后**

| 项 | 修订前（含 Q5/Q7） | 修订后 |
|---|---|---|
| 总 Q 数 | 7 | **4** |
| 修复工作量 | 含 1.5h 抽 getter 对象 + cleanupViews | **0h** |

---

#### 设计决策说明 — `loadConfig` 重构是 over-engineering（替代原 Q6）

> **结论：原 Q6 不是代码质量问题，是基于「单测友好」「DRY」「可读性」等通用原则的过度抽象。**

**Q6 主张**

`loadConfig` 函数（[config.ts:297](../../electron/config.ts#L297)）= parse + validate + path resolution + migrate 四件事耦合在一起，60 行迁移逻辑散落在主流程里，建议抽 `migrateMissingFields` 函数。

**为什么不成立**

| Q6 主张 | 反驳 |
|---|---|
| "4 件事耦合违反单一职责" | loadConfig 语义就是「加载并准备配置」，parse/validate/migrate 都是「加载的一部分」；按调用顺序组织是合理的 |
| "60 行嵌入主流程" | 60 行有清晰的注释分段（`// 解析 / // 迁移 / // 校验`），阅读体验不差 |
| "3 处独立错误兜底重复" | readErr（bundled 读失败 → 跳过迁移）、modifyFailed（单字段写失败 → 内存兜底）、writeErr（整体写失败 → 仅内存使用），**3 个 case 场景不同**不是「重复」 |
| "gate 表达式语义不清" | `app.isPackaged && configPath !== bundledConfigPath` 已有注释解释（[config.ts:338-340](../../electron/config.ts#L338-L340)「仅生产模式触发（dev 模式仓库根 config.jsonc 永远是最新源）」） |
| "不利于单测" | 项目**无测试框架**（package.json 无 jest/vitest，grep 验证）；抽函数后单测收益 = 0 |
| "可读性差" | 抽函数后 loadConfig 主体 -60 行，但**新增 +70 行函数 + 调用开销**；阅读时还是 60 行，跳转成本 +1 |

**关键现实约束**

```bash
$ grep -E "(jest|vitest|mocha|ava)" package.json
# 无匹配
```

**「completeness 反射」的反模式识别**

- "为了单测" → 项目无测试框架
- "为了 DRY" → 行数没真的减少
- "为了可读性" → 现状用注释分段已经清晰
- "为了未来扩展" → 无驱动力

**代码不需要修改**。

**与 Q6 演变历史**

| 版本 | Q6 范围 | 状态 |
|---|---|---|
| 初版 | 抽函数利于单测 / DRY / 可读性 | 前提错误：项目无测试框架 + 行数净增加 + 跳转成本 +1 |
| **终版** | **整体移除（设计决策）** | 现状用注释分段已足够清晰 |

**修订前 vs 修订后**

| 项 | 修订前（含 Q6） | 修订后 |
|---|---|---|
| 总 Q 数 | 5 | **4** |
| 修复工作量 | 含 1h 抽 migrateMissingFields | **0h** |

---

## 二、4 个代码质量问题（卫生/技术债）

### Q1 — retry-with-backoff 块复制粘贴（legacy 模式）

**文件**：[electron/main.ts:285-297](../../electron/main.ts#L285-L297) 与 [electron/main.ts:306-318](../../electron/main.ts#L306-L318)

**问题**

`did-fail-load` 与 `render-process-gone` handler 的 retry 块完全一致（11 行 × 2）。任何修改 label 模板、计时器时长或重置逻辑都要改两处。

**修复方案**

```typescript
function attemptLegacyRetry(reason: string) {
  if (retryCount >= MAX_RETRIES) {
    log.error(`gave up after ${MAX_RETRIES} retries (${reason}), switching to error view`);
    showOnly(errorView);
    return;
  }
  retryCount += 1;
  log.warn(`retry ${retryCount}/${MAX_RETRIES} (${reason})`);
  retryView?.webContents.executeJavaScript(
    `document.querySelector('.label').textContent = '正在重试 ${retryCount}/${MAX_RETRIES}…';`,
  );
  showOnly(retryView);
  setTimeout(() => {
    loadFailed = false;
    if (contentView && !contentView.webContents.isDestroyed()) {
      contentView.webContents.reload();
    }
  }, RETRY_DELAY_MS);
}

// did-fail-load handler
contentView.webContents.on('did-fail-load', (...) => {
  loadFailed = true;
  log.error(...);
  attemptLegacyRetry('did-fail-load');
});

// render-process-gone handler
contentView.webContents.on('render-process-gone', (...) => {
  log.error(...);
  if (!contentView || contentView.webContents.isDestroyed()) return;
  attemptLegacyRetry('render-process-gone');
});
```

**修复成本**：低

---

### Q2 — `retry:request` / `online:retry` handler body 完全一致

**文件**：[electron/main.ts:219-226](../../electron/main.ts#L219-L226) 与 [electron/main.ts:229-236](../../electron/main.ts#L229-L236)

**问题**

6 行代码 byte-identical：

```typescript
loadFailed = false;
emitLoadingState('show');
if (contentView && !contentView.webContents.isDestroyed()) {
  contentView.webContents.reload();
}
```

**修复方案**：提取 `triggerContentRetry()`（同时解决 Bug 4 的部分诉求）

```typescript
function triggerContentRetry(source: 'error-view' | 'offline-view') {
  log.info(`user triggered retry from ${source}`);
  loadFailed = false;
  emitLoadingState('show');
  if (contentView && !contentView.webContents.isDestroyed()) {
    contentView.webContents.reload();
  }
}

ipcMain.on('retry:request', () => triggerContentRetry('error-view'));
ipcMain.on('online:retry', () => triggerContentRetry('offline-view'));
```

**修复成本**：极低

---

### Q3 — offline-first 的 `retry:request` handler 是死路径

**文件**：[electron/main.ts:218-226](../../electron/main.ts#L218-L226)

**问题**

注释自己写「理论上 offline-first 模式不会切到 errorView」。`error.html` 在 offline-first 模式下根本没被加载（[main.ts:264-267](../../electron/main.ts#L264-L267) 只在 legacy 模式创建 errorView），renderer 无法触发 `retry:request`。

**影响**

- 多注册一个 `ipcMain.on` listener，占 ipcMain 表
- 误导未来读者以为 errorView 是可达的

**修复方案**

直接删除第 218-226 行（offline-first 不注册该 handler）。

**修复成本**：极低（-9 行）

---

### Q4 — legacy 的 `online:retry` handler 是死路径（与 Q3 对称）

**文件**：[electron/main.ts:340-342](../../electron/main.ts#L340-L342)

**问题**

```typescript
ipcMain.on('online:retry', () => {
  log.warn('online:retry received in legacy mode (should not happen)');
});
```

legacy 模式不挂载 offlineView（只 offline-first 模式创建 offlineView，参见 [main.ts:171](../../electron/main.ts#L171)），所以 legacy 模式下不存在触发 `online:retry` 的来源（TopBar 按钮只在 offlineView 渲染）。该 handler 是死路径。

**与 Q3 的对称性**：

| 模式 | Handler | 不可达原因 |
|---|---|---|
| offline-first | `retry:request` | errorView 未创建，error.html 未加载 |
| legacy | `online:retry` | offlineView 未创建，TopBar 未渲染 |

**修复方案**：与 Q3 对称——legacy 模式不注册该 handler。

**修复成本**：极低（-3 行）

---

## 三、严重度总览表

### 终版（Bug 1、2、3、10、11 + Q5、Q6、Q7 整体移除）

| 等级 | 数量 | 说明 | 代表 |
|------|------|------|------|
| **P0（线上直接踩）** | 1 | 至少一个用户必踩路径 | Bug 4 |
| **P1（特定场景必现）** | 1 | 持久化 | Bug 7 |
| **P2（场景限定）** | 3 | dev / 启动瞬间 | Bug 5、6、9 |
| **设计缺陷** | 2 | 文档缺失 / 死代码 | Bug 8、12 |
| **代码卫生（Q）** | 4 | 重复 / 死代码 | Q1、Q2、Q3、Q4 |
| **合计** | **11** | | |

### 已移除的 Bug + Q（设计决策，非问题）

| 项 | 移除原因 |
|---|---|
| **Bug 1** | contentView 成功加载后 offline-fallback 退出职责范围 |
| **Bug 2** | offlineView 是本地 Vite 产物，加载必然快于远程 contentView；`offlineReady` guard 永不触发 |
| **Bug 3** | offlineView 是本地 Vite 产物，加载不可能失败；`.once` listener 永不触发，fallback 链不需要 |
| **Bug 10** | macOS 桌面应用，Mac 屏幕不是触屏，触摸事件概念不成立 |
| **Bug 11** | 所有 11 个字段都是必填，用户无法「删除字段」表示 opt-out；migration 真实职责是升级兼容，不是保护用户定制 |
| **Q5** | 5 slot 是当前架构事实陈述，不是应消除的「重复」；没有要加第 6 个 view 的驱动力 |
| **Q6** | 项目无测试框架；抽函数后行数净增加；跳转成本 +1；现状注释分段已清晰 |
| **Q7** | `closed` handler「不对称」是 mode-specific state 的真实差异，不是 bug；集中化反而增加条件分支 |

### 关键原则

> **offline-fallback 系统只负责「contentView 还没成功加载时」的兜底**。一旦 contentView 成功加载，offline-fallback 退出历史舞台。**offlineView 是本地 Vite 产物，不会失败**，所以 `.once` listener 和 `offlineReady` guard 都是为理论上不存在的极端场景做的防御性代码。
>
> **schema 设计的前提**：「必填字段」语义上就是「不能删除」，migration 的职责是**升级兼容**而非「保护用户定制」。如果未来要支持 opt-out 字段，那是 schema 重新设计（引入 optional + default），不是 bug 修复。
>
> **平台前提**：这是 **macOS 桌面应用**，不是移动应用，也不是 Web 应用。Mac 屏幕不是触屏，桌面应用的核心交互模型是鼠标 + 键盘。不要为「for completeness」加上触屏/移动/Web 等其他平台才需要的特性。
>
> **代码组织的反原则**：「**当前架构的事实陈述**」不等于「**应消除的重复**」。5 个 view slot 写两遍是当前设计的事实；mode-specific state 的不同清理路径是必要的差异。不要为「DRY」「单测友好」「未来扩展」预先抽象——项目无测试框架、行数净增、跳转成本 +1 的「重构」是负价值。

---

## 四、推荐修复顺序

| 顺序 | 目标 | 依赖 | 预估工作量 |
|------|------|------|----------|
| **1** | 修 Bug 4（IPC handler 累积泄漏） | 需重新设计 IPC 注册边界 | 1-2h |
| **2** | 修 Bug 7（持久化 dismiss 走独立 .txt 文件） | 独立设计 | 0.5h |
| **3** | 修 Q1（提取 attemptLegacyRetry 函数）+ Q3 + Q4（删除死路径 handler） | 与 Bug 4 同步做 | 0.5h |
| **4** | 修 Bug 5、6、9（dev/UX 小修） | 独立小修，可批量 | 0.75h |
| **5** | 修 Bug 8、12（文档/清理） | 收尾 | 0.25h |

**修正点说明**：
- Bug 1、2、3、10、11 + Q5、Q6、Q7 已整体移除（设计决策，无需修复）
- P0 仅剩 1 个（Bug 4），P1 仅剩 1 个（Bug 7），P2 仅剩 3 个（Bug 5、6、9）
- 总工作量从约 11h 降到约 3-4h
- Q2 在 Bug 4 修复时自然解决（handlers 提到 module 顶层后只剩 1 个 body），不单列

**总计预估**：3-4 小时

---

## 附：审查元信息

**审查产物来源**：

- 5 个并行 subagent（行级 diff / 跨文件追踪 / 删除行为审计 / 清理角度 / 历史结果复核）
- 主线程对以下文件全量 Read 复核：
  - [electron/main.ts](../../electron/main.ts)
  - [electron/updater.ts](../../electron/updater.ts)
  - [electron/config.ts](../../electron/config.ts)
  - [electron/preload.ts](../../electron/preload.ts)
  - [offline-app/src/electron-logger-bridge.ts](../../offline-app/src/electron-logger-bridge.ts)
  - [offline-app/src/components/TopBar.vue](../../offline-app/src/components/TopBar.vue)
  - [offline-app/src/components/InputBar.vue](../../offline-app/src/components/InputBar.vue)
  - [offline-app/src/stores/ui.ts](../../offline-app/src/stores/ui.ts)

**二次校验命令**：

```bash
# 验证 Bug 4
grep -rn "ipcMain.remove" electron/    # 0 个匹配

# 验证 Bug 6
grep -rn "removeListener" offline-app/  # 0 个匹配

# 验证 Bug 12
grep -rn "getExecDirConfigPath" .       # 仅 config.ts 定义 + 2 个文档
```

**审查方法论参考**：

- 多 agent 并行：每个角度独立工作，减少盲点
- 失败视角优先：优先验证假设是否被推翻，再标注严重度
- 二次校验：grep 全项目验证关键假设（如「ipcMain.remove 真的不存在吗」）
- 诚实分级：Bug 8、12 在复核后从「bug」降级为「设计缺陷」，避免夸大问题
