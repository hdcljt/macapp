# Electron 单窗口 + WebContentsView 状态视图 — 设计文档

日期：2026-08-20
主题：在已有 `electron-loadurl-wrapper` 基础上，将 splash 独立 BrowserWindow 方案替换为「单 BrowserWindow + 多 WebContentsView」的混合架构，使加载态、重试态、错误态的 UI 全部位于主窗口内。

## 背景

[上一次设计](2026-08-19-electron-loadurl-wrapper-design.md)（已实施）使用 splash 独立 BrowserWindow + mainWindow 的双窗口架构，存在三个体验问题：

1. **UI 不在主窗口内**：splash 与 mainWindow 是两个独立窗口，视觉上用户看到「窗口切换」而非「内容切换」。
2. **重试阶段反馈弱**：splash 在重试期间已经显示，但缺少重试次数计数，用户感知不到「正在重试 N/3」。
3. **错误页按钮的 CSP 风险**：当前 error.html 用 inline script 触发「重试」，曾因 file:// opaque origin 触发 CSP 阻断（commit 1e915de 已修但被回退）。

本次改造用三个独立 WebContentsView（loading / retry / error）作为主窗口 contentView 的子视图，按需切换可见性，把所有状态 UI 收纳到主窗口内。

## 目标

1. 应用启动后默认 webContents 加载 `http://localhost:5195/agent-user/assistant`，加载过程中由 loadingView 覆盖。
2. 加载失败时 retryView 显示重试计数（`正在重试 1/3…`），retry 完成后再次覆盖。
3. 重试 3 次仍失败时 errorView 显示错误页与「重试」按钮。
4. 所有状态 UI 收纳在主窗口内（无第二个 BrowserWindow）。
5. 错误页「重试」通过 preload + IPC 实现，不再依赖 inline script，从根本避免 CSP 风险。

## 设计

### 1. 架构

```
┌────────────────────────────────────────────────────────────┐
│              BrowserWindow (mainWindow)                     │
│              width 1180, height 820                         │
│              webPreferences.preload + sandbox: false         │
│                                                            │
│  contentView                                               │
│   ├── loadingView (splash.html)                ← 初始加载   │
│   ├── retryView  (retry.html)                  ← 重试中     │
│   ├── errorView  (error.html)                  ← 终态       │
│   └── contentView (WebContentsView)            ← URL 内容   │
│       loadURL TARGET_URL, sandbox: false                    │
└────────────────────────────────────────────────────────────┘
```

视图与 contentView 的关系：

- 4 个 View 依次 `addChildView`，后加的在上层
- 同一时刻仅一个 View 可见
- 视图切换通过 `setVisible(true/false)` 完成，无 URL 重新加载
- **URL 内容用专用 WebContentsView（contentView）而非默认 webContents**：默认 webContents 在 URL 加载失败时会显示 ERR 页面穿透到背景，必须用专用 View + `loadFailed` 标志（详见 § A. 关键实现细节）才能精确控制可见性

### 2. 状态机

| 状态 | loadingView | retryView | errorView | contentView |
|------|-------------|-----------|-----------|-------------|
| 启动（初始加载） | ✅ 可见 | ❌ | ❌ | 加载中（被覆盖） |
| 加载成功 | ❌ | ❌ | ❌ | ✅ 可见 |
| 首次失败（1/3） | ❌ | ✅ 显示 `正在重试 1/3…` | ❌ | 5s 后重载 |
| 二次失败（2/3） | ❌ | ✅ 显示 `正在重试 2/3…` | ❌ | 5s 后重载 |
| 三次失败（3/3） | ❌ | ✅ 显示 `正在重试 3/3…` | ❌ | 5s 后重载 |
| 重试耗尽 | ❌ | ❌ | ✅ 可见 | ❌ |
| 错误页点重试 | ✅ 可见 | ❌ | ❌ | reset + 重载 |

`showOnly(view)` 辅助函数实现「同一时刻仅一个视图可见」。

### 3. 文件变化

| 文件 | 动作 |
|------|------|
| `electron/main.ts` | 重写：移除 `createSplashWindow`；新增 `createView`、`showOnly` 助手；主窗口创建后挂三个 View |
| `electron/preload.ts` | 扩展：暴露 `electronAPI.retry()` 用于错误页按钮触发 IPC |
| `electron/splash.html` | 保留：作为 loadingView 内容 |
| `electron/retry.html` | **新增**：复用 splash.html 的样式，文案区为动态「正在重试 N/3…」 |
| `electron/error.html` | **修改**：移除 inline `<script>`，由 preload 暴露的 `electronAPI.retry()` 触发 IPC |
| `scripts/build-electron.js` | 扩展：复制 `retry.html` 到 `dist-electron/` |
| `docs/superpowers/specs/2026-08-19-electron-loadurl-wrapper-design.md` | 保留作为历史记录；本文档为后续架构 |

### 4. 组件

**A. `electron/main.ts`**

主要职责：

- 创建 mainWindow（`show: false`，sandbox: false 以支持 preload）
- 创建 4 个 WebContentsView（3 状态视图走 `createView`，URL 内容走 `createUrlView`）
- 监听 **contentView.webContents** 事件（不是默认 webContents）：
  - `did-finish-load` → 仅在 `loadFailed === false` 时 `showOnly(contentView)`（详见下文"关键实现细节"）
  - `did-fail-load` → `loadFailed = true` + 更新 retryView 文案 + `showOnly(retryView)` + `setTimeout(reload, 5000)` 中重置 `loadFailed`；达 max retries 时切 errorView
  - `will-navigate` → 拦截非 `http://localhost:5195/` 域名
  - `setWindowOpenHandler` → `https` 走 `shell.openExternal`，其他拒绝
- `ipcMain.on('retry:request')` → `retryCount = 0` + `loadFailed = false` + `showOnly(loadingView)` + `contentView.webContents.reload()`
- `mainWindow.on('resize')` → 同步 4 个 View 的 bounds
- **不调用 `mainWindow.loadURL()`**——URL 内容交给 contentView 承载

**关键实现细节（`loadFailed` 标志）**

URL 加载失败时，Electron 会用内置 ERR 页面（如 `ERR_CONNECTION_REFUSED`）响应，**这个 ERR 页面也会触发 `did-finish-load`**，且触发时机晚于 `did-fail-load`。如果直接监听 `did-finish-load` 切换到 contentView，会让 ERR 页面闪烁显示并错误覆盖 retry/error 视图。

解决：引入 `loadFailed` 布尔标志

- `did-fail-load` 触发时设为 `true`
- 重试前和用户点击重试前重置为 `false`
- `did-finish-load` 仅在 `loadFailed === false` 时切换到 contentView（且加载成功）

这一项是离线验证时发现的 bug（详见计划 Task 7），原计划未涵盖。

View 工厂 `createView(htmlFile)`：

```ts
function createView(htmlFile: string): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const [w, h] = mainWindow!.getContentSize();
  view.setBounds({ x: 0, y: 0, width: w, height: h });
  view.webContents.loadFile(path.join(__dirname, htmlFile));
  mainWindow!.contentView.addChildView(view);
  view.setVisible(false);
  return view;
}
```

**B. `electron/preload.ts`**

扩展暴露 `retry` 方法：

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: { /* ... */ },
  retry: () => ipcRenderer.send('retry:request'),
});
```

错误页只需 `<button onclick="window.electronAPI.retry()">重试</button>`，无需 inline script 块。

**C. `electron/splash.html`（loadingView 内容）**

- 保持现有 spinner + 文案布局
- 文案 `"正在连接到 AI 助手…"`
- CSP：`default-src 'self'; style-src 'self' 'unsafe-inline'`（无 inline script，无需 script-src）

**D. `electron/retry.html`（retryView 内容）**

- 复用 splash.html 的 spinner + 样式
- 文案初始为 `"正在重试 …"`，由主进程在 `did-fail-load` 中通过 `executeJavaScript` 改写
- 示例：`<div class="label">正在重试…</div>`

**E. `electron/error.html`（errorView 内容）**

- 标题 + 提示 + 「重试」按钮
- 按钮：`onclick="window.electronAPI.retry()"`（属性内联，**不**是 `<script>` 块）
- CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`
- 因为 IPC 走 preload，inline `<script>` 块彻底移除

### 5. 数据流

启动序列：

```
1. app.whenReady()
2. mainWindow = new BrowserWindow(show: false, ... note: 不调用 mainWindow.loadURL)
3. loadingView = createView('splash.html')     ← 隐藏
4. retryView   = createView('retry.html')      ← 隐藏
5. errorView   = createView('error.html')      ← 隐藏
6. contentView = createUrlView(TARGET_URL)     ← 隐藏，URL 内容开始加载
7. showOnly(loadingView)                       ← 仅 loadingView 可见
8. mainWindow.show()                           ← 立即显示窗口（带着 loadingView）
```

加载成功：

```
contentView.webContents.on('did-finish-load')
   └─ if loadFailed: return        ← 加载失败的 ERR 页面也触发此事件，必须忽略
   └─ showOnly(contentView)       ← 隐藏状态视图，显示 URL 内容
```

加载失败（重试）：

```
contentView.webContents.on('did-fail-load', (e, code, desc, url))
   └─ loadFailed = true
   └─ if retryCount < MAX_RETRIES:
        retryCount += 1
        retryView.webContents.executeJavaScript(
          `document.querySelector('.label').textContent = '正在重试 ${retryCount}/${MAX_RETRIES}…';`
        )
        showOnly(retryView)
        setTimeout(() => {
          loadFailed = false                        ← 重试前重置标志
          contentView.webContents.reload()
        }, 5000)
   └─ else:
        showOnly(errorView)
```

错误页点重试：

```
errorView: button click
   └─ window.electronAPI.retry()         ← preload 暴露
   └─ ipcRenderer.send('retry:request')  ← 经 contextBridge
─────────────────────────────────────────
mainWindow process:
   ipcMain.on('retry:request')
        └─ retryCount = 0
        └─ loadFailed = false           ← 用户主动重试，重置标志
        └─ showOnly(loadingView)
        └─ contentView.webContents.reload()
```

resize 同步：

```
mainWindow.on('resize')
   └─ for v in [loadingView, retryView, errorView, contentView]:
        v.setBounds({ x: 0, y: 0, width: W, height: H })
```

### 6. 错误处理与测试

| 场景 | 处理 |
|------|------|
| 目标 URL 不可达 | retryView 显示「正在重试 N/3…」，3 次后切 errorView |
| 后端服务 5xx | 由目标 URL 自身 UI 处理；contentView 收到 5xx 时 `did-finish-load` 仍触发，本设计将其视为成功 |
| 渲染进程崩溃 | `render-process-gone` 监听器记录日志，行为同当前实现 |
| retry.html / error.html 文件缺失 | esbuild 构建期拷贝失败 → dev 启动即报错，可立发现 |
| preload 加载失败 | 错误页「重试」按钮无效 → 退化到 inline script 兜底（不在本次范围） |
| macOS 标题栏拖拽 | 当前 splash 方案通过 BrowserWindow `titleBarStyle: hiddenInset` 实现，迁移后保持；若 loadingView 占据整个窗口，macOS 用户需在 titlebar 区域触发拖拽，验证通过 |
| URL 失败后 ERR 页面触发 `did-finish-load` | ERR 页面闪烁覆盖 retry/error 视图 | `loadFailed` 标志：did-fail-load 时设为 true，did-finish-load 仅在 false 时切换到 contentView |

**测试**：

- `npm run dev`：默认目标 URL 在 5195 启动时主窗口顺畅加载
- 离线启动（杀掉 5195）：retryView 显示「正在重试 1/3…」约 5s → 切到 2/3 → 3/3 → 切到 errorView → 点「重试」回到 loadingView
- macOS 打包：`npm run build:mac` 正常出包
- Windows 打包：`npm run build:win` 正常出包
- 多次重试后 `retryCount` 计数正确（不会卡在 1/3）
- 错误页 console 无 CSP 报错

## 范围

本设计**不**包含：

- 修改外部 URL 自身的 UI
- 后端服务（端口 5195）的部署或启动脚本
- 错误页除「重试」外的其他操作（提单、复制错误码等）
- 跨平台差异的特殊处理（macOS 标题栏、Windows 11 snap layout）—— 沿用当前 BrowserWindow 行为
- 合并 loadingView / retryView / errorView 为单一 View（已纳入后续可选）

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| WebContentsView API 在不同 Electron 版本行为差异 | 视图不显示 / 不响应 | 我们已锁定 Electron 43，文档明确；resize 同步写显式 listener |
| `did-finish-load` 在视图自身加载时也会触发 | 误切状态 | 监听器只挂在 contentView.webContents（URL 内容），其他 3 个 View 的 did-finish-load 与状态机无关 |
| preload 暴露的 `electronAPI.retry` 在 errorView 上下文不可用 | 按钮无反应 | 4 个 View 共用同一 preload（`sandbox: true` 下 preload 仍可 contextBridge 暴露 ipcRenderer） |
| View 重叠时鼠标事件命中 | 隐藏的 View 仍可能拦截 | `setVisible(false)` 在新版 Electron 中已正确隔离命中测试，无需额外 `setIgnoreMouseEvents` |
| URL 失败后 ERR 页面触发 `did-finish-load` | ERR 页面闪烁覆盖 retry/error 视图 | `loadFailed` 标志：did-fail-load 时设为 true，did-finish-load 仅在 false 时切换到 contentView；重试前/用户点击重试前重置 |
| contentView 与默认 webContents 行为差异 | 链接拦截、setWindowOpenHandler 位置错误 | 全部监听器挂到 contentView.webContents，不挂 mainWindow.webContents |
| CSP 反复修改 | 维护负担 | 本设计 error.html 只 reload 一次，IPC 通道固定；后续如需加能力，沿 contextBridge 扩展 |

## 验收标准

1. `npm run dev` 启动后，loadingView 显示「正在连接到 AI 助手…」，主窗口加载目标 URL，加载完成后 loadingView 消失，目标 URL 可见。
2. 5195 不可达时：retryView 显示「正在重试 1/3…」，约 5s 后切「2/3…」、「3/3…」，最终 errorView 显示。**全程不闪烁 ERR 页面或 contentView**。
3. 错误页点「重试」：跳转回 loadingView 开始新一轮 3 次重试。
4. 全程只看到一个主窗口，无第二个 BrowserWindow 出现。
5. error.html 浏览器控制台无 CSP 报错，无 inline script。
6. `npm run build:mac` / `npm run build:win` 正常出包。
7. 窗口 resize 时 4 个 View 同步缩放，无内容溢出或露白。

## 后续可选（不在本次范围）

- retryView 增加倒计时（5s 等待期显示「下次重试 X 秒…」）
- errorView 增加「打开诊断」按钮（导出 console 日志）
- retryView 与 loadingView 合并为单一 View，通过 `executeJavaScript` 切换文案
