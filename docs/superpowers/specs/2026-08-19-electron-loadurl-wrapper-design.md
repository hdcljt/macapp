# Electron 改造为 URL 包装器 — 设计文档

日期：2026-08-19
主题：将现有 Electron + React + Vite + TypeScript 桌面端改造为一个加载外部 URL `http://localhost:5195/agent-user/assistant` 的轻量包装器。

## 背景

现有项目（[README](../../README.md)）是一个 Electron + React + Vite 的桌面端应用，启动后打开一个由 React 自绘的 AI 助手首页（`TopBar`、`AIAppsCarousel`、`FeatureSection`、`BottomTabBar`、`InputBar` 等组件）。本次需求方提出：把前端替换为对外部 URL `http://localhost:5195/agent-user/assistant` 的直接加载。

附带要求：在外部 URL 加载完成前，需要一个加载动画。本设计确认这条需求可用纯 Electron 实现，不依赖 React/Tailwind/Vite。

## 目标

1. 应用启动后加载 `http://localhost:5195/agent-user/assistant`。
2. 加载期间显示加载动画（独立 splash 窗口）。
3. 外部 URL 加载成功后切换到主窗口。
4. 外部 URL 加载失败时给出友好提示并允许重试。
5. 清理不再使用的 React/Vite/Tailwind 代码与依赖，简化 dev / 构建流程。

## 设计

### 1. 架构

```
┌────────────────────────────────────────────────────────┐
│                Electron 主进程 (main.ts)                │
│                                                        │
│  app.whenReady()                                        │
│        │                                               │
│        ├─► 创建 splash 窗口（600×300，纯 HTML/CSS）     │
│        │       只渲染动画，不依赖任何打包产物            │
│        │                                               │
│        ├─► 创建 mainWindow（show: false）               │
│        │       loadURL("http://localhost:5195/agent-user/assistant")
│        │                                               │
│        └─► 监听 mainWindow 的 did-finish-load           │
│              ├─► 失败 → 保留 splash，弹出错误页          │
│              └─► 成功 → mainWindow.show() + splash.close() │
└────────────────────────────────────────────────────────┘
```

文件层面对应关系：

| 文件 | 动作 |
|------|------|
| `electron/main.ts` | 改写：拆分窗口创建 + loadURL + 事件分发 |
| `electron/preload.ts` | 改写：去掉渲染层 API（保留 platform/versions） |
| `electron/splash.html` | 新增：纯 HTML + CSS loading 动画 |
| `src/`（整目录） | 删除 |
| `index.html` | 删除 |
| `vite.config.ts` | 删除 |
| `scripts/build-electron.js` | 保留：仍编译 main.ts 与 preload.ts |
| `scripts/launch-electron.js` | 删除：`dev:vite` 阶段已被移除，不需要等待 5173 |
| `package.json`（dependencies） | 删除 react、react-dom |
| `package.json`（devDependencies） | 删除 vite、@vitejs/plugin-react、tailwind、@tailwindcss/*、autoprefixer、postcss、@types/react、@types/react-dom、concurrently、wait-on |
| `package.json`（scripts） | 删除 `dev:vite` / `build:renderer`；`dev` 简化为 `node scripts/build-electron.js && cross-env ELECTRON_RUN_AS_NODE=0 electron .` |
| `tsconfig.json` | 保留：仍要支持 electron/*.ts |
| `tsconfig.node.json` | 保留 |
| `src/vite-env.d.ts` | 删除（vite 关联） |
| `package.json`（build.files） | 移除 `dist/**/*`（不再依赖 vite 输出） |

### 2. 组件

**A. `electron/splash.html`**

- 纯静态文件，运行时由 Electron `loadFile` 加载，不依赖任何打包工具
- 内容：项目 logo SVG（取自 `build/icon.svg` 或简化内联）+ CSS keyframe 旋转 spinner + 文案（"正在连接到 AI 助手…"）
- 体积 < 5KB
- 加载完成后通过 IPC 通知主进程（详见 §3 数据流）

**B. `electron/main.ts`**

主要职责：

- 拆分 `createSplashWindow()` 与 `createMainWindow()`
- `createMainWindow()` 参数：`show: false`、`backgroundColor: '#FFFFFF'`、`webPreferences.contextIsolation: true`、`sandbox: true`
- `splashBrowserWindow` 与 `mainBrowserWindow` 共享主进程引用
- 监听目标事件：
  - `webContents.on('did-finish-load', …)`：成功加载
  - `webContents.on('did-fail-load', …)`：加载失败（区分网络错误、HTTP 错误等）
  - `webContents.on('render-process-gone', …)`：渲染进程崩溃
- 成功路径：`mainBrowserWindow.show(); splashBrowserWindow.close();`
- 失败路径：保留 splash，渲染错误页（带"重试"按钮），最多重试 3 次后切换到错误页
- 外部链接拦截：`setWindowOpenHandler` 对非 https 拒绝，对 https 调用 `shell.openExternal`
- 导航限制：`webContents.on('will-navigate', …)` 拦截非 `http://localhost:5195` 的导航

**C. `electron/preload.ts`**

- 删除窗口控制 API（已无渲染层调用方）
- 仅暴露 `{ platform, versions }`（备用扩展点）
- 如果确认不需要，`preload.ts` 整个可移除；`BrowserWindow.webPreferences.preload` 置空

### 3. 数据流

启动序列：

```
1. app.whenReady()
2. splashBrowserWindow = new BrowserWindow(...)  ← 立即显示
   └─ loadFile('electron/splash.html')
3. mainBrowserWindow = new BrowserWindow(show: false, ...)
   └─ loadURL('http://localhost:5195/agent-user/assistant')
4. mainBrowserWindow.webContents.on('did-finish-load', ...)
   ├─ 成功 → mainBrowserWindow.show() ; splashBrowserWindow.close()
   └─ 失败 → 等待 N 秒后 retry（最多 3 次） → 失败则切换错误页
```

后续运行：

- mainWindow 内的 navigation 不允许（避免用户被跳出 URL）；非目标 origin 一律拦截
- 跨域点击新窗口仍走 `setWindowOpenHandler` → 外部浏览器
- 应用退出：`window-all-closed`（macOS 不退出，其他平台退出）

### 4. 错误处理与测试

**错误处理**：

| 场景 | 处理 |
|------|------|
| 目标 URL 不可达 | splash 上显示"无法连接到助手服务，请检查后端是否启动"，提供"重试"按钮（重载主窗口） |
| 后端服务 5xx | 主窗口内由目标 URL 自己的 UI 展示，不在我们这边处理 |
| 主窗口崩溃（render-process-gone） | 提示用户重启应用，splash 显示"窗口已崩溃" |
| splash 文件缺失 | fallback：直接显示 mainWindow（`show: true`），不闪退 |
| 超过 3 次重试仍失败 | 切换到错误页，给出"打开诊断"按钮 |

**测试**：

- 构建脚本能跑通：`npm run build` 全流程（electron-builder 全部 target）
- 离线启动：杀掉后端后启动应用，应看到 splash 错误页（不直接闪退或卡空白）
- Windows 打包：图标、签名、文件关联正常
- macOS 首次启动：Gatekeeper 走"无法验证开发者"流程（参照已有 ad-hoc 签名配置）
- 主窗口 URL 加载成功后关闭 splash 的时延（目标 < 500ms）
- 反复重启主窗口（重试按钮）后不泄漏 BrowserWindow 句柄

## 范围

本设计**不**包含：

- 修改外部 URL 自身的 UI
- 后端服务（端口 5195）的部署或启动脚本
- 自动更新 / 自动重启后端
- 多账号 / 鉴权（若目标 URL 需要鉴权，由目标 URL 自己处理）

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 删除 React/Vite 后，依赖图可能遗漏 | 构建失败 | 跑 `npm run build` 全流程验收 |
| splash 与主窗口切换时白屏 | 用户体验差 | splash 保持到 `did-finish-load` 后再关闭 |
| 后端不在 localhost 时启动失败 | 用户看不到原因 | splash 显示明确错误提示 |
| 主窗口被允许跳出目标 URL 后再返回 | 不一致状态 | `will-navigate` 拦截 |

## 验收标准

1. `npm run dev` 启动后，splash 显示，主窗口加载 `http://localhost:5195/agent-user/assistant`，加载完成后切换到主窗口，splash 关闭。
2. 后端未启动时启动应用：显示错误页，可点击重试，重试 3 次后切换为最终错误提示。
3. `npm run build:mac` 与 `npm run build:win` 均能产出对应平台的安装包。
4. 当前前端代码（`src/`、`index.html`、`vite.config.ts`）已被删除，未在 `package.json` 中留下未使用依赖。
