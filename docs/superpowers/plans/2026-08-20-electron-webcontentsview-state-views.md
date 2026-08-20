# Electron 单窗口 + WebContentsView 状态视图 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前 splash BrowserWindow + mainWindow 的双窗口架构替换为「单 BrowserWindow 的 4 个 WebContentsView」架构：loadingView、retryView、errorView、contentView（URL 内容）共存于 mainWindow.contentView 内，按需切换可见性。

**Architecture:**

```
BrowserWindow (mainWindow)
└── contentView
    ├── loadingView (splash.html)    ← 初始加载
    ├── retryView  (retry.html)      ← 重试中（动态切文案）
    ├── errorView  (error.html)      ← 重试耗尽 + 重试按钮
    └── contentView (WebContentsView) ← http://localhost:5195/agent-user/assistant
```

URL 内容用专门的 WebContentsView 承载（而非默认 webContents），原因：默认 webContents 在 URL 加载/失败期间会显示空白或 ERR 页面穿透到背景，必须用 `loadFailed` 标志 + 专用 View 才能精确控制可见性。

所有状态 UI 都在主窗口内。错误页通过 preload + IPC 触发重试，不再依赖 inline `<script>`。

**Tech Stack:** Electron 43, TypeScript, esbuild（不变），HTML+CSS（不变）。

**Spec:** [../specs/2026-08-20-electron-webcontentsview-state-views-design.md](../specs/2026-08-20-electron-webcontentsview-state-views-design.md)

---

## Task 1: 添加 retry.html + 扩展 preload + build script

**Files:**
- Create: `electron/retry.html`
- Modify: `electron/preload.ts:1-12`
- Modify: `scripts/build-electron.js`

**Why first:** 纯增量改动，零行为变化。三个 View 都要用到 preload 与 build script，把 build 工具链先调到能识别 retry.html 的状态。

- [ ] **Step 1: 创建 `electron/retry.html`**

复用 splash.html 的样式骨架，仅把文案改为「正在重试…」：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
  <title>正在重试</title>
  <style>
    :root {
      --bg-start: #E8F4FF;
      --bg-mid: #F0E8FF;
      --bg-end: #FFE8F0;
      --accent: #6366f1;
      --accent-2: #ec4899;
      --text: #1a1a1a;
    }
    html, body {
      margin: 0;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
        "SF Pro Display", "Helvetica Neue", sans-serif;
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    body {
      background: linear-gradient(160deg,
        var(--bg-start) 0%, var(--bg-mid) 45%, var(--bg-end) 100%);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 18px;
    }
    .logo {
      font-size: 28px;
      font-weight: 600;
      letter-spacing: 0.5px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .spinner {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 3px solid rgba(99, 102, 241, 0.2);
      border-top-color: var(--accent);
      animation: spin 0.9s linear infinite;
    }
    .label {
      font-size: 13px;
      color: #555;
      letter-spacing: 0.4px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="logo">算粒 AI 助手</div>
  <div class="spinner" aria-hidden="true"></div>
  <div class="label">正在重试…</div>
</body>
</html>
```

- [ ] **Step 2: 扩展 `electron/preload.ts` 暴露 `retry()`**

```ts
import { contextBridge, ipcRenderer } from 'electron';

// 暴露给 splash / retry / error 页面的 API
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  retry: () => ipcRenderer.send('retry:request'),
});
```

- [ ] **Step 3: 修改 `scripts/build-electron.js` 复制 retry.html**

把 `staticFiles` 数组加上 `'retry.html'`：

```js
  // 复制静态资源（splash / retry / error 页面）到 dist-electron
  const staticFiles = ['splash.html', 'retry.html', 'error.html'];
```

- [ ] **Step 4: 编译验证**

Run: `node scripts/build-electron.js`
Expected: 日志含 `📄 复制 retry.html → dist-electron/`

Run: `ls -la dist-electron/retry.html`（Git Bash）
Expected: 文件存在

- [ ] **Step 5: 提交**

```bash
git add electron/retry.html electron/preload.ts scripts/build-electron.js
git commit -m "feat(electron): 新增 retry.html 与 preload.retry IPC

【需求/缺陷描述】: 为 WebContentsView 架构准备 retry 视图与 IPC 通道

【修改内容】:
- electron/retry.html 复用 splash.html 样式，文案"正在重试…"
- electron/preload.ts 新增 electronAPI.retry() 走 IPC retry:request
- scripts/build-electron.js 复制 retry.html 到 dist-electron

【需求/缺陷单号】: 无

MG"
```

---

## Task 2: 重构 error.html 通过 preload + IPC 触发重试

**Files:**
- Create: `electron/error.js`
- Modify: `electron/error.html`

**Why after Task 1:** error.html 的 fetch/retry 依赖 preload 暴露的 `electronAPI.retry()`。当前 error.html 用 inline `<script>`（CSP 不允许执行），改造为外部脚本文件 + preload IPC，彻底绕开 inline script 的 CSP 问题。

- [ ] **Step 1: 创建 `electron/error.js`**

```js
// 错误页按钮：调 preload 暴露的 retry() 通过 IPC 通知主进程
document.getElementById('retry').addEventListener('click', () => {
  window.electronAPI.retry();
});
```

- [ ] **Step 2: 重写 `electron/error.html`**

- 移除 `<script>` 块（被外部 `error.js` 替代）
- 添加 `<script src="error.js"></script>` 引用
- CSP 加 `script-src 'self'`，允许加载外部脚本
- `<button id="retry">` 保留

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'" />
  <title>无法连接</title>
  <style>
    :root {
      --bg-start: #FFF5F5;
      --bg-end: #FFE8E8;
      --accent: #dc2626;
      --text: #1a1a1a;
    }
    html, body {
      margin: 0;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
        "SF Pro Display", "Helvetica Neue", sans-serif;
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    body {
      background: linear-gradient(160deg, var(--bg-start), var(--bg-end));
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 24px;
      box-sizing: border-box;
    }
    .title {
      font-size: 18px;
      font-weight: 600;
      color: var(--accent);
    }
    .hint {
      font-size: 13px;
      color: #666;
      text-align: center;
      max-width: 360px;
      line-height: 1.6;
    }
    button {
      font-size: 14px;
      padding: 8px 24px;
      border: none;
      border-radius: 6px;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      font-family: inherit;
    }
    button:hover { opacity: 0.92; }
  </style>
</head>
<body>
  <div class="title">无法连接到助手服务</div>
  <div class="hint">
    请确认 <code>http://localhost:5195</code> 已启动后再试。
    如果问题持续存在，请联系技术支持。
  </div>
  <button id="retry">重试</button>
  <script src="error.js"></script>
</body>
</html>
```

- [ ] **Step 3: 修改 `scripts/build-electron.js` 复制 error.js**

`staticFiles` 数组加上 `'error.js'`：

```js
  const staticFiles = ['splash.html', 'retry.html', 'error.html', 'error.js'];
```

- [ ] **Step 4: 编译验证**

Run: `node scripts/build-electron.js`
Expected: 日志含 `📄 复制 error.js → dist-electron/`

Run: `ls -la dist-electron/error.js dist-electron/error.html`
Expected: 两个文件都存在

- [ ] **Step 5: 提交**

```bash
git add electron/error.html electron/error.js scripts/build-electron.js
git commit -m "fix(electron): error.html 重试通过 preload IPC 走主进程

【需求/缺陷描述】: 错误页 inline script 被 CSP 阻断，1e915de 改 unsafe-inline 被回退后按钮失效

【修改内容】:
- 拆分出 electron/error.js 外部脚本
- error.html CSP 改为 script-src 'self'，避免 unsafe-inline
- error.js 调 window.electronAPI.retry() 走 IPC retry:request
- build script 同步复制 error.js

【需求/缺陷单号】: 无

MG"
```

---

## Task 3: main.ts 重写为 WebContentsView 架构（4 View）

**Files:**
- Modify: `electron/main.ts` (whole file rewrite)

**Why last:** 集成 Task 1 + 2 的产出。移除 `createSplashWindow`；新增 `createView` / `createUrlView` 工厂与 `showOnly` 助手；主窗口创建后挂 4 个 View；事件 handler 改为 IPC + executeJavaScript 联动。

**关键架构决策**：URL 内容用专门的 WebContentsView（`contentView`）承载，而非默认 webContents。原因：默认 webContents 在 URL 加载失败时会显示 ERR 页面穿透到背景，必须用专用 View + `loadFailed` 标志（Task 7）才能精确控制可见性。

- [ ] **Step 1: 替换 `electron/main.ts`**

```ts
import { app, BrowserWindow, WebContentsView, ipcMain, shell } from 'electron';
import path from 'node:path';

// CJS 模式下 __dirname 是内置的；ESM 模式下需要用 import.meta.url
declare const __dirname: string;

const isDev = !app.isPackaged;
const TARGET_URL = 'http://localhost:5195/agent-user/assistant';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

let mainWindow: BrowserWindow | null = null;
let loadingView: WebContentsView | null = null;
let retryView: WebContentsView | null = null;
let errorView: WebContentsView | null = null;
let contentView: WebContentsView | null = null; // URL 内容用专用 View，避免默认 webContents 空白/ERR 页面穿透
let retryCount = 0;
let loadFailed = false; // 跟踪最近一次 URL 加载是否失败（详见 Task 7）

/** 同一时刻仅一个 View 可见；传入 null 表示隐藏全部 */
function showOnly(view: WebContentsView | null) {
  loadingView?.setVisible(view === loadingView);
  retryView?.setVisible(view === retryView);
  errorView?.setVisible(view === errorView);
  contentView?.setVisible(view === contentView);
}

/** 创建一个覆盖整个 mainWindow 的 WebContentsView，加载本地 HTML */
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

/** 创建一个覆盖整个 mainWindow 的 WebContentsView，加载外部 URL */
function createUrlView(url: string): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const [w, h] = mainWindow!.getContentSize();
  view.setBounds({ x: 0, y: 0, width: w, height: h });
  view.webContents.loadURL(url);
  mainWindow!.contentView.addChildView(view);
  view.setVisible(false);
  return view;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 700,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#FFFFFF',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // 不在默认 webContents 上 loadURL——URL 内容改用专用 contentView 承载
  // 创建四个 View：loading / retry / error / content(URL)
  loadingView = createView('splash.html');
  retryView = createView('retry.html');
  errorView = createView('error.html');
  contentView = createUrlView(TARGET_URL);
  showOnly(loadingView);

  // 立即显示窗口（带着 loadingView），让用户看到加载 UI
  mainWindow.show();

  // 监听 contentView 的加载事件（不是默认 webContents）
  contentView.webContents.on('did-finish-load', () => {
    if (loadFailed) {
      console.log('[loadURL] content view did-finish-load but load was marked as failed, ignoring');
      return;
    }
    console.log('[loadURL] content view did-finish-load, switching to contentView');
    showOnly(contentView);
  });

  contentView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    loadFailed = true;
    console.error(`[loadURL] ${errorCode} ${errorDescription} url=${validatedURL}`);
    if (retryCount < MAX_RETRIES) {
      retryCount += 1;
      console.warn(`[retry ${retryCount}/${MAX_RETRIES}]`);
      retryView?.webContents.executeJavaScript(
        `document.querySelector('.label').textContent = '正在重试 ${retryCount}/${MAX_RETRIES}…';`
      );
      showOnly(retryView);
      setTimeout(() => {
        loadFailed = false; // 重试前重置标志
        if (contentView && !contentView.webContents.isDestroyed()) {
          contentView.webContents.reload();
        }
      }, RETRY_DELAY_MS);
    } else {
      console.error(`[loadURL] gave up after ${MAX_RETRIES} retries, switching to error view`);
      showOnly(errorView);
    }
  });

  contentView.webContents.on('render-process-gone', (_event, details) => {
    console.error('[render-process-gone]', details);
  });

  contentView.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 拦截非目标 origin 的导航
  contentView.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost:5195/')) {
      event.preventDefault();
      console.warn(`[will-navigate blocked] ${url}`);
    }
  });

  // 错误页点「重试」→ IPC 回主进程
  ipcMain.on('retry:request', () => {
    console.log('[retry:request] user triggered retry from error view');
    retryCount = 0;
    loadFailed = false;
    showOnly(loadingView);
    if (contentView && !contentView.webContents.isDestroyed()) {
      contentView.webContents.reload();
    }
  });

  // resize 同步所有 4 个 View 的 bounds
  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [w, h] = mainWindow.getContentSize();
    for (const v of [loadingView, retryView, errorView, contentView]) {
      v?.setBounds({ x: 0, y: 0, width: w, height: h });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    loadingView = null;
    retryView = null;
    errorView = null;
    contentView = null;
  });

  if (isDev) {
    contentView.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

- [ ] **Step 2: 编译验证**

Run: `node scripts/build-electron.js`
Expected: `✅ Electron 编译完成`, 无 TS 错误

Run: `ls -la dist-electron/main.js`
Expected: 文件存在，modified time 新于 main.ts

- [ ] **Step 3: 提交**

```bash
git add electron/main.ts dist-electron/main.js dist-electron/main.js.map
git commit -m "refactor(electron): 改用四个 WebContentsView 替换 splash 窗口

【需求/缺陷描述】: 加载/重试/错误 UI 全部在主窗口内，去掉第二个 BrowserWindow

【修改内容】:
- 删除 createSplashWindow；新增 createView / createUrlView / showOnly 助手
- 主窗口挂 loadingView + retryView + errorView + contentView 四个 WebContentsView
- URL 内容用专用 contentView 承载（sandbox: false 允许导航）
- did-finish-load: 配合 loadFailed 标志判断（详见 Task 7）
- did-fail-load: executeJavaScript 改 retryView 文案 + 5s 后 reload contentView
- ipcMain.on('retry:request') 处理错误页按钮重试
- mainWindow.on('resize') 同步四个 View 的 bounds

【需求/缺陷单号】: 无

MG"
```

---

## Task 4: 验证 — dev 正常加载流程

**Files:**
- (no changes)

- [ ] **Step 1: 重新安装依赖**

Run: `npm install`
Expected: clean install, no errors

- [ ] **Step 2: 编译**

Run: `npm run build:electron`
Expected: `✅ Electron 编译完成`, 含 `复制 splash.html / retry.html / error.html / error.js`

- [ ] **Step 3: 启动 5195 后端**

任意 HTTP server 监听 5195 端口。例：

```bash
python -m http.server 5195
```

（接受 404；目标是验证 Electron 加载流程跑通。）

- [ ] **Step 4: 启动应用**

Run: `npm run dev`
Expected:
- 仅一个主窗口出现，看不到 splash 独立窗口
- loadingView 立即显示「正在连接到 AI 助手…」+ spinner
- 默认 webContents 加载完成后 loadingView 消失，目标 URL 可见
- 主窗口初次 resize 不影响内容布局

- [ ] **Step 5: 关闭应用**

关闭窗口或 Ctrl-C。

---

## Task 5: 验证 — 离线重试流程

**Files:**
- (no changes)

- [ ] **Step 1: 关闭 5195 后端**

（如果还在跑则停掉）

- [ ] **Step 2: 启动应用**

Run: `npm run dev`
Expected:
- 仅一个主窗口
- loadingView 显示约 5s 后切到 retryView「正在重试 1/3…」
- 约 5s 后切到「正在重试 2/3…」
- 约 5s 后切到「正在重试 3/3…」
- 约 5s 后切到 errorView「无法连接到助手服务」+ 重试按钮

- [ ] **Step 3: 启动 5195 后端，点击重试**

- 启动 Python server（或同等）
- 点击错误页「重试」
- Expected: 切回 loadingView；后端可达 → loadingView 消失 → 目标 URL 可见

- [ ] **Step 4: 验证 IPC 通道**

打开 DevTools（如果 isDev 自动开了），在 errorView 出现时检查 Console：
Expected: 无 CSP 违规警告，无「Refused to execute inline script」

- [ ] **Step 5: 提交（如需要）**

如果验证通过无需代码改动，跳过。

---

## Task 6: 验证 — 打包流程

**Files:**
- (no changes)

- [ ] **Step 1: macOS 打包**（如果当前在 macOS）

Run: `npm run build:mac`
Expected: electron-builder 完成, output 落在 `release/{version}/`

- [ ] **Step 2: Windows 打包**（如果当前在 Windows）

Run: `npm run build:win`
Expected: electron-builder 完成, output 落在 `release/{version}/`

- [ ] **Step 3: 验证产物含 retry.html + error.js**

Run（macOS）: `ls -la release/$(node -p "require('./package.json').version")/mac*/算粒AI助手*.app/Contents/Resources/app.asar.unpacked/ 2>/dev/null || ls -la release/$(node -p "require('./package.json').version")/mac*/*.app/Contents/Resources/`

Run（Windows）: `dir release\\$(node -p "require('./package.json').version")\\win-unpacked\\resources\\`

Expected: 列表含 `retry.html` 与 `error.js`

- [ ] **Step 4: 运行打包后的应用**

安装并启动产物。
Expected: 完整流程与 dev 一致（loadingView → content / retryView → errorView → 重试）。

---

## Task 7: 修复 did-finish-load 覆盖 retry/error 视图的 bug

**Files:**
- Modify: `electron/main.ts`

**Why:** Task 3 实施后做离线验证时发现 bug——URL 加载失败（ERR_CONNECTION_REFUSED）后，Electron 会用默认错误页响应，`did-finish-load` 会在 `did-fail-load` 之后触发，导致 `showOnly(contentView)` 错误地把 retry/error 视图切掉，用户看到 ERR 页面一闪而过。这个 bug 与 spec 中"5xx 仍触发 did-finish-load，视为成功"的说明冲突——实际上 ERR_ 页面也会触发 did-finish-load，必须显式区分。

**修复策略**：引入 `loadFailed` 布尔标志：
- `did-fail-load` 时设为 `true`
- 重试前/用户点击重试前重置为 `false`
- `did-finish-load` 仅在 `loadFailed === false` 时切换到 contentView

- [ ] **Step 1: 在 `electron/main.ts` 添加 `loadFailed` 标志**

在 `let retryCount = 0;` 下方添加：

```ts
let loadFailed = false; // tracking：最近一次 URL 加载是否失败，避免 did-finish-load 覆盖 retry/error 视图
```

- [ ] **Step 2: 修改 `did-finish-load` 监听器**

```ts
contentView.webContents.on('did-finish-load', () => {
  if (loadFailed) {
    console.log('[loadURL] content view did-finish-load but load was marked as failed, ignoring');
    return;
  }
  console.log('[loadURL] content view did-finish-load, switching to contentView');
  showOnly(contentView);
});
```

- [ ] **Step 3: 修改 `did-fail-load` 监听器**

```ts
contentView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
  loadFailed = true;
  console.error(`[loadURL] ${errorCode} ${errorDescription} url=${validatedURL}`);
  // ... 其余逻辑不变
  setTimeout(() => {
    loadFailed = false; // 重试前重置标志
    if (contentView && !contentView.webContents.isDestroyed()) {
      contentView.webContents.reload();
    }
  }, RETRY_DELAY_MS);
  // ...
});
```

- [ ] **Step 4: 修改 `ipcMain.on('retry:request')`**

```ts
ipcMain.on('retry:request', () => {
  console.log('[retry:request] user triggered retry from error view');
  retryCount = 0;
  loadFailed = false; // 用户主动重试，重置标志
  showOnly(loadingView);
  if (contentView && !contentView.webContents.isDestroyed()) {
    contentView.webContents.reload();
  }
});
```

- [ ] **Step 5: 离线验证**

确认 5195 端口无人服务：
```bash
netstat -ano | grep 5195 || echo "端口 5195 已释放"
```

Run: `npm run dev:electron`

Expected 控制台日志（30s 内）：
```
[loadURL] -102 ERR_CONNECTION_REFUSED url=http://localhost:5195/agent-user/assistant
[retry 1/3]
[loadURL] content view did-finish-load but load was marked as failed, ignoring
[loadURL] -102 ERR_CONNECTION_REFUSED
[retry 2/3]
[loadURL] content view did-finish-load but load was marked as failed, ignoring
[loadURL] -102 ERR_CONNECTION_REFUSED
[retry 3/3]
[loadURL] content view did-finish-load but load was marked as failed, ignoring
[loadURL] -102 ERR_CONNECTION_REFUSED
[loadURL] gave up after 3 retries, switching to error view
```

Expected 用户视觉：
- 启动瞬时看到 loadingView
- 5s → retryView 1/3
- 5s → retryView 2/3
- 5s → retryView 3/3
- 5s → errorView
- **全程不闪烁任何 ERR 页面或 contentView**

- [ ] **Step 6: 成功路径验证**

临时起一个返回 200 的 HTTP server（如 `python -m http.server 5195`），跑 Electron。
Expected: `[loadURL] content view did-finish-load, switching to contentView`，看到目标 URL 内容。

- [ ] **Step 7: 提交**

```bash
git add electron/main.ts dist-electron/main.js dist-electron/main.js.map
git commit -m "fix(electron): 用 loadFailed 标志防止 did-finish-load 覆盖 retry/error 视图

【需求/缺陷描述】: URL 失败后 ERR 页面会触发 did-finish-load，错误地切换到 contentView 让 retry/error 视图一闪而过

【修改内容】:
- main.ts 新增 loadFailed 标志
- did-fail-load 设置 loadFailed = true
- did-finish-load 仅在 loadFailed === false 时切换到 contentView
- 重试前（包括 ipcMain retry:request）重置 loadFailed = false

【需求/缺陷单号】: 无

MG"
```

---

## Self-Review Checklist

Before declaring the plan complete:

- [x] Spec coverage: 架构 → Task 3，状态机 → Task 3，组件 → Tasks 1-3，数据流 → Task 3，错误处理 → Tasks 1-3 + 5 + 7
- [x] No placeholders: 每个代码块完整，每个命令有预期输出
- [x] 命名一致: `TARGET_URL`, `MAX_RETRIES`, `RETRY_DELAY_MS`, `mainWindow`, `loadingView`, `retryView`, `errorView`, `contentView`, `retryCount`, `loadFailed`, `createView`, `createUrlView`, `showOnly` 跨任务一致
- [x] 没遗漏 spec 需求: 四视图（Tasks 1+3）、IPC 重试（Tasks 2+3）、CSP 修复（Task 2）、resize 同步（Task 3）、loadFailed 修复（Task 7）、验证（Tasks 4-6）

---

## Notes for Execution

- **顺序**: Task 1 → 2 → 3 必须按序执行（2 依赖 1 的 preload.retry；3 依赖 1+2 的产物）。Task 7 是 Task 3 实施后发现的 bug 修复，独立。Tasks 4-6 是验证，可单独重跑。
- **Commit 节奏**: 每个 Task 一个 commit。沿用项目「MG」commit 尾巴（commit 历史已显示）。
- **rollout 风险**: Task 3 重写 `main.ts` 是最大块改动。如果中间因架构失误导致 dev 启动异常，revert 该 commit 即可（Task 1+2 仍是有效增量）。
- **可观测性**: Task 3 保留 `console.error` / `console.warn` 输出 retry 状态与 `[retry:request]` 日志，便于本机验证时跟踪状态机。
- **如果 retryView 文案没更新**: 检查 `executeJavaScript` 时机——`did-fail-load` 触发时 retryView 的 webContents 已准备好（自从启动就被 addChildView），调用无 race condition。
- **如果 errorView 重试按钮无反应**: 检查 DevTools console — IPC 通道名必须是字符串字面量 `'retry:request'`（preload / ipcMain 一致）。
- **如果 ERR 页面闪烁**: 确认 `loadFailed` 标志逻辑（Task 7）——`did-finish-load` 触发前必须先有 `did-fail-load` 标记，否则会错误切换到 contentView。
- **contentView vs 默认 webContents**: 4 View 架构下 URL 内容用专用 WebContentsView，不用默认 webContents。原因：默认 webContents 在 URL 加载/失败期间会显示空白或 ERR 页面穿透到背景；用 View + showOnly 控制更精确。
